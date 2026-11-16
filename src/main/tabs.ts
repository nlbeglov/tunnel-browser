// Browser tabs as WebContentsViews inside the main window. Every tab and popup lives in
// the tunnel session. While the tunnel is locked (not connected, or connected but the
// server stopped answering), no tab view is attached to the window, and tabs restored from
// the last session wait (unloaded) until the tunnel is up.

import { BrowserWindow, Menu, WebContentsView, clipboard, type Rectangle, type Session, type WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import type { OpenMode, TabInfo, TabsState } from '../shared/types';
import { isWebUrl } from './guard';
import type { PageGuard } from './pageGuard';
import { inputToUrl, loadErrorText } from './url';

export interface TabEntry {
  url: string;
  title: string;
}

interface Tab {
  id: number;
  view: WebContentsView;
  /** false for a fresh tab that shows the start page */
  started: boolean;
  /** restored or opened while locked: loads when it is shown with the tunnel up */
  pending?: TabEntry;
  error?: string;
  /** resolves once the page guard covers this tab; nothing loads before that */
  covered: Promise<void>;
}

const MAX_CLOSED = 25;

export class Tabs extends EventEmitter<{ change: [TabsState] }> {
  private readonly tabs = new Map<number, Tab>();
  private order: number[] = [];
  private activeId: number | null = null;
  private nextId = 1;
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private overlay = false;
  private locked = true;
  private attached: WebContentsView | null = null;
  private readonly popups = new Set<BrowserWindow>();
  private emitTimer: NodeJS.Timeout | null = null;
  private closed: TabEntry[] = [];

  constructor(
    private readonly win: BrowserWindow,
    private readonly ses: Session,
    private readonly guard: PageGuard,
  ) {
    super();
  }

  state(): TabsState {
    return {
      tabs: this.order.map((id) => this.info(this.tabs.get(id)!)),
      activeId: this.activeId,
      canReopen: this.closed.length > 0,
    };
  }

  private entry(t: Tab): TabEntry | null {
    if (t.pending) return t.pending;
    if (!t.started) return null;
    const wc = t.view.webContents;
    const url = wc.getURL();
    return isWebUrl(url) ? { url, title: wc.getTitle() || url } : null;
  }

  private info(t: Tab): TabInfo {
    const wc = t.view.webContents;
    if (t.pending) {
      return { id: t.id, url: t.pending.url, title: t.pending.title, loading: false, canGoBack: false, canGoForward: false };
    }
    return {
      id: t.id,
      url: t.started ? wc.getURL() : '',
      title: t.started ? wc.getTitle() || wc.getURL() : 'Новая вкладка',
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      error: t.error,
    };
  }

  private changed() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('change', this.state());
    }, 30);
  }

  get active(): WebContents | null {
    return this.activeId === null ? null : (this.tabs.get(this.activeId)?.view.webContents ?? null);
  }

  /** URL and title of the active tab, if it shows a web page. */
  activeEntry(): TabEntry | null {
    const t = this.activeId === null ? undefined : this.tabs.get(this.activeId);
    return t ? this.entry(t) : null;
  }

  entryOf(id: number): TabEntry | null {
    const t = this.tabs.get(id);
    return t ? this.entry(t) : null;
  }

  /** Restorable tabs in order, and which of them is active. */
  sessionSnapshot(): { tabs: TabEntry[]; activeIndex: number } {
    const tabs: TabEntry[] = [];
    let activeIndex = 0;
    for (const id of this.order) {
      const e = this.entry(this.tabs.get(id)!);
      if (!e) continue;
      if (id === this.activeId) activeIndex = tabs.length;
      tabs.push(e);
    }
    return { tabs, activeIndex };
  }

  private newTab(position: number): Tab {
    const tab = { id: this.nextId++, started: false } as Tab;
    this.attachNewView(tab);
    this.tabs.set(tab.id, tab);
    this.order.splice(Math.max(0, Math.min(position, this.order.length)), 0, tab.id);
    return tab;
  }

  /** A fresh page for the tab, covered by the page guard before anything can load in it. */
  private attachNewView(tab: Tab) {
    const view = new WebContentsView({
      webPreferences: {
        session: this.ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const covered = this.guard.protect(view.webContents);
    tab.view = view;
    tab.covered = covered;
    covered.catch((e) => {
      if (tab.view !== view) return;
      tab.error = `Не удалось скрыть часовой пояс и язык этого компьютера (${e instanceof Error ? e.message : e}). Страница не загружена.`;
      this.layout();
      this.changed();
    });
    this.wire(tab);
  }

  /**
   * Every open page is dropped from memory and its tab comes back unloaded, like a restored
   * one: no script of the old pages keeps running with what it knew (used when site data is
   * cleared, e.g. before switching to another server).
   */
  resetAll() {
    for (const p of this.popups) if (!p.isDestroyed()) p.destroy();
    for (const id of this.order) {
      const tab = this.tabs.get(id)!;
      const entry = this.entry(tab);
      const old = tab.view;
      if (this.attached === old) {
        this.win.contentView.removeChildView(old);
        this.attached = null;
      }
      this.attachNewView(tab);
      if (!old.webContents.isDestroyed()) old.webContents.close();
      tab.started = false;
      tab.error = undefined;
      tab.pending = entry ?? undefined;
    }
    this.loadPendingIfShown();
    this.layout();
    this.changed();
  }

  private afterActive(): number {
    return this.activeId === null ? this.order.length : this.order.indexOf(this.activeId) + 1;
  }

  /** New tab next to the active one; with input it navigates (or waits for the tunnel). */
  create(input?: string, activate = true): number {
    const tab = this.newTab(this.afterActive());
    if (activate || this.activeId === null) this.activeId = tab.id;
    if (input) {
      if (this.locked) tab.pending = { url: inputToUrl(input), title: input };
      else this.navigate(tab.id, input);
    }
    this.layout();
    this.changed();
    return tab.id;
  }

  /** Recreates the last session's tabs without loading them. */
  restore(entries: TabEntry[], activeIndex: number) {
    const ids = entries.map((e, i) => {
      const tab = this.newTab(this.order.length);
      tab.pending = { url: e.url, title: e.title || e.url };
      return i === activeIndex ? tab.id : -1;
    });
    const active = ids.find((id) => id >= 0);
    if (active !== undefined) this.activeId = active;
    else if (this.order.length) this.activeId = this.order[0];
    this.loadPendingIfShown();
    this.layout();
    this.changed();
  }

  /** Opens a URL the way Chrome does for bookmarks and links. */
  open(url: string, mode: OpenMode) {
    if (mode === 'current' && this.activeId !== null) {
      const tab = this.tabs.get(this.activeId)!;
      if (this.locked) {
        tab.pending = { url: inputToUrl(url), title: url };
        this.layout();
        this.changed();
      } else this.navigate(tab.id, url);
      return;
    }
    this.create(url, mode !== 'background');
  }

  private loadPendingIfShown() {
    if (this.locked || this.activeId === null) return;
    const tab = this.tabs.get(this.activeId);
    if (!tab?.pending) return;
    const { url } = tab.pending;
    tab.pending = undefined;
    tab.started = true;
    tab.error = undefined;
    this.load(tab, url);
  }

  /** Loads only once the guard covers the tab (see pageGuard.ts). */
  private load(tab: Tab, url: string) {
    tab.covered.then(
      () => {
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.loadURL(url).catch(() => {});
      },
      () => {
        /* the tab shows why */
      },
    );
  }

  private wire(tab: Tab) {
    const wc = tab.view.webContents;
    const update = () => this.changed();
    /** after resetAll() a tab has a new page; the old one's last events are ignored */
    const current = () => tab.view.webContents === wc;
    wc.on('did-start-navigation', (d) => {
      if (!current()) return;
      if (d.isMainFrame && !d.isSameDocument) {
        tab.error = undefined;
        this.layout();
      }
      update();
    });
    wc.on('did-navigate', update);
    wc.on('did-navigate-in-page', update);
    wc.on('page-title-updated', update);
    wc.on('did-start-loading', update);
    wc.on('did-stop-loading', update);
    wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (!current() || !isMainFrame || code === -3) return; // -3: aborted by a new navigation
      tab.error = loadErrorText(code, desc);
      this.layout();
      update();
    });
    wc.on('render-process-gone', (_e, d) => {
      if (!current()) return;
      tab.error = `Страница аварийно закрылась (${d.reason}). Перезагрузите её.`;
      this.layout();
      update();
    });

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!isWebUrl(url)) return { action: 'deny' };
      if (disposition === 'new-window') {
        // Real popups (OAuth, payment widgets) need window.opener, so they stay popups,
        // in the same tunnel session and with the same hardening.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 700,
            autoHideMenuBar: true,
            webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
          },
        };
      }
      this.create(url, disposition !== 'background-tab');
      return { action: 'deny' };
    });
    wc.on('did-create-window', (child, details) => {
      void this.guard.adopt(child.webContents, details.url).catch(() => child.close());
      this.popups.add(child);
      child.on('closed', () => this.popups.delete(child));
      if (this.locked) child.close();
    });

    wc.on('context-menu', (_e, p) => {
      const items: Electron.MenuItemConstructorOptions[] = [];
      if (p.linkURL && isWebUrl(p.linkURL)) {
        items.push(
          { label: 'Открыть ссылку в новой вкладке', click: () => this.create(p.linkURL, false) },
          { label: 'Копировать адрес ссылки', click: () => clipboard.writeText(p.linkURL) },
          { type: 'separator' },
        );
      }
      if (p.isEditable) {
        items.push({ role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' }, { role: 'paste', label: 'Вставить' });
      } else if (p.selectionText) {
        items.push({ role: 'copy', label: 'Копировать' });
      }
      if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
      items.push(
        { label: 'Назад', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Вперёд', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Перезагрузить', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Инструменты разработчика', click: () => wc.openDevTools({ mode: 'detach' }) },
      );
      Menu.buildFromTemplate(items).popup({ window: this.win });
    });
  }

  close(id: number) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const e = this.entry(tab);
    if (e) {
      this.closed.push(e);
      if (this.closed.length > MAX_CLOSED) this.closed.shift();
    }
    const idx = this.order.indexOf(id);
    this.order.splice(idx, 1);
    this.tabs.delete(id);
    if (this.attached === tab.view) {
      this.win.contentView.removeChildView(tab.view);
      this.attached = null;
    }
    tab.view.webContents.close();
    if (this.activeId === id) this.activeId = this.order[Math.min(idx, this.order.length - 1)] ?? null;
    if (this.order.length === 0) this.create();
    this.loadPendingIfShown();
    this.layout();
    this.changed();
  }

  closeOthers(id: number) {
    for (const other of this.order.filter((x) => x !== id)) this.close(other);
  }

  closeToRight(id: number) {
    const i = this.order.indexOf(id);
    if (i < 0) return;
    for (const other of this.order.slice(i + 1)) this.close(other);
  }

  reopenClosed() {
    const e = this.closed.pop();
    if (e) this.create(e.url, true);
    else this.changed();
  }

  duplicate(id: number) {
    const e = this.entryOf(id);
    if (!e) return;
    const i = this.order.indexOf(id);
    const tab = this.newTab(i + 1);
    this.activeId = tab.id;
    if (this.locked) tab.pending = e;
    else this.navigate(tab.id, e.url);
    this.layout();
    this.changed();
  }

  newTabRightOf(id: number) {
    const i = this.order.indexOf(id);
    const tab = this.newTab(i < 0 ? this.order.length : i + 1);
    this.activeId = tab.id;
    this.layout();
    this.changed();
  }

  move(id: number, toIndex: number) {
    const from = this.order.indexOf(id);
    if (from < 0) return;
    this.order.splice(from, 1);
    this.order.splice(Math.max(0, Math.min(toIndex, this.order.length)), 0, id);
    this.changed();
  }

  activate(id: number) {
    if (!this.tabs.has(id)) return;
    this.activeId = id;
    this.loadPendingIfShown();
    this.layout();
    this.changed();
  }

  cycle(step: number) {
    if (this.activeId === null || this.order.length < 2) return;
    const i = this.order.indexOf(this.activeId);
    this.activate(this.order[(i + step + this.order.length) % this.order.length]);
  }

  navigate(id: number, input: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (this.locked) throw new Error('браузер заблокирован: сначала подключите туннель');
    const url = inputToUrl(input);
    tab.pending = undefined;
    tab.started = true;
    tab.error = undefined;
    this.layout();
    this.load(tab, url);
    this.changed();
  }

  withTab(id: number, fn: (wc: WebContents) => void) {
    const tab = this.tabs.get(id);
    if (tab && !tab.pending) fn(tab.view.webContents);
  }

  reload(id: number) {
    const tab = this.tabs.get(id);
    if (!tab || this.locked) return;
    if (tab.pending) {
      this.activate(id);
      return;
    }
    if (!tab.started || !this.guard.isReady(tab.view.webContents.id)) return;
    tab.error = undefined;
    tab.view.webContents.reload();
    this.layout();
  }

  setBounds(r: Rectangle) {
    this.bounds = {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.max(0, Math.round(r.width)),
      height: Math.max(0, Math.round(r.height)),
    };
    this.layout();
  }

  setOverlay(open: boolean) {
    this.overlay = open;
    this.layout();
  }

  setLocked(locked: boolean) {
    if (this.locked === locked) return;
    this.locked = locked;
    if (locked) {
      for (const p of this.popups) if (!p.isDestroyed()) p.close();
      for (const t of this.tabs.values()) if (!t.view.webContents.isDestroyed()) t.view.webContents.stop();
    } else {
      // Pages that failed while the tunnel was down get another try.
      for (const t of this.tabs.values()) {
        if (t.started && t.error && this.guard.isReady(t.view.webContents.id)) {
          t.error = undefined;
          t.view.webContents.reload();
        }
      }
      this.loadPendingIfShown();
    }
    this.layout();
    this.changed();
  }

  /** Attach exactly the one view that should be visible, or none. */
  private layout() {
    if (this.win.isDestroyed()) return;
    const tab = this.activeId === null ? undefined : this.tabs.get(this.activeId);
    const visible =
      !this.locked && !this.overlay && tab && tab.started && !tab.pending && !tab.error && this.bounds.width > 0;
    const want = visible ? tab.view : null;
    if (this.attached && this.attached !== want) {
      this.win.contentView.removeChildView(this.attached);
      this.attached = null;
      // Repaint the UI under it now, so the page's last frame cannot linger on screen.
      if (!want) this.win.webContents.invalidate();
    }
    if (want) {
      if (this.attached !== want) {
        this.win.contentView.addChildView(want);
        this.attached = want;
      }
      want.setBounds(this.bounds);
    }
  }

  destroyAll() {
    for (const p of this.popups) p.destroy();
    for (const t of this.tabs.values()) t.view.webContents.close();
    this.tabs.clear();
    this.order = [];
  }
}
