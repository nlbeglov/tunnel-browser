import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserSettings, ImportResult, OpenMode, PanelName, Subscription, TunnelState, UiRect } from '../shared/types';
import { BrowserData } from './browserData';
import { parseMany } from './links';
import { Store } from './store';
import { fetchSubscription, validateSubscriptionUrl } from './subscription';
import { Tabs } from './tabs';
import { Tunnel } from './tunnel';
import { TunnelSession, cleanUserAgent, hardenWebContents } from './tunnelSession';
import { APP_REPO, Updater, releaseHistory } from './updater';
import { coreFileName, coreVersion, killStaleCore } from './xray';

declare const __SMOKE__: boolean;

const OS_DIR: Record<string, string> = { win32: 'win', darwin: 'mac', linux: 'linux' };
const isMac = process.platform === 'darwin';
const OPEN_MODES: OpenMode[] = ['current', 'new-tab', 'background'];

if (__SMOKE__ && process.env.TB_SMOKE_USERDATA) app.setPath('userData', process.env.TB_SMOKE_USERDATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback);
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
  const pidFile = join(app.getPath('userData'), 'core.pid');
  await killStaleCore(pidFile);

  // The UI itself never talks to the network: it only loads local files.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) =>
    cb({ cancel: !/^(file|devtools|data|blob):/i.test(d.url) }),
  );
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));

  const gate = new TunnelSession();
  await gate.init();
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
    if (wc.session === gate.ses) hardenWebContents(wc);
  });

  // Errors from before the UI exists are kept and shown once it has loaded.
  const earlyErrors: string[] = [];
  let reportError: (message: string) => void = (message) => {
    earlyErrors.push(message);
  };
  const onStorageError = (message: string) => reportError(message);
  const store = new Store(onStorageError);
  const browser = new BrowserData(onStorageError);
  await Promise.all([store.load(), browser.load()]);
  const tunnel = new Tunnel(gate, corePath, pidFile);
  const updater = new Updater(() => tunnel.disconnect());

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 500,
    show: false,
    title: 'Tunnel Browser',
    backgroundColor: '#15171c',
    autoHideMenuBar: true,
    // macOS: Chrome-style window, the tab strip sits next to the traffic lights.
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  const uiUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString();
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.show());

  const tabs = new Tabs(win, gate.ses);
  const send = (channel: string, ...payload: unknown[]) => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...payload);
  };
  const openPanel = (panel: PanelName, bookmarkId?: string) => send('ui:open-panel', panel, bookmarkId);
  win.on('enter-full-screen', () => send('ui:fullscreen', true));
  win.on('leave-full-screen', () => send('ui:fullscreen', false));

  // Remember open tabs (debounced) so the next start can bring them back.
  let sessionTimer: NodeJS.Timeout | null = null;
  const saveSessionNow = () => {
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = null;
    const snap = tabs.sessionSnapshot();
    browser.saveSession(snap.tabs, snap.activeIndex);
  };

  tunnel.on('change', (s: TunnelState) => {
    tabs.setLocked(tunnel.locked);
    send('tunnel:changed', s);
  });
  tabs.on('change', (s) => {
    send('tabs:changed', s);
    if (!sessionTimer) sessionTimer = setTimeout(saveSessionNow, 1500);
  });
  updater.on('change', (s) => send('updates:changed', s));
  store.on('change', (st) => send('profiles:changed', st));
  browser.on('bookmarks', (st) => send('bookmarks:changed', st));
  browser.on('settings', (st) => {
    send('settings:changed', st);
    const item = Menu.getApplicationMenu()?.getMenuItemById('bookmarks-bar');
    if (item) item.checked = st.showBookmarksBar;
  });

  // ---- IPC: only our own UI page may call in ----
  const trusted = (e: IpcMainInvokeEvent | IpcMainEvent) =>
    e.sender === win.webContents && e.senderFrame?.url === uiUrl;
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!trusted(e)) throw new Error('forbidden');
      return fn(...args);
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

  handle('profiles:get', () => store.state());
  handle('profiles:import', (text: unknown): ImportResult => {
    const { profiles, errors } = parseMany(str(text, 2_000_000));
    const added = store.addProfiles(profiles);
    return { added, errors };
  });
  handle('profiles:remove', async (id: unknown) => {
    if (tunnel.state.profileId === str(id)) await tunnel.disconnect();
    store.removeProfile(str(id));
  });
  handle('profiles:select', (id: unknown) => {
    store.select(str(id));
  });

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
  handle('subs:add', async (raw: unknown) => {
    const url = validateSubscriptionUrl(str(raw, 4000));
    const existing = store.state().subscriptions.find((s) => s.url === url.toString());
    const sub: Subscription = existing ?? { id: randomUUID(), url: url.toString(), title: url.hostname, updatedAt: 0 };
    return loadSubscription(sub);
  });
  handle('subs:refresh', async (id: unknown) => {
    const sub = store.subscription(str(id));
    if (!sub) throw new Error('подписка не найдена');
    try {
      return await loadSubscription(sub);
    } catch (e) {
      store.setSubscriptionError(sub.id, e instanceof Error ? e.message : String(e));
      throw e;
    }
  });
  handle('subs:remove', async (id: unknown) => {
    const current = store.profile(tunnel.state.profileId);
    if (current?.subscriptionId === str(id)) await tunnel.disconnect();
    store.removeSubscription(str(id));
  });

  handle('tunnel:get', () => tunnel.state);
  handle('tunnel:connect', (id: unknown) => {
    const profile = store.profile(id === undefined ? store.selectedId : str(id));
    if (!profile) throw new Error('сначала добавьте сервер');
    store.select(profile.id);
    void tunnel.connect(profile);
  });
  handle('tunnel:disconnect', () => tunnel.disconnect());

  // ---- tabs
  const tabMenu = (id: number) => {
    const e = tabs.entryOf(id);
    const bm = e ? browser.byUrl(e.url) : undefined;
    const st = tabs.state();
    Menu.buildFromTemplate([
      { label: 'Новая вкладка справа', click: () => tabs.newTabRightOf(id) },
      { label: 'Перезагрузить', enabled: !!e && !tunnel.locked, click: () => tabs.reload(id) },
      { label: 'Дублировать', enabled: !!e, click: () => tabs.duplicate(id) },
      {
        label: bm ? 'Удалить из закладок' : 'Добавить в закладки',
        enabled: !!e,
        click: () => (bm ? browser.removeBookmark(bm.id) : e && browser.addBookmark(e.url, e.title)),
      },
      { label: 'Копировать адрес', enabled: !!e, click: () => e && clipboard.writeText(e.url) },
      { type: 'separator' },
      { label: 'Закрыть вкладку', click: () => tabs.close(id) },
      { label: 'Закрыть другие вкладки', enabled: st.tabs.length > 1, click: () => tabs.closeOthers(id) },
      { label: 'Закрыть вкладки справа', enabled: st.tabs.findIndex((t) => t.id === id) < st.tabs.length - 1, click: () => tabs.closeToRight(id) },
      { type: 'separator' },
      { label: 'Открыть закрытую вкладку', enabled: st.canReopen, click: () => tabs.reopenClosed() },
    ]).popup({ window: win });
  };

  handle('tabs:get', () => tabs.state());
  handle('tabs:create', (input: unknown) => {
    tabs.create(input === undefined ? undefined : str(input, 8000));
  });
  handle('tabs:close', (id: unknown) => tabs.close(int(id)));
  handle('tabs:activate', (id: unknown) => tabs.activate(int(id)));
  handle('tabs:navigate', (id: unknown, input: unknown) => tabs.navigate(int(id), str(input, 8000)));
  handle('tabs:back', (id: unknown) => tabs.withTab(int(id), (wc) => wc.navigationHistory.goBack()));
  handle('tabs:forward', (id: unknown) => tabs.withTab(int(id), (wc) => wc.navigationHistory.goForward()));
  handle('tabs:reload', (id: unknown) => tabs.reload(int(id)));
  handle('tabs:stop', (id: unknown) => tabs.withTab(int(id), (wc) => wc.stop()));
  handle('tabs:move', (id: unknown, to: unknown) => tabs.move(int(id), int(to)));
  handle('tabs:context-menu', (id: unknown) => tabMenu(int(id)));
  handle('tabs:reopen-closed', () => tabs.reopenClosed());
  ipcMain.on('tabs:bounds', (e, r: UiRect) => {
    if (!trusted(e) || !r || typeof r !== 'object') return;
    tabs.setBounds({ x: Number(r.x) || 0, y: Number(r.y) || 0, width: Number(r.width) || 0, height: Number(r.height) || 0 });
  });
  ipcMain.on('tabs:overlay', (e, open: unknown) => {
    if (trusted(e)) tabs.setOverlay(open === true);
  });

  // ---- bookmarks
  const openBookmark = (id: string, how: OpenMode) => {
    const b = browser.bookmark(id);
    if (b) tabs.open(b.url, how);
  };
  const bookmarkMenu = (id: string) => {
    const b = browser.bookmark(id);
    if (!b) return;
    Menu.buildFromTemplate([
      { label: 'Открыть', click: () => openBookmark(id, 'current') },
      { label: 'Открыть в новой вкладке', click: () => openBookmark(id, 'new-tab') },
      { label: 'Открыть в фоновой вкладке', click: () => openBookmark(id, 'background') },
      { type: 'separator' },
      { label: 'Изменить…', click: () => openPanel('bookmarks', id) },
      { label: 'Копировать адрес', click: () => clipboard.writeText(b.url) },
      { label: 'Удалить', click: () => browser.removeBookmark(id) },
    ]).popup({ window: win });
  };
  /** Ctrl/Cmd+D: bookmark the page, or open the bookmark for editing if it already is one. */
  const bookmarkActivePage = () => {
    const e = tabs.activeEntry();
    if (!e) return;
    const existing = browser.byUrl(e.url);
    if (existing) openPanel('bookmarks', existing.id);
    else browser.addBookmark(e.url, e.title);
  };

  handle('bookmarks:get', () => browser.bookmarksState());
  handle('bookmarks:add', (url: unknown, title: unknown) => browser.addBookmark(str(url, 8000), str(title, 1000)));
  handle('bookmarks:remove', (id: unknown) => browser.removeBookmark(str(id, 100)));
  handle('bookmarks:update', (id: unknown, patch: unknown) => {
    const p = (patch ?? {}) as { title?: unknown; url?: unknown };
    browser.updateBookmark(str(id, 100), {
      title: p.title === undefined ? undefined : str(p.title, 1000),
      url: p.url === undefined ? undefined : str(p.url, 8000),
    });
  });
  handle('bookmarks:move', (id: unknown, to: unknown) => browser.moveBookmark(str(id, 100), int(to)));
  handle('bookmarks:open', (id: unknown, how: unknown) => openBookmark(str(id, 100), mode(how)));
  handle('bookmarks:context-menu', (id: unknown) => bookmarkMenu(str(id, 100)));
  handle('bookmarks:overflow-menu', (ids: unknown) => {
    if (!Array.isArray(ids)) throw new Error('bad argument');
    const items = ids
      .slice(0, 500)
      .map((id) => browser.bookmark(str(id, 100)))
      .filter((b) => b !== undefined)
      .map((b) => ({ label: b.title.length > 60 ? `${b.title.slice(0, 60)}…` : b.title, click: () => tabs.open(b.url, 'current') }));
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  // ---- updates and app
  handle('updates:get', () => updater.state);
  handle('updates:check', () => updater.check());
  handle('updates:install', () => updater.install());
  handle('updates:history', () => releaseHistory());

  const xrayVersion = coreVersion(corePath);
  handle('app:info', async () => ({
    version: app.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    xrayVersion: await xrayVersion,
    repo: APP_REPO,
  }));
  handle('app:clear-data', () => gate.clearData());
  handle('app:settings', () => browser.settings());
  handle('app:set-settings', (patch: unknown) => browser.setSettings((patch ?? {}) as Partial<BrowserSettings>));

  buildMenu(win, tabs, {
    focusAddress: () => send('ui:focus-address'),
    bookmarkPage: bookmarkActivePage,
    openBookmarks: () => openPanel('bookmarks'),
    toggleBar: (on) => browser.setSettings({ showBookmarksBar: on }),
    barShown: browser.settings().showBookmarksBar,
  });
  await win.loadURL(uiUrl);
  reportError = (message: string) => send('ui:error', message);
  for (const m of earlyErrors.splice(0)) reportError(m);

  const last = browser.session();
  if (last?.tabs.length) tabs.restore(last.tabs, last.activeIndex);
  else tabs.create();
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

  // Quit: stop the core at once, then give the encrypted files a moment to be written.
  let quitting = false;
  let readyToQuit = false;
  app.on('before-quit', (e) => {
    if (readyToQuit) return;
    e.preventDefault();
    if (quitting) return;
    quitting = true;
    updater.stop();
    tunnel.killNow();
    saveSessionNow();
    const done = Promise.all([browser.flush(), store.flush()]);
    void Promise.race([done, new Promise((r) => setTimeout(r, 2000))]).finally(() => {
      readyToQuit = true;
      app.quit();
    });
  });
  win.on('closed', () => {
    tabs.destroyAll();
    if (!quitting) app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  process.on('exit', () => tunnel.killNow());

  if (isMac && app.isPackaged && !app.isInApplicationsFolder() && !browser.declinedMoveToApplications) {
    void offerMoveToApplications(win, browser);
  }

  if (__SMOKE__ && process.env.TB_SMOKE) {
    const { runSmoke } = await import('./smoke');
    await runSmoke({ win, gate, tunnel, tabs, store, browser });
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
  focusAddress: () => void;
  bookmarkPage: () => void;
  openBookmarks: () => void;
  toggleBar: (on: boolean) => void;
  barShown: boolean;
}

function buildMenu(win: BrowserWindow, tabs: Tabs, hooks: MenuHooks) {
  const active = () => tabs.active;
  const activeId = () => tabs.state().activeId;
  const zoom = (delta: number | null) => {
    const wc = active();
    if (!wc) return;
    wc.setZoomLevel(delta === null ? 0 : wc.getZoomLevel() + delta);
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Файл',
      submenu: [
        { label: 'Новая вкладка', accelerator: 'CmdOrCtrl+T', click: () => tabs.create() },
        { label: 'Открыть закрытую вкладку', accelerator: 'CmdOrCtrl+Shift+T', click: () => tabs.reopenClosed() },
        {
          label: 'Закрыть вкладку',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const id = activeId();
            if (id !== null) tabs.close(id);
          },
        },
        { label: 'Адресная строка', accelerator: 'CmdOrCtrl+L', click: hooks.focusAddress },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Закрыть окно' } : { role: 'quit', label: 'Выход' },
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
        {
          label: 'Перезагрузить страницу',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            const id = activeId();
            if (id !== null) tabs.reload(id);
          },
        },
        {
          label: 'Перезагрузить (F5)',
          accelerator: 'F5',
          visible: false,
          click: () => {
            const id = activeId();
            if (id !== null) tabs.reload(id);
          },
        },
        { label: 'Назад', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: () => active()?.navigationHistory.goBack() },
        { label: 'Вперёд', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: () => active()?.navigationHistory.goForward() },
        { label: 'Следующая вкладка', accelerator: 'Ctrl+Tab', click: () => tabs.cycle(1) },
        { label: 'Предыдущая вкладка', accelerator: 'Ctrl+Shift+Tab', click: () => tabs.cycle(-1) },
        { type: 'separator' },
        { label: 'Увеличить', accelerator: 'CmdOrCtrl+=', click: () => zoom(0.5) },
        { label: 'Уменьшить', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
        { label: 'Обычный масштаб', accelerator: 'CmdOrCtrl+0', click: () => zoom(null) },
        { type: 'separator' },
        { label: 'Инструменты разработчика страницы', accelerator: isMac ? 'Cmd+Alt+I' : 'F12', click: () => active()?.openDevTools({ mode: 'detach' }) },
        ...(!app.isPackaged
          ? [
              {
                label: 'Инструменты разработчика интерфейса',
                accelerator: 'CmdOrCtrl+Shift+I',
                click: () => win.webContents.openDevTools({ mode: 'detach' }),
              },
            ]
          : []),
        { role: 'togglefullscreen', label: 'Полный экран' },
      ],
    },
    {
      label: 'Закладки',
      submenu: [
        { label: 'Добавить страницу в закладки', accelerator: 'CmdOrCtrl+D', click: hooks.bookmarkPage },
        { label: 'Все закладки', accelerator: 'CmdOrCtrl+Alt+B', click: hooks.openBookmarks },
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
