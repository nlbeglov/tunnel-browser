// One browser window = one window profile (windowProfiles.ts): its own Chromium storage,
// tunnel (its own Xray core and port), gate, page guard, tabs and bookmarks. Two windows
// share nothing a site could see; only the servers list, settings and updates are common
// (index.ts).

import { BrowserWindow, Menu, app, clipboard, dialog, nativeImage, nativeTheme, type WebContents } from 'electron';
import { join } from 'node:path';
import type { AppMenuEntry, OpenMode, PanelName, PopupData, ProfilesState, ServerProfile, TunnelState } from '../shared/types';
import { Popup } from './popup';
import type { BrowserData } from './browserData';
import type { ExitInfo } from './health';
import { serverKey } from './links';
import { identityFor, isNewExit } from './identity';
import type { UaMetadata } from './pageGuard';
import type { Store } from './store';
import { Tabs } from './tabs';
import { Tunnel } from './tunnel';
import { TunnelSession, hardenWebContents } from './tunnelSession';
import { FIRST_PROFILE_ID } from './windowProfiles';

const isMac = process.platform === 'darwin';
/** .tabstrip height in styles.css: the window buttons are drawn at the same height */
export const TAB_STRIP_HEIGHT = 38;

export interface AppContext {
  corePath: string;
  uiUrl: string;
  store: Store;
  browser: BrowserData;
  /** this browser's client hints, read once from the first window's UI */
  uaMetadata: Promise<UaMetadata | null>;
  readUaMetadata: (win: BrowserWindow) => void;
  /** a window's profile, exit or open state changed: every UI's profiles panel updates */
  profilesChanged: () => void;
  /** a new window exists: from now on its UI may call in (before it has loaded) */
  opened: (w: ProfileWindow) => void;
  closed: (w: ProfileWindow) => void;
  quitting: () => boolean;
}

export class ProfileWindow {
  readonly win: BrowserWindow;
  readonly gate: TunnelSession;
  readonly tunnel: Tunnel;
  readonly tabs: Tabs;
  private readonly popup: Popup;
  private sessionTimer: NodeJS.Timeout | null = null;
  private readonly onWebContents: (e: unknown, wc: WebContents) => void;

  /** Opens a window of the profile; resolves once its UI is up and its tabs are back. */
  static async open(profileId: string, ctx: AppContext, near?: BrowserWindow): Promise<ProfileWindow> {
    const gate = new TunnelSession(ctx.browser.profile(profileId).partition);
    await gate.init();
    const w = new ProfileWindow(profileId, ctx, gate, near);
    ctx.opened(w);
    await w.start();
    return w;
  }

