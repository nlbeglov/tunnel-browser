import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppMenuEntry, BrowserSettings, ImportResult, OpenMode, ReleaseHistory, Subscription, UiRect, WindowProfilesState } from '../shared/types';
import { BrowserData } from './browserData';
import { findServer, parseMany, serverKey, serverKeyOfLink } from './links';
import type { UaMetadata } from './pageGuard';
import { ProfileWindow, type AppContext } from './profileWindow';
import { Store } from './store';
import { fetchSubscription, validateSubscriptionUrl } from './subscription';
import { cleanUserAgent } from './tunnelSession';
import { startUpdateProxy } from './updateProxy';
import { APP_REPO, Updater, releaseHistory } from './updater';
import { freeColors } from './windowProfiles';
import { coreFileName, coreVersion, killStaleCores } from './xray';

declare const __SMOKE__: boolean;

const OS_DIR: Record<string, string> = { win32: 'win', darwin: 'mac', linux: 'linux' };
const isMac = process.platform === 'darwin';
const OPEN_MODES: OpenMode[] = ['current', 'new-tab', 'background'];

if (__SMOKE__ && process.env.TB_SMOKE_USERDATA) app.setPath('userData', process.env.TB_SMOKE_USERDATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback);
  // Behind a proxy Chromium still looked up the names of visited sites through this
  // computer's DNS, which shows them to the internet provider. No lookups at all: pages'
  // names are resolved by the VPN server, updates go through their own proxy (updateProxy.ts).
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND , EXCLUDE 127.0.0.1');
  // Shared workers outlive their pages, where the time zone cannot be replaced (pageGuard.ts).
  app.commandLine.appendSwitch('disable-blink-features', 'SharedWorker');
  // Speech synthesis lists this computer's voices, which give away its languages.
  app.commandLine.appendSwitch('disable-speech-api');
  if (process.platform === 'win32') app.setAppUserModelId('app.tunnelbrowser.desktop');
  void app.whenReady().then(main);
}

function coreDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'xray')
    : join(app.getAppPath(), 'resources', 'xray', `${OS_DIR[process.platform]}-${process.arch}`);
}

