import { BrowserWindow, Menu, app, ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ImportResult, Subscription, TunnelState, UiRect } from '../shared/types';
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

  const store = new Store();
  await store.load();
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
  const send = (channel: string, payload?: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  tunnel.on('change', (s: TunnelState) => {
    tabs.setLocked(tunnel.locked);
    send('tunnel:changed', s);
  });
  tabs.on('change', (s) => send('tabs:changed', s));
  updater.on('change', (s) => send('updates:changed', s));

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
  store.on('change', (st) => send('profiles:changed', st));

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
  ipcMain.on('tabs:bounds', (e, r: UiRect) => {
    if (!trusted(e) || !r || typeof r !== 'object') return;
    tabs.setBounds({ x: Number(r.x) || 0, y: Number(r.y) || 0, width: Number(r.width) || 0, height: Number(r.height) || 0 });
  });
  ipcMain.on('tabs:overlay', (e, open: unknown) => {
    if (trusted(e)) tabs.setOverlay(open === true);
  });

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

  buildMenu(win, tabs, send);
  await win.loadURL(uiUrl);
  tabs.create();
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

  let quitting = false;
  app.on('before-quit', () => {
    quitting = true;
    updater.stop();
    tunnel.killNow();
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

  if (__SMOKE__ && process.env.TB_SMOKE) {
    const { runSmoke } = await import('./smoke');
    await runSmoke({ win, gate, tunnel, tabs, store });
  }
}

function buildMenu(win: BrowserWindow, tabs: Tabs, send: (c: string, p?: unknown) => void) {
  const active = () => tabs.active;
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
        {
          label: 'Закрыть вкладку',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const id = tabs.state().activeId;
            if (id !== null) tabs.close(id);
          },
        },
        { label: 'Адресная строка', accelerator: 'CmdOrCtrl+L', click: () => send('ui:focus-address') },
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
            const id = tabs.state().activeId;
            if (id !== null) tabs.reload(id);
          },
        },
        {
          label: 'Перезагрузить (F5)',
          accelerator: 'F5',
          visible: false,
          click: () => {
            const id = tabs.state().activeId;
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
        { label: 'Инструменты разработчика страницы', accelerator: 'F12', click: () => active()?.openDevTools({ mode: 'detach' }) },
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
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
