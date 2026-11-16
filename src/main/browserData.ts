// Browser data: bookmarks, settings and the last session's tabs. Kept apart from the
// servers file and encrypted the same way: the history of visited sites is private too.

import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { Bookmark, BookmarksState, BrowserSettings } from '../shared/types';
import { MAX_BOOKMARKS, cleanTitle, findByUrl, moveItem, normalizeBookmarkUrl } from './bookmarks';
import { EncryptedJsonFile } from './encryptedFile';

export interface SessionTab {
  url: string;
  title: string;
}

interface Data {
  version: 1;
  bookmarks: Bookmark[];
  settings: BrowserSettings;
  session?: { tabs: SessionTab[]; activeIndex: number };
  /** the user said no to "move to Applications" (macOS) */
  declinedMoveToApplications?: boolean;
  /** the server of the last working connection: switching away from it means a new IP */
  lastServerId?: string;
}

const DEFAULTS: Data = { version: 1, bookmarks: [], settings: { restoreTabs: true, showBookmarksBar: true, warnOnServerSwitch: true } };

export class BrowserData extends EventEmitter<{ bookmarks: [BookmarksState]; settings: [BrowserSettings] }> {
  private data: Data = structuredClone(DEFAULTS);
  private readonly file: EncryptedJsonFile<Data>;

  constructor(onError?: (message: string) => void) {
    super();
    this.file = new EncryptedJsonFile<Data>(join(app.getPath('userData'), 'browser.dat'), 'закладки и вкладки', onError);
  }

  async load(): Promise<void> {
    const r = await this.file.read();
    if (!r) return;
    this.data = { ...structuredClone(DEFAULTS), ...r.data, settings: { ...DEFAULTS.settings, ...r.data.settings } };
    if (r.reEncrypt) this.file.write(this.data);
  }

  flush(): Promise<void> {
    return this.file.flush();
  }

  private save(what: 'bookmarks' | 'settings' | 'quiet') {
    if (what === 'bookmarks') this.emit('bookmarks', this.bookmarksState());
    if (what === 'settings') {
      this.emit('settings', this.settings());
      this.emit('bookmarks', this.bookmarksState());
    }
    this.file.write(this.data);
  }

  // ---- bookmarks

  bookmarksState(): BookmarksState {
    return { items: this.data.bookmarks, showBar: this.data.settings.showBookmarksBar };
  }

  bookmark(id: string): Bookmark | undefined {
    return this.data.bookmarks.find((b) => b.id === id);
  }

  byUrl(url: string): Bookmark | undefined {
    return findByUrl(this.data.bookmarks, url);
  }

  /** Adding a page that is already bookmarked returns the existing bookmark. */
  addBookmark(rawUrl: string, title: string): Bookmark {
    const url = normalizeBookmarkUrl(rawUrl);
    const existing = this.byUrl(url);
    if (existing) return existing;
    if (this.data.bookmarks.length >= MAX_BOOKMARKS) throw new Error('слишком много закладок');
    const b: Bookmark = { id: randomUUID(), url, title: cleanTitle(title, url), createdAt: Date.now() };
    this.data.bookmarks.push(b);
    this.save('bookmarks');
    return b;
  }

  removeBookmark(id: string) {
    this.data.bookmarks = this.data.bookmarks.filter((b) => b.id !== id);
    this.save('bookmarks');
  }

  updateBookmark(id: string, patch: { title?: string; url?: string }) {
    const b = this.bookmark(id);
    if (!b) throw new Error('закладка не найдена');
    const url = patch.url !== undefined ? normalizeBookmarkUrl(patch.url) : b.url;
    const title = patch.title !== undefined ? cleanTitle(patch.title, url) : b.title;
    Object.assign(b, { url, title });
    this.save('bookmarks');
  }

  moveBookmark(id: string, toIndex: number) {
    const from = this.data.bookmarks.findIndex((b) => b.id === id);
    this.data.bookmarks = moveItem(this.data.bookmarks, from, toIndex);
    this.save('bookmarks');
  }

  // ---- settings

  settings(): BrowserSettings {
    return { ...this.data.settings };
  }

  setSettings(patch: Partial<BrowserSettings>): BrowserSettings {
    const next = { ...this.data.settings };
    if (typeof patch.restoreTabs === 'boolean') next.restoreTabs = patch.restoreTabs;
    if (typeof patch.showBookmarksBar === 'boolean') next.showBookmarksBar = patch.showBookmarksBar;
    if (typeof patch.warnOnServerSwitch === 'boolean') next.warnOnServerSwitch = patch.warnOnServerSwitch;
    this.data.settings = next;
    if (!next.restoreTabs) delete this.data.session;
    this.save('settings');
    return this.settings();
  }

  get declinedMoveToApplications(): boolean {
    return this.data.declinedMoveToApplications === true;
  }

  set declinedMoveToApplications(v: boolean) {
    this.data.declinedMoveToApplications = v;
    this.save('quiet');
  }

  get lastServerId(): string | undefined {
    return this.data.lastServerId;
  }

  set lastServerId(id: string | undefined) {
    if (this.data.lastServerId === id) return;
    this.data.lastServerId = id;
    this.save('quiet');
  }

  // ---- session

  session(): { tabs: SessionTab[]; activeIndex: number } | undefined {
    return this.data.settings.restoreTabs ? this.data.session : undefined;
  }

  saveSession(tabs: SessionTab[], activeIndex: number) {
    if (!this.data.settings.restoreTabs) return;
    const clean = tabs
      .filter((t) => /^https?:\/\//i.test(t.url))
      .slice(0, 200)
      .map((t) => ({ url: t.url.slice(0, 8000), title: t.title.slice(0, 300) }));
    const prev = JSON.stringify(this.data.session ?? null);
    const next = { tabs: clean, activeIndex: Math.max(0, Math.min(activeIndex, clean.length - 1)) };
    if (JSON.stringify(next) === prev) return;
    this.data.session = next;
    this.save('quiet');
  }
}