  private constructor(
    readonly profileId: string,
    private readonly ctx: AppContext,
    gate: TunnelSession,
    near?: BrowserWindow,
  ) {
    this.gate = gate;
    void ctx.uaMetadata.then((m) => gate.guard.setMetadata(m));
    // Every page of this profile's storage: hardened, and blocked from the network until its
    // time zone and language are replaced (pageGuard.ts).
    this.onWebContents = (_e, wc) => {
      if (wc.session !== gate.ses) return;
      hardenWebContents(wc);
      gate.guard.track(wc);
    };
    app.on('web-contents-created', this.onWebContents);

    const pidFile = join(app.getPath('userData'), profileId === FIRST_PROFILE_ID ? 'core.pid' : `core-${profileId}.pid`);
    this.tunnel = new Tunnel(gate, ctx.corePath, pidFile, {
      // The tunnel works but the gate is still closed: no page has reached anything through
      // the new exit. Ask about a new IP now, then give pages the exit's time zone.
      beforeOpen: async (exit, server) => {
        if (!(await this.confirmNewExit(exit, server))) return { cancel: true };
        const identity = identityFor(exit.country, exit.colo, exit.zone);
        await gate.guard.setIdentity(identity);
        return { timezone: identity.timezone };
      },
    });

    const at = near && !near.isDestroyed() ? near.getBounds() : undefined;
    this.win = new BrowserWindow({
      width: at?.width ?? 1280,
      height: at?.height ?? 820,
      ...(at ? { x: at.x + 32, y: at.y + 32 } : {}),
      minWidth: 760,
      minHeight: 500,
      show: false,
      title: this.title(),
      backgroundColor: '#15171c',
      // Chrome-style window: no title bar, the tab strip sits next to the window buttons
      // (traffic lights on macOS; minimise / maximise / close drawn over the strip elsewhere).
      ...(isMac
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } }
        : { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarColors() }),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    const win = this.win;
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // The taskbar and Alt+Tab show the profile's name, not the UI page's title.
    win.on('page-title-updated', (e) => e.preventDefault());
    win.once('ready-to-show', () => win.show());
    win.on('enter-full-screen', () => this.send('ui:fullscreen', true));
    win.on('leave-full-screen', () => this.send('ui:fullscreen', false));
    win.on('focus', () => this.ctx.profilesChanged());
    // Windows: the menu only carries the keyboard shortcuts; its bar is never shown. With
    // auto-hide, Alt (part of the Alt+Shift layout switch) kept popping it up.
    if (!isMac) win.setMenuBarVisibility(false);

    this.tabs = new Tabs(win, gate.ses, gate.guard);
    this.popup = new Popup(win, ctx.uiUrl.replace(/index\.html$/, 'popup.html'), join(__dirname, '../preload/popup.js'));
    this.tabs.onAttach = () => this.popup.raise();
    this.tunnel.on('change', (s: TunnelState) => {
      this.tabs.setLocked(this.tunnel.locked);
      this.send('tunnel:changed', s);
      this.refreshPanel();
      if (s.status === 'connected') {
        const server = ctx.store.profile(s.profileId);
        const key = server ? serverKey(server) : undefined;
        ctx.browser.setLastExit(profileId, { ip: s.exit?.ip, country: s.exit?.country, serverKey: key });
        // The provider may have renamed it: remember the name it has now.
        if (server && key && key === this.profile.serverKey) ctx.browser.setServer(profileId, { key, name: server.name });
      }
      this.ctx.profilesChanged();
    });
    this.tabs.on('change', (s) => {
      this.send('tabs:changed', s);
      if (!this.sessionTimer) this.sessionTimer = setTimeout(() => this.saveSession(), 1500);
    });
    this.tabs.on('icon', (url, icon) => ctx.browser.setBookmarkIcon(profileId, url, icon));

    win.on('closed', () => {
      app.off('web-contents-created', this.onWebContents);
      this.saveSession();
      this.tabs.destroyAll();
      if (!ctx.quitting()) void this.tunnel.disconnect().catch(() => this.tunnel.killNow());
      ctx.closed(this);
    });
  }

  private async start() {
    await this.win.loadURL(this.ctx.uiUrl);
    this.ctx.readUaMetadata(this.win);
    const last = this.ctx.browser.session(this.profileId);
    if (last?.tabs.length) this.tabs.restore(last.tabs, last.activeIndex);
    else this.tabs.create();
  }

  get profile() {
    return this.ctx.browser.profile(this.profileId);
  }

  title(): string {
    return `${this.ctx.browser.profile(this.profileId).name} — Tunnel Browser`;
  }

  /** The ⋮ menu under the button: its right edge and top in window coordinates. */
  showMenu(at: { right: number; top: number }, items: AppMenuEntry[], act: (id: string) => void) {
    return this.popup.show(at, { kind: 'menu', items }, (id) => {
      this.popup.hide();
      act(id);
    });
  }

  /** The panel under the IP (this profile's connection) or under the bookmarks button. */
  showPanel(kind: 'connection' | 'bookmarks', at: { right: number; top: number }, editId?: string) {
    return this.popup.show(at, this.panelContent(kind, editId), (id, arg) => this.panelAct(kind, id, arg));
  }

  /** Something the open panel shows has changed. */
  refreshPanel() {
    const kind = this.popup.kind;
    if (kind === 'connection' || kind === 'bookmarks') this.popup.update(this.panelContent(kind));
  }

