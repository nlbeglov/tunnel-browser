// The panels under toolbar buttons: the ⋮ menu, the connection panel under the IP, bookmarks.
// A native popup menu opens to the right of the point it is given and cannot hold anything
// but items, and the web page is a view above the UI, so these are a page of their own
// (renderer/popup.html) in a transparent view laid over the whole window, above the page. The
// panel sits under its button and opens leftwards; a click anywhere else or Esc closes it.

import { BrowserWindow, WebContentsView } from 'electron';
import type { PopupData, PopupKind, PopupShow } from '../shared/types';

export type PopupAct = (id: string, arg: unknown) => unknown;

export class Popup {
  private view: WebContentsView | null = null;
  private loaded: Promise<unknown> | null = null;
  private act: PopupAct | null = null;
  private current: PopupKind | null = null;

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

  /** The panel that is open, if any. */
  get kind(): PopupKind | null {
    return this.current;
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
    wc.ipc.handle('popup:act', async (_e, id: unknown, arg: unknown) => {
      if (typeof id !== 'string' || !this.act) return undefined;
      return this.act(id, arg);
    });
    wc.ipc.on('popup:close', () => this.hide());
    this.view = view;
    this.loaded = wc.loadURL(this.url);
    return this.loaded;
  }

  async show(at: { right: number; top: number }, content: PopupData, act: PopupAct) {
    await this.ensure();
    const view = this.view;
    if (!view || this.win.isDestroyed()) return;
    this.act = act;
    this.current = content.kind;
    const [width, height] = this.win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
    this.win.contentView.addChildView(view); // the topmost view: above the page
    view.webContents.send('popup:show', { ...content, right: at.right, top: at.top } satisfies PopupShow);
    view.webContents.focus();
  }

  /** New data for the open panel (the tunnel changed, a bookmark was added). */
  update(content: PopupData) {
    if (this.current !== content.kind || !this.view) return;
    this.view.webContents.send('popup:data', content);
  }

  /** A page view was just attached: keep the open panel above it. */
  raise() {
    if (this.current && this.view) this.win.contentView.addChildView(this.view);
  }

  hide() {
    if (!this.current || !this.view || this.win.isDestroyed()) return;
    this.current = null;
    this.act = null;
    this.win.contentView.removeChildView(this.view);
    this.win.webContents.focus();
  }
}
