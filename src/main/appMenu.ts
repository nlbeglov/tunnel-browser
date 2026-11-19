// The ⋮ menu. A native popup menu opens to the right of the point it is given and its width
// is unknown beforehand, so it cannot be aligned to the button's right edge the way Chrome's
// menu is. This one is a page of its own (renderer/menu.html) in a transparent view laid over
// the whole window, above the web page: the menu sits under the button and opens leftwards,
// a click anywhere else or Esc closes it.

import { BrowserWindow, WebContentsView } from 'electron';
import type { AppMenuEntry } from '../shared/types';

export class AppMenu {
  private view: WebContentsView | null = null;
  private loaded: Promise<unknown> | null = null;
  private act: ((id: string) => void) | null = null;
  private shown = false;

  constructor(
    private readonly win: BrowserWindow,
    private readonly url: string,
    private readonly preload: string,
  ) {
    // Like any menu: gone when the window loses focus or changes size.
    win.on('blur', () => this.hide());
    win.on('resize', () => this.hide());
    win.on('closed', () => {
      if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    });
  }

  get isOpen(): boolean {
    return this.shown;
  }

  private ensure(): Promise<unknown> {
    if (this.view && this.loaded) return this.loaded;
    const view = new WebContentsView({
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    view.setBackgroundColor('#00000000');
    const wc = view.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.ipc.on('menu:choose', (_e, id: unknown) => {
      const act = this.act;
      this.hide();
      if (typeof id === 'string') act?.(id);
    });
    wc.ipc.on('menu:close', () => this.hide());
    this.view = view;
    this.loaded = wc.loadURL(this.url);
    return this.loaded;
  }

  async show(at: { right: number; top: number }, items: AppMenuEntry[], act: (id: string) => void) {
    await this.ensure();
    const view = this.view;
    if (!view || this.win.isDestroyed()) return;
    this.act = act;
    const [width, height] = this.win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
    this.win.contentView.addChildView(view); // the topmost view: above the page
    this.shown = true;
    view.webContents.send('menu:show', { items, right: at.right, top: at.top });
    view.webContents.focus();
  }

  /** A page view was just attached: keep the open menu above it. */
  raise() {
    if (this.shown && this.view) this.win.contentView.addChildView(this.view);
  }

  hide() {
    if (!this.shown || !this.view || this.win.isDestroyed()) return;
    this.shown = false;
    this.act = null;
    this.win.contentView.removeChildView(this.view);
    this.win.webContents.focus();
  }
}