  private panelContent(kind: 'connection' | 'bookmarks', editId?: string): PopupData {
    if (kind === 'bookmarks') return { kind, data: { bookmarks: this.ctx.browser.bookmarksState(this.profileId), editId } };
    const p = this.profile;
    const server = this.server();
    return { kind, data: { tunnel: this.tunnel.state, server, me: { serverName: p.serverName, serverMissing: !!p.serverKey && !server } } };
  }

  private async panelAct(kind: 'connection' | 'bookmarks', id: string, arg: unknown): Promise<unknown> {
    const a = (arg ?? {}) as Record<string, unknown>;
    const s = (v: unknown, max = 8000) => (typeof v === 'string' ? v.slice(0, max) : '');
    try {
      if (kind === 'connection') {
        if (id === 'connect') return await this.connect();
        if (id === 'disconnect') return await this.tunnel.disconnect();
        if (id === 'measure') return await this.tunnel.measureLatency();
        if (id === 'settings') {
          this.popup.hide();
          return this.openPanel('servers');
        }
      } else {
        const bid = s(a.id, 100);
        if (id === 'open') {
          const how: OpenMode = a.how === 'new-tab' || a.how === 'background' ? a.how : 'current';
          if (how !== 'background') this.popup.hide();
          return this.openBookmark(bid, how);
        }
        if (id === 'remove') return this.ctx.browser.removeBookmark(this.profileId, bid);
        if (id === 'update') return this.ctx.browser.updateBookmark(this.profileId, bid, { title: s(a.title, 500), url: s(a.url) });
        if (id === 'move') return this.ctx.browser.moveBookmark(this.profileId, bid, Number.isInteger(a.to) ? (a.to as number) : 0);
        if (id === 'context') return this.bookmarkMenu(bid);
      }
    } catch (e) {
      // The panel shows its own errors for edits; the rest go where the UI shows errors.
      if (id === 'update') throw e;
      this.send('ui:error', e instanceof Error ? e.message : String(e));
    }
    return undefined;
  }

  /** The profile was renamed or recoloured. */
  refresh() {
    if (!this.win.isDestroyed()) this.win.setTitle(this.title());
  }

