// Browser tabs as WebContentsViews inside the main window. Every tab and popup lives in
// the tunnel session. While the tunnel is locked, no tab view is attached to the window.

import { BrowserWindow, Menu, WebContentsView, clipboard, type Rectangle, type Session, type WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import type { TabInfo, TabsState } from '../shared/types';
import { isWebUrl } from './guard';
import { inputToUrl, loadErrorText } from './url';

interface Tab {
  id: number;
  view: WebContentsView;
  /** false for a fresh tab that shows the start page */
  started: boolean;
  error?: string;
}

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

  constructor(
    private readonly win: BrowserWindow,
    private readonly ses: Session,
  ) {
    super();
  }

  state(): TabsState {
    return { tabs: this.order.map((id) => this.info(this.tabs.get(id)!)), activeId: this.activeId };
  }

  private info(t: Tab): TabInfo {
    const wc = t.view.webContents;
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

  create(input?: string, activate = true): number {
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
    const tab: Tab = { id: this.nextId++, view, started: false };
    this.tabs.set(tab.id, tab);
    const at = this.activeId === null ? -1 : this.order.indexOf(this.activeId);
    this.order.splice(at + 1, 0, tab.id);
    this.wire(tab);
    if (activate || this.activeId === null) this.activeId = tab.id;
    if (input) this.navigate(tab.id, input);
    this.layout();
    this.changed();
    return tab.id;
  }

  private wire(tab: Tab) {
    const wc = tab.view.webContents;
    const update = () => this.changed();
    wc.on('did-start-navigation', (d) => {
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
      if (!isMainFrame || code === -3) return; // -3: aborted by a new navigation
      tab.error = loadErrorText(code, desc);
      this.layout();
      update();
    });
    wc.on('render-process-gone', (_e, d) => {
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
    wc.on('did-create-window', (child) => {
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
    this.layout();
    this.changed();
  }

  activate(id: number) {
    if (!this.tabs.has(id)) return;
    this.activeId = id;
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
    tab.started = true;
    tab.error = undefined;
    this.layout();
    tab.view.webContents.loadURL(url).catch(() => {
      /* reported through did-fail-load */
    });
    this.changed();
  }

  withTab(id: number, fn: (wc: WebContents, tab: Tab) => void) {
    const tab = this.tabs.get(id);
    if (tab) fn(tab.view.webContents, tab);
  }

  reload(id: number) {
    this.withTab(id, (wc, tab) => {
      if (this.locked || !tab.started) return;
      tab.error = undefined;
      wc.reload();
      this.layout();
    });
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
      for (const p of this.popups) p.close();
      for (const t of this.tabs.values()) t.view.webContents.stop();
    } else {
      // Pages that failed while the tunnel was down get another try.
      for (const t of this.tabs.values()) {
        if (t.started && t.error) {
          t.error = undefined;
          t.view.webContents.reload();
        }
      }
    }
    this.layout();
    this.changed();
  }

  /** Attach exactly the one view that should be visible, or none. */
  private layout() {
    const tab = this.activeId === null ? undefined : this.tabs.get(this.activeId);
    const visible = !this.locked && !this.overlay && tab && tab.started && !tab.error && this.bounds.width > 0;
    const want = visible ? tab.view : null;
    if (this.attached && this.attached !== want) {
      this.win.contentView.removeChildView(this.attached);
      this.attached = null;
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