async function main() {
  const corePath = join(coreDir(), coreFileName());
  await killStaleCores(app.getPath('userData'));

  // The UI itself never talks to the network: it only loads local files.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) =>
    cb({ cancel: !/^(file|devtools|data|blob):/i.test(d.url) }),
  );
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  // Otherwise Chromium fetches spell-check dictionaries from Google for the UI.
  session.defaultSession.setSpellCheckerEnabled(false);

  // Errors from before any UI exists are kept and shown once one has loaded.
  const earlyErrors: string[] = [];
  let reportError: (message: string) => void = (message) => {
    earlyErrors.push(message);
  };
  const onStorageError = (message: string) => reportError(message);
  const store = new Store(onStorageError);
  await store.load();
  const browser = new BrowserData(onStorageError);
  await browser.load((id) => store.profile(id ?? store.selectedId)?.link, serverKeyOfLink);

  // ---- windows: one per window profile
  const uiUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString();
  const windows: ProfileWindow[] = [];
  const opening = new Map<string, Promise<ProfileWindow>>();
  let lastFocused: ProfileWindow | null = null;
  let quitting = false;
  let resolveMetadata!: (m: UaMetadata | null) => void;
  let metadataRead = false;

  const byWindow = (bw: BrowserWindow | null | undefined) => windows.find((w) => w.win === bw);
  const bySender = (wc: WebContents) => windows.find((w) => w.win.webContents === wc);
  const focused = () => byWindow(BrowserWindow.getFocusedWindow()) ?? lastFocused ?? windows[0];
  const rememberOpen = () => {
    if (!quitting) browser.openProfiles = windows.map((w) => w.profileId);
  };

  const ctx: AppContext = {
    corePath,
    uiUrl,
    store,
    browser,
    uaMetadata: new Promise((r) => (resolveMetadata = r)),
    // Client hints exactly as this browser reports them, for pages whose language is replaced.
    readUaMetadata: (win) => {
      if (metadataRead) return;
      metadataRead = true;
      void readUaMetadata(win).then(resolveMetadata);
    },
    profilesChanged: () => broadcastProfiles(),
    opened: (w) => {
      windows.push(w);
      w.win.on('focus', () => (lastFocused = w));
      rememberOpen();
    },
    closed: (w) => {
      windows.splice(windows.indexOf(w), 1);
      if (lastFocused === w) lastFocused = null;
      rememberOpen();
      broadcastProfiles();
    },
    quitting: () => quitting,
  };

  /** Opens a window of the profile, or brings its window to the front: one window each. */
  function openWindow(profileId: string, near?: BrowserWindow): Promise<ProfileWindow> {
    const existing = windows.find((w) => w.profileId === profileId);
    if (existing) {
      existing.focus();
      return Promise.resolve(existing);
    }
    const pending = opening.get(profileId);
    if (pending) return pending;
    const p = ProfileWindow.open(profileId, ctx, near).finally(() => opening.delete(profileId));
    opening.set(profileId, p);
    return p.then((w) => {
      for (const m of earlyErrors.splice(0)) w.send('ui:error', m);
      broadcastProfiles();
      return w;
    });
  }

  function profilesState(w: ProfileWindow): WindowProfilesState {
    const servers = store.state().profiles;
    return {
      current: w.profileId,
      freeColors: freeColors(browser.profiles()),
      profiles: browser.profiles().map((p) => {
        const open = windows.find((x) => x.profileId === p.id);
        const st = open?.tunnel.state;
        const live = st && (st.status === 'connected' || st.status === 'degraded') ? st.exit : undefined;
        const server = findServer(servers, p.serverKey);
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          open: !!open,
          current: p.id === w.profileId,
          serverName: server?.name ?? p.serverName,
          serverMissing: !!p.serverKey && !server,
          exit: live
            ? { ip: live.ip, country: live.country, live: true }
            : p.lastExitIp
              ? { ip: p.lastExitIp, country: p.lastExitCountry, live: false }
              : undefined,
        };
      }),
    };
  }

  function broadcastProfiles() {
    for (const w of windows) w.send('windows:changed', profilesState(w));
  }

  const updater = new Updater(async () => {
    await Promise.all(windows.map((w) => w.tunnel.disconnect()));
  });
  updater.on('change', (s) => windows.forEach((w) => w.send('updates:changed', s)));
  store.on('change', () => {
    // A subscription refresh may have changed a profile's server details (or its name): the
    // profile keeps up with them, so its key matches exactly again.
    const servers = store.state().profiles;
    for (const p of browser.profiles()) {
      const s = findServer(servers, p.serverKey);
      if (s && (serverKey(s) !== p.serverKey || s.name !== p.serverName)) browser.setServer(p.id, { key: serverKey(s), name: s.name });
    }
    for (const w of windows) {
      w.send('profiles:changed', w.serversState());
      w.refreshPanel();
    }
    broadcastProfiles();
  });
  browser.on('bookmarks', (profileId, st) => {
    const w = windows.find((x) => x.profileId === profileId);
    w?.send('bookmarks:changed', st);
    w?.refreshPanel();
  });
  browser.on('settings', (st) => {
    windows.forEach((w) => w.send('settings:changed', st));
    const item = Menu.getApplicationMenu()?.getMenuItemById('bookmarks-bar');
    if (item) item.checked = st.showBookmarksBar;
  });
  browser.on('profiles', () => {
    windows.forEach((w) => w.refresh());
    broadcastProfiles();
  });

  // ---- IPC: only our own UI pages may call in; each call acts on the caller's window
  const trusted = (e: IpcMainInvokeEvent | IpcMainEvent) => {
    const w = bySender(e.sender);
    return w && e.senderFrame?.url === uiUrl ? w : undefined;
  };
  const handle = (channel: string, fn: (w: ProfileWindow, ...args: any[]) => unknown) =>
    ipcMain.handle(channel, (e, ...args) => {
      const w = trusted(e);
      if (!w) throw new Error('forbidden');
      return fn(w, ...args);
    });
  const on = (channel: string, fn: (w: ProfileWindow, ...args: any[]) => void) =>
    ipcMain.on(channel, (e, ...args) => {
      const w = trusted(e);
      if (w) fn(w, ...args);
    });
  const str = (v: unknown, max = 100_000): string => {
    if (typeof v !== 'string' || v.length > max) throw new Error('bad argument');
    return v;
  };
  const int = (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error('bad argument');
    return v;
  };
  const mode = (v: unknown): OpenMode => {
    if (!OPEN_MODES.includes(v as OpenMode)) throw new Error('bad argument');
    return v as OpenMode;
  };
  const hex = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim());

  // ---- servers (shared list; each window picks its own)
  handle('profiles:get', (w) => w.serversState());
  handle('profiles:import', (_w, text: unknown): ImportResult => {
    const { profiles, errors } = parseMany(str(text, 2_000_000));
    const added = store.addProfiles(profiles);
    return { added, errors };
  });
  handle('profiles:remove', async (_w, id: unknown) => {
    await Promise.all(windows.filter((x) => x.tunnel.state.profileId === str(id)).map((x) => x.tunnel.disconnect()));
    store.removeProfile(str(id));
  });
  handle('profiles:select', (w, id: unknown) => w.selectServer(str(id)));

  const userAgent = `TunnelBrowser/${app.getVersion()}`;
  async function loadSubscription(sub: Subscription): Promise<ImportResult> {
    const fetched = await fetchSubscription(sub.url, userAgent);
    const { profiles, errors } = parseMany(fetched.body);
    if (!profiles.length) throw new Error(errors[0] ?? 'в подписке нет серверов');
    const updated: Subscription = {
      ...sub,
      title: fetched.title || sub.title,
      usage: fetched.usage,
      updateIntervalHours: fetched.updateIntervalHours,
      updatedAt: Date.now(),
      lastError: undefined,
    };
    store.upsertSubscription(updated, profiles);
    return { added: profiles.length, errors };
  }
  handle('subs:add', async (_w, raw: unknown) => {
    const url = validateSubscriptionUrl(str(raw, 4000));
    const existing = store.state().subscriptions.find((s) => s.url === url.toString());
    const sub: Subscription = existing ?? { id: randomUUID(), url: url.toString(), title: url.hostname, updatedAt: 0 };
    return loadSubscription(sub);
  });
  handle('subs:refresh', async (_w, id: unknown) => {
    const sub = store.subscription(str(id));
    if (!sub) throw new Error('подписка не найдена');
    try {
      return await loadSubscription(sub);
    } catch (e) {
      store.setSubscriptionError(sub.id, e instanceof Error ? e.message : String(e));
      throw e;
    }
  });
  handle('subs:remove', async (_w, id: unknown) => {
    const using = windows.filter((x) => store.profile(x.tunnel.state.profileId)?.subscriptionId === str(id));
    await Promise.all(using.map((x) => x.tunnel.disconnect()));
    store.removeSubscription(str(id));
  });

  // ---- this window's tunnel
  handle('tunnel:get', (w) => w.tunnel.state);
  handle('tunnel:connect', (w, id: unknown) => w.connect(id === undefined ? undefined : str(id)));
  handle('tunnel:disconnect', (w) => w.tunnel.disconnect());
  handle('tunnel:measure', (w) => w.tunnel.measureLatency());

  // ---- this window's tabs
  handle('tabs:get', (w) => w.tabs.state());
  handle('tabs:create', (w, input: unknown) => w.tabs.create(input === undefined ? undefined : str(input, 8000)));
  handle('tabs:close', (w, id: unknown) => w.tabs.close(int(id)));
  handle('tabs:activate', (w, id: unknown) => w.tabs.activate(int(id)));
  handle('tabs:navigate', (w, id: unknown, input: unknown) => w.tabs.navigate(int(id), str(input, 8000)));
  handle('tabs:back', (w, id: unknown) => w.tabs.withTab(int(id), (wc) => wc.navigationHistory.goBack()));
  handle('tabs:forward', (w, id: unknown) => w.tabs.withTab(int(id), (wc) => wc.navigationHistory.goForward()));
  handle('tabs:reload', (w, id: unknown) => w.tabs.reload(int(id)));
  handle('tabs:stop', (w, id: unknown) => w.tabs.withTab(int(id), (wc) => wc.stop()));
  handle('tabs:move', (w, id: unknown, to: unknown) => w.tabs.move(int(id), int(to)));
  handle('tabs:context-menu', (w, id: unknown) => w.tabMenu(int(id)));
  handle('tabs:reopen-closed', (w) => w.tabs.reopenClosed());
  on('tabs:bounds', (w, r: UiRect) => {
    if (!r || typeof r !== 'object') return;
    w.tabs.setBounds({ x: Number(r.x) || 0, y: Number(r.y) || 0, width: Number(r.width) || 0, height: Number(r.height) || 0 });
  });
  on('tabs:settings-tab', (w, state: unknown) => w.tabs.setSettingsTab(state === 'active' || state === 'open' ? state : 'closed'));
  on('ui:titlebar-colors', (w, c: unknown) => {
    const { color, symbolColor } = (c ?? {}) as { color?: unknown; symbolColor?: unknown };
    if (hex(color) && hex(symbolColor)) w.setTitleBarColors(String(color).trim(), String(symbolColor).trim());
  });
  on('ui:taskbar-badge', (w, png: unknown, description: unknown) => {
    if (png === null) return w.setTaskbarBadge(null, '');
    if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,') || png.length > 200_000) return;
    w.setTaskbarBadge(png, typeof description === 'string' ? description : '');
  });

  // ---- this window's bookmarks (each profile has its own)
  handle('bookmarks:get', (w) => browser.bookmarksState(w.profileId));
  handle('bookmarks:add', (w, url: unknown, title: unknown) => {
    const u = str(url, 8000);
    return browser.addBookmark(w.profileId, u, str(title, 1000), w.tabs.state().tabs.find((t) => t.url === u)?.icon);
  });
  handle('bookmarks:remove', (w, id: unknown) => browser.removeBookmark(w.profileId, str(id, 100)));
  handle('bookmarks:update', (w, id: unknown, patch: unknown) => {
    const p = (patch ?? {}) as { title?: unknown; url?: unknown };
    browser.updateBookmark(w.profileId, str(id, 100), {
      title: p.title === undefined ? undefined : str(p.title, 1000),
      url: p.url === undefined ? undefined : str(p.url, 8000),
    });
  });
  handle('bookmarks:move', (w, id: unknown, to: unknown) => browser.moveBookmark(w.profileId, str(id, 100), int(to)));
  handle('bookmarks:open', (w, id: unknown, how: unknown) => w.openBookmark(str(id, 100), mode(how)));
  handle('bookmarks:context-menu', (w, id: unknown) => w.bookmarkMenu(str(id, 100)));
  handle('bookmarks:overflow-menu', (w, ids: unknown) => {
    if (!Array.isArray(ids)) throw new Error('bad argument');
    w.bookmarkOverflowMenu(ids.map((id) => str(id, 100)));
  });

  // ---- window profiles
  handle('windows:get', (w) => profilesState(w));
  handle('windows:open', async (w, id: unknown) => {
    browser.profile(str(id, 100));
    await openWindow(str(id, 100), w.win);
  });
  handle('windows:create', async (w, input: unknown) => {
    const i = (input ?? {}) as { name?: unknown; color?: unknown; serverId?: unknown };
    const server = typeof i.serverId === 'string' ? store.profile(i.serverId) : undefined;
    const p = browser.createProfile({ name: i.name, color: i.color, server: server ? { key: serverKey(server), name: server.name } : undefined });
    await openWindow(p.id, w.win);
  });
  handle('windows:update', (_w, id: unknown, patch: unknown) => {
    const p = (patch ?? {}) as { name?: unknown; color?: unknown };
    browser.updateProfile(str(id, 100), { name: p.name, color: p.color });
  });
  handle('windows:remove', async (w, id: unknown) => {
    const p = browser.profile(str(id, 100));
    if (windows.some((x) => x.profileId === p.id)) throw new Error('сначала закройте окно этого профиля');
    const r = await dialog.showMessageBox(w.win, {
      type: 'warning',
      buttons: ['Удалить профиль', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: `Удалить профиль «${p.name}»?`,
      detail: 'Его куки, входы на сайты, закладки и вкладки будут удалены с этого компьютера. Серверы останутся.',
    });
    if (r.response !== 0) return;
    const ses = session.fromPartition(p.partition);
    await ses.clearStorageData().catch(() => {});
    await ses.clearCache().catch(() => {});
    browser.removeProfile(p.id);
  });

  // ---- updates and app
  handle('updates:get', () => updater.state);
  handle('updates:check', () => updater.check());
  handle('updates:install', () => updater.install());

  // The ⋮ button: a menu first, settings are its last item (drawn by appMenu.ts).
  handle('app:main-menu', (w, right: unknown, top: unknown) => {
    const st = profilesState(w);
    const update = updater.state;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
    const key = (k: string) => (isMac ? `⌘${k}` : `Ctrl+${k}`);
    const items: AppMenuEntry[] = [
      { id: 'new-tab', label: 'Новая вкладка', accel: key('T') },
      {
        id: 'new-window',
        label: 'Новое окно',
        sub: [
          ...st.profiles.map((p) => ({
            id: `profile:${p.id}`,
            label: p.name,
            color: p.color,
            country: p.exit?.country,
            note: p.current ? 'это окно' : p.open ? 'открыто' : undefined,
            disabled: p.current,
          })),
          'separator',
          { id: 'new-profile', label: 'Новый профиль…', accel: key('N') },
        ],
      },
      'separator',
      ...(update.status === 'available' ? [{ id: 'update', label: `Обновить до версии ${update.version}` }, 'separator' as const] : []),
      { id: 'settings', label: 'Настройки' },
    ];
    return w.showMenu({ right: num(right), top: num(top) }, items, (id) => {
      if (id === 'new-tab') w.tabs.create();
      else if (id === 'new-profile') w.openPanel('profiles');
      else if (id === 'settings') w.openPanel('settings');
      else if (id === 'update') void updater.install();
      else if (id.startsWith('profile:')) void openWindow(id.slice('profile:'.length), w.win);
    });
  });
  // The version history loads only when asked (the buttons in Settings › About) and is kept
  // in a file, so it is there after a restart without a request.
  const historyFile = join(app.getPath('userData'), 'releases.json');
  let history: ReleaseHistory | null | undefined;
  handle('updates:history', async () => {
    if (history === undefined) history = await readFile(historyFile, 'utf8').then((t) => JSON.parse(t) as ReleaseHistory, () => null);
    return history;
  });
  handle('updates:refresh-history', async () => {
    history = { entries: await releaseHistory(), at: Date.now() };
    await writeFile(historyFile, JSON.stringify(history)).catch(() => {});
    return history;
  });

  const xrayVersion = coreVersion(corePath);
  handle('app:panel', (w, kind: unknown, right: unknown, top: unknown, editId: unknown) => {
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
    if (kind !== 'connection' && kind !== 'bookmarks') return;
    return w.showPanel(kind, { right: num(right), top: num(top) }, typeof editId === 'string' ? editId.slice(0, 100) : undefined);
  });
  handle('app:info', async () => ({
    version: app.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    xrayVersion: await xrayVersion,
    repo: APP_REPO,
  }));
  handle('app:clear-data', (w) => w.forgetSites());
  handle('app:settings', () => browser.settings());
  handle('app:set-settings', (_w, patch: unknown) => browser.setSettings((patch ?? {}) as Partial<BrowserSettings>));

  buildMenu(focused, {
    newWindow: () => focused()?.openPanel('profiles'),
    toggleBar: (on) => browser.setSettings({ showBookmarksBar: on }),
    barShown: browser.settings().showBookmarksBar,
  });

  // ---- start: the windows that were open last time
  const toOpen = browser.openProfiles.length ? browser.openProfiles : [browser.profiles()[0].id];
  let prev: BrowserWindow | undefined;
  for (const id of toOpen) prev = (await openWindow(id, prev)).win;
  reportError = (message: string) => (focused() ? focused()!.send('ui:error', message) : earlyErrors.push(message));
  for (const m of earlyErrors.splice(0)) reportError(m);

  if (app.isPackaged) await routeUpdatesToGitHub();
  updater.start();

  // Refresh subscriptions that are due, in the background.
  for (const sub of store.state().subscriptions) {
    const hours = sub.updateIntervalHours ?? 12;
    if (Date.now() - sub.updatedAt > hours * 3600_000) {
      loadSubscription(sub).catch((e) => {
        store.setSubscriptionError(sub.id, e instanceof Error ? e.message : String(e));
      });
    }
  }

  // Quit: stop every core at once, then give the encrypted files a moment to be written.
  let readyToQuit = false;
  app.on('before-quit', (e) => {
    if (readyToQuit) return;
    e.preventDefault();
    if (quitting) return;
    browser.openProfiles = windows.map((w) => w.profileId);
    quitting = true;
    updater.stop();
    for (const w of windows) {
      w.tunnel.killNow();
      w.saveSession();
    }
    const done = Promise.all([browser.flush(), store.flush()]);
    void Promise.race([done, new Promise((r) => setTimeout(r, 2000))]).finally(() => {
      readyToQuit = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => app.quit());
  app.on('second-instance', () => focused()?.focus());
  process.on('exit', () => windows.forEach((w) => w.tunnel.killNow()));

  const first = windows[0];
  if (isMac && app.isPackaged && first && !app.isInApplicationsFolder() && !browser.declinedMoveToApplications) {
    void offerMoveToApplications(first.win, browser);
  }

  if (__SMOKE__ && process.env.TB_SMOKE && first) {
    const { runSmoke } = await import('./smoke');
    await runSmoke({ win: first.win, gate: first.gate, tunnel: first.tunnel, tabs: first.tabs, store, browser, profileId: first.profileId });
  }
}

/**
 * electron-updater's own session (its NET_SESSION_NAME) goes straight to GitHub through
 * updateProxy.ts. Chromium applies a new proxy with a delay, so wait until it reports it;
 * before that, a check would go DIRECT and fail (DNS is off), not leak.
 */
async function routeUpdatesToGitHub(): Promise<void> {
  const updates = await startUpdateProxy();
  const ses = session.fromPartition('electron-updater', { cache: false });
  const want = `PROXY 127.0.0.1:${updates.port}`;
  await ses.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${updates.port}` });
  for (let i = 0; i < 40; i++) {
    if ((await ses.resolveProxy('https://github.com/')).trim() === want) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** navigator.userAgentData of this browser, read in the UI page (a secure context). */
async function readUaMetadata(win: BrowserWindow): Promise<UaMetadata | null> {
  try {
    return await win.webContents.executeJavaScript(`navigator.userAgentData
      .getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64'])
      .then((v) => ({ brands: v.brands, fullVersionList: v.fullVersionList, platform: v.platform,
        platformVersion: v.platformVersion, architecture: v.architecture, model: v.model, mobile: v.mobile,
        bitness: v.bitness, wow64: v.wow64 }))`);
  } catch {
    return null;
  }
}

/** Updates replace the app in place, which needs a writable, non-translocated location. */
async function offerMoveToApplications(win: BrowserWindow, browser: BrowserData) {
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Переместить', 'Не сейчас'],
    defaultId: 0,
    cancelId: 1,
    message: 'Переместить Tunnel Browser в папку «Программы»?',
    detail: 'Обновление одной кнопкой работает, только когда приложение лежит в «Программах».',
    checkboxLabel: 'Больше не спрашивать',
  });
  if (r.response === 0) {
    try {
      app.moveToApplicationsFolder({ conflictHandler: () => true });
    } catch (e) {
      dialog.showErrorBox('Не удалось переместить', e instanceof Error ? e.message : String(e));
    }
  } else if (r.checkboxChecked) {
    browser.declinedMoveToApplications = true;
  }
}

interface MenuHooks {
  newWindow: () => void;
  toggleBar: (on: boolean) => void;
  barShown: boolean;
}

/** One menu for the app; every command acts on the window in front. */
function buildMenu(focused: () => ProfileWindow | undefined, hooks: MenuHooks) {
  const withWin = (fn: (w: ProfileWindow) => void) => () => {
    const w = focused();
    if (w && !w.win.isDestroyed()) fn(w);
  };
  /** A command for the page in front; none while the settings tab is the active one. */
  const activeTab = (fn: (w: ProfileWindow, id: number) => void) =>
    withWin((w) => {
      const id = w.tabs.state().activeId;
      if (id !== null && w.tabs.settings !== 'active') fn(w, id);
    });
  // The settings tab lives in the UI: it closes itself and takes part in Ctrl+Tab there.
  const closeTab = withWin((w) => {
    const id = w.tabs.state().activeId;
    if (w.tabs.settings === 'active') w.send('ui:settings-tab', 'close');
    else if (id !== null) w.tabs.close(id);
  });
  const cycle = (step: 1 | -1) =>
    withWin((w) => (w.tabs.settings === 'closed' ? w.tabs.cycle(step) : w.send('ui:settings-tab', step > 0 ? 'next' : 'prev')));
  const zoom = (delta: number | null) =>
    withWin((w) => {
      const wc = w.tabs.active;
      if (wc) wc.setZoomLevel(delta === null ? 0 : wc.getZoomLevel() + delta);
    });
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Файл',
      submenu: [
        { label: 'Новая вкладка', accelerator: 'CmdOrCtrl+T', click: withWin((w) => w.tabs.create()) },
        { label: 'Новое окно…', accelerator: 'CmdOrCtrl+N', click: hooks.newWindow },
        { label: 'Открыть закрытую вкладку', accelerator: 'CmdOrCtrl+Shift+T', click: withWin((w) => w.tabs.reopenClosed()) },
        { label: 'Закрыть вкладку', accelerator: 'CmdOrCtrl+W', click: closeTab },
        { label: 'Адресная строка', accelerator: 'CmdOrCtrl+L', click: withWin((w) => w.send('ui:focus-address')) },
        { type: 'separator' },
        { label: 'Закрыть окно', accelerator: 'CmdOrCtrl+Shift+W', click: withWin((w) => w.win.close()) },
        ...(isMac ? [] : [{ role: 'quit' as const, label: 'Выход' }]),
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Перезагрузить страницу', accelerator: 'CmdOrCtrl+R', click: activeTab((w, id) => w.tabs.reload(id)) },
        { label: 'Перезагрузить (F5)', accelerator: 'F5', visible: false, click: activeTab((w, id) => w.tabs.reload(id)) },
        { label: 'Назад', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: withWin((w) => w.tabs.active?.navigationHistory.goBack()) },
        { label: 'Вперёд', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: withWin((w) => w.tabs.active?.navigationHistory.goForward()) },
        { label: 'Следующая вкладка', accelerator: 'Ctrl+Tab', click: cycle(1) },
        { label: 'Предыдущая вкладка', accelerator: 'Ctrl+Shift+Tab', click: cycle(-1) },
        { type: 'separator' },
        { label: 'Увеличить', accelerator: 'CmdOrCtrl+=', click: zoom(0.5) },
        { label: 'Уменьшить', accelerator: 'CmdOrCtrl+-', click: zoom(-0.5) },
        { label: 'Обычный масштаб', accelerator: 'CmdOrCtrl+0', click: zoom(null) },
        { type: 'separator' },
        {
          label: 'Инструменты разработчика страницы',
          accelerator: isMac ? 'Cmd+Alt+I' : 'F12',
          click: withWin((w) => w.tabs.active?.openDevTools({ mode: 'detach' })),
        },
        ...(!app.isPackaged
          ? [
              {
                label: 'Инструменты разработчика интерфейса',
                accelerator: 'CmdOrCtrl+Shift+I',
                click: withWin((w) => w.win.webContents.openDevTools({ mode: 'detach' })),
              },
            ]
          : []),
        { role: 'togglefullscreen', label: 'Полный экран' },
      ],
    },
    {
      label: 'Закладки',
      submenu: [
        { label: 'Добавить страницу в закладки', accelerator: 'CmdOrCtrl+D', click: withWin((w) => w.bookmarkActivePage()) },
        { label: 'Все закладки', accelerator: 'CmdOrCtrl+Alt+B', click: withWin((w) => w.openPanel('bookmarks')) },
        {
          id: 'bookmarks-bar',
          label: 'Показывать панель закладок',
          type: 'checkbox',
          checked: hooks.barShown,
          accelerator: 'CmdOrCtrl+Shift+B',
          click: (item) => hooks.toggleBar(item.checked),
        },
      ],
    },
    ...(isMac ? [{ role: 'windowMenu' as const, label: 'Окно' }] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