  send(channel: string, ...payload: unknown[]) {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, ...payload);
  }

  openPanel(panel: PanelName, bookmarkId?: string) {
    this.send('ui:open-panel', panel, bookmarkId);
  }

  focus() {
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  saveSession() {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    const snap = this.tabs.sessionSnapshot();
    this.ctx.browser.saveSession(this.profileId, snap.tabs, snap.activeIndex);
  }

  // ---- servers: each window connects to its own

  /** The server this profile uses, found by its connection settings; none is guessed. */
  server(): ServerProfile | undefined {
    const key = this.profile.serverKey;
    return key ? this.ctx.store.state().profiles.find((s) => serverKey(s) === key) : undefined;
  }

  selectedServerId(): string | undefined {
    return this.server()?.id;
  }

  serversState(): ProfilesState {
    return { ...this.ctx.store.state(), selectedId: this.selectedServerId() };
  }

  /**
   * Makes `id` this profile's server. Another server usually means another IP for the sites
   * this profile is known to, so replacing a server the profile already has is confirmed
   * first; a connected window then reconnects through the new one. Resolves false when the
   * user keeps the old server.
   */
  async selectServer(id: string): Promise<boolean> {
    const next = this.ctx.store.profile(id);
    if (!next) throw new Error('сервер не найден');
    const current = this.server();
    if (current && current.id === next.id) return true;
    const st = this.tunnel.state.status;
    const live = st === 'connected' || st === 'degraded' || st === 'connecting';
    if (current) {
      const r = await dialog.showMessageBox(this.win, {
        type: 'question',
        buttons: [live ? 'Сменить и переподключить' : 'Сменить сервер', 'Отмена'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: `Сменить сервер профиля «${this.profile.name}»?`,
        detail:
          `Сейчас: ${current.name}\nНовый: ${next.name}\n\n` +
          'У другого сервера, скорее всего, другой IP-адрес. Сайты, где вы вошли в этом профиле, могут связать новый ' +
          'адрес со старым. Если адрес действительно сменится, при подключении приложение спросит, очистить ли данные сайтов.',
      });
      if (r.response !== 0) return false;
    }
    this.ctx.browser.setServer(this.profileId, { key: serverKey(next), name: next.name });
    this.send('profiles:changed', this.serversState());
    this.ctx.profilesChanged();
    if (current && live) void this.tunnel.connect(next);
    return true;
  }

  /** Connects through the profile's server, or through `id` once it is the profile's server. */
  async connect(id?: string) {
    if (id !== undefined && id !== this.selectedServerId()) {
      if (!(await this.selectServer(id))) return;
      // A connected window already reconnected in selectServer.
      if (this.tunnel.state.status === 'connecting') return;
    }
    const server = this.server();
    if (!server) throw new Error(this.profile.serverName ? 'сервера этого профиля больше нет: выберите другой' : 'выберите сервер');
    void this.tunnel.connect(server);
  }

  /** Pages forget everything they knew: storage is wiped and no page script survives. */
  async forgetSites() {
    this.tabs.resetAll();
    await this.gate.clearData();
  }

  /**
   * A new exit IP is a new address for sites, and those that know you by cookies or a login
   * would link it to the old one. Asked only when the IP really changes, once the tunnel has
   * found it out and before the gate opens: nothing has reached any site through it yet.
   * With "clear", the old identity is gone before the first page loads.
   */
  private async confirmNewExit(exit: ExitInfo, server: ServerProfile): Promise<boolean> {
    const p = this.profile;
    if (!isNewExit(exit.ip, p.lastExitIp, !!p.lastServerKey && p.lastServerKey !== serverKey(server))) return true;
    if (!this.ctx.browser.settings().warnOnServerSwitch) return true;
    const cookies = await this.gate.ses.cookies.get({}).catch(() => []);
    if (!cookies.length) return true;
    const known = exit.ip && exit.ip !== '?';
    const r = await dialog.showMessageBox(this.win, {
      type: 'warning',
      buttons: ['Очистить и подключить', 'Подключить без очистки', 'Не подключаться'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message: known ? `«${p.name}»: новый IP-адрес для сайтов ${exit.ip}` : `«${p.name}»: возможно, новый IP-адрес`,
      detail:
        (known && p.lastExitIp ? `Раньше сайты видели этот профиль с адреса ${p.lastExitIp}. ` : '') +
        'Сайты, где вы вошли в аккаунт или которые запомнили вас по куки, увидят новый адрес рядом со старыми куки ' +
        'и поймут, что это тот же человек.\n\n' +
        '«Очистить и подключить» удалит куки, входы и данные сайтов этого профиля, а открытые вкладки загрузятся ' +
        'заново. Сервер уже проверен, но окно закрыто для сайтов: пока вы не ответите, они ничего не получают.',
      checkboxLabel: 'Больше не спрашивать (включить снова: ⋮ → Настройки → Конфиденциальность и защита)',
    });
    if (r.response === 2) return false;
    if (r.checkboxChecked) this.ctx.browser.setSettings({ warnOnServerSwitch: false });
    if (r.response === 0) await this.forgetSites();
    return true;
  }

  // ---- bookmarks and menus of this window

  openBookmark(id: string, how: OpenMode) {
    const b = this.ctx.browser.bookmark(this.profileId, id);
    if (!b) return;
    // From the settings tab the UI decides where it opens: in an empty tab, or in place of
    // the settings tab (App.tsx). The page under the settings stays as it was.
    if (how === 'current' && this.tabs.settings === 'active') return this.send('ui:settings-navigate', b.url);
    this.tabs.open(b.url, how);
  }

  /** Ctrl/Cmd+D: bookmark the page, or open the bookmark for editing if it already is one. */
  bookmarkActivePage() {
    const e = this.tabs.activeEntry();
    if (!e) return;
    const existing = this.ctx.browser.byUrl(this.profileId, e.url);
    if (existing) this.openPanel('bookmarks', existing.id);
    else this.ctx.browser.addBookmark(this.profileId, e.url, e.title, this.tabs.state().tabs.find((t) => t.url === e.url)?.icon);
  }

  tabMenu(id: number) {
    const { browser } = this.ctx;
    const e = this.tabs.entryOf(id);
    const bm = e ? browser.byUrl(this.profileId, e.url) : undefined;
    const st = this.tabs.state();
    const icon = st.tabs.find((t) => t.id === id)?.icon;
    Menu.buildFromTemplate([
      { label: 'Новая вкладка справа', click: () => this.tabs.newTabRightOf(id) },
      { label: 'Перезагрузить', enabled: !!e && !this.tunnel.locked, click: () => this.tabs.reload(id) },
      { label: 'Дублировать', enabled: !!e, click: () => this.tabs.duplicate(id) },
      {
        label: bm ? 'Удалить из закладок' : 'Добавить в закладки',
        enabled: !!e,
        click: () => (bm ? browser.removeBookmark(this.profileId, bm.id) : e && browser.addBookmark(this.profileId, e.url, e.title, icon)),
      },
      { label: 'Копировать адрес', enabled: !!e, click: () => e && clipboard.writeText(e.url) },
      { type: 'separator' },
      { label: 'Закрыть вкладку', click: () => this.tabs.close(id) },
      { label: 'Закрыть другие вкладки', enabled: st.tabs.length > 1, click: () => this.tabs.closeOthers(id) },
      { label: 'Закрыть вкладки справа', enabled: st.tabs.findIndex((t) => t.id === id) < st.tabs.length - 1, click: () => this.tabs.closeToRight(id) },
      { type: 'separator' },
      { label: 'Открыть закрытую вкладку', enabled: st.canReopen, click: () => this.tabs.reopenClosed() },
    ]).popup({ window: this.win });
  }

  bookmarkMenu(id: string) {
    const { browser } = this.ctx;
    const b = browser.bookmark(this.profileId, id);
    if (!b) return;
    Menu.buildFromTemplate([
      { label: 'Открыть', click: () => this.openBookmark(id, 'current') },
      { label: 'Открыть в новой вкладке', click: () => this.openBookmark(id, 'new-tab') },
      { label: 'Открыть в фоновой вкладке', click: () => this.openBookmark(id, 'background') },
      { type: 'separator' },
      { label: 'Изменить…', click: () => this.openPanel('bookmarks', id) },
      { label: 'Копировать адрес', click: () => clipboard.writeText(b.url) },
      { label: 'Удалить', click: () => browser.removeBookmark(this.profileId, id) },
    ]).popup({ window: this.win });
  }

  bookmarkOverflowMenu(ids: string[]) {
    const items = ids
      .slice(0, 500)
      .map((id) => this.ctx.browser.bookmark(this.profileId, id))
      .filter((b) => b !== undefined)
      .map((b) => ({ label: b.title.length > 60 ? `${b.title.slice(0, 60)}…` : b.title, click: () => this.tabs.open(b.url, 'current') }));
    if (items.length) Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  // ---- window chrome

  /** The UI reports the colours of its (tinted) tab strip: the window buttons take them. */
  setTitleBarColors(color: string, symbolColor: string) {
    if (isMac || this.win.isDestroyed()) return;
    this.win.setTitleBarOverlay({ height: TAB_STRIP_HEIGHT, color, symbolColor });
  }

  /** Windows: the profile's colour and exit flag over the window's taskbar icon. */
  setTaskbarBadge(png: string | null, description: string) {
    if (process.platform !== 'win32' || this.win.isDestroyed()) return;
    if (!png) return this.win.setOverlayIcon(null, '');
    const img = nativeImage.createFromDataURL(png);
    if (!img.isEmpty()) this.win.setOverlayIcon(img, description.slice(0, 120));
  }
}

/** Window buttons before the UI reports its strip colours: same height as the strip. */
function titleBarColors(): Electron.TitleBarOverlay {
  const dark = nativeTheme.shouldUseDarkColors;
  return { height: TAB_STRIP_HEIGHT, color: dark ? '#15171c' : '#eef0f4', symbolColor: dark ? '#e8eaee' : '#1b1e24' };
}
