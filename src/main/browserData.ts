// Browser data: settings, the window profiles and, per profile, its bookmarks, last session's
// tabs and last exit. Kept apart from the servers file and encrypted the same way: the
// history of visited sites is private too. Data from before profiles becomes the first
// profile (windowProfiles.ts).

import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { Bookmark, BookmarksState, BrowserSettings } from '../shared/types';
import { MAX_BOOKMARKS, cleanTitle, findByUrl, moveItem, normalizeBookmarkUrl } from './bookmarks';
import { EncryptedJsonFile } from './encryptedFile';
import {
  DEFAULT_SETTINGS,
  MAX_PROFILES,
  cleanProfileName,
  freeColors,
  isProfileColor,
  migrate,
  newPartition,
  upgradeServerKeys,
  type BrowserDataV2,
  type ProfileRecord,
  type SessionTab,
} from './windowProfiles';

export type { SessionTab } from './windowProfiles';

/** Bookmarks keep the site's icon when it is small; bigger ones are not stored. */
const MAX_ICON_CHARS = 48_000;

export class BrowserData extends EventEmitter<{
  bookmarks: [profileId: string, state: BookmarksState];
  settings: [BrowserSettings];
  profiles: [];
}> {
  private data: BrowserDataV2 = migrate(undefined, () => undefined);
  private readonly file: EncryptedJsonFile<BrowserDataV2>;

  constructor(onError?: (message: string) => void) {
    super();
    this.file = new EncryptedJsonFile<BrowserDataV2>(join(app.getPath('userData'), 'browser.dat'), 'закладки и вкладки', onError);
  }

  /**
   * `linkOf` maps a server id of the old format to its link, `keyOf` a link to the server's
   * key (migration only).
   */
  async load(
    linkOf: (serverId: string | undefined) => string | undefined,
    keyOf: (link: string) => { key: string; name: string } | undefined,
  ): Promise<void> {
    const r = await this.file.read();
    const before = JSON.stringify(r?.data ?? null);
    this.data = upgradeServerKeys(migrate(r?.data, linkOf), keyOf);
    if (r && (r.reEncrypt || JSON.stringify(this.data) !== before)) this.file.write(this.data);
  }

  flush(): Promise<void> {
    return this.file.flush();
  }

  private save(what: 'settings' | 'profiles' | 'quiet' | { bookmarks: string }) {
    if (what === 'settings') {
      this.emit('settings', this.settings());
      for (const p of this.data.profiles) this.emit('bookmarks', p.id, this.bookmarksState(p.id));
    } else if (what === 'profiles') this.emit('profiles');
    else if (typeof what === 'object') this.emit('bookmarks', what.bookmarks, this.bookmarksState(what.bookmarks));
    this.file.write(this.data);
  }

  // ---- settings (all windows)

  settings(): BrowserSettings {
    return { ...this.data.settings };
  }

  setSettings(patch: Partial<BrowserSettings>): BrowserSettings {
    const next = { ...this.data.settings };
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof BrowserSettings>) {
      if (typeof patch[key] === 'boolean') next[key] = patch[key];
    }
    this.data.settings = next;
    if (!next.restoreTabs) for (const p of this.data.profiles) delete p.session;
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

  // ---- profiles

  profiles(): ProfileRecord[] {
    return this.data.profiles;
  }

  profile(id: string): ProfileRecord {
    const p = this.data.profiles.find((x) => x.id === id);
    if (!p) throw new Error('профиль не найден');
    return p;
  }

  createProfile(input: { name: unknown; color: unknown; server?: { key: string; name: string } }): ProfileRecord {
    if (this.data.profiles.length >= MAX_PROFILES) throw new Error(`профилей может быть не больше ${MAX_PROFILES}`);
    const name = cleanProfileName(input.name);
    if (this.data.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error('профиль с таким названием уже есть');
    if (!isProfileColor(input.color)) throw new Error('выберите цвет из предложенных');
    if (!freeColors(this.data.profiles).includes(input.color.toLowerCase())) throw new Error('этот цвет уже у другого профиля');
    const id = randomUUID();
    const p: ProfileRecord = {
      id,
      name,
      color: input.color.toLowerCase(),
      partition: newPartition(id),
      serverKey: input.server?.key,
      serverName: input.server?.name,
      bookmarks: [],
      createdAt: Date.now(),
    };
    this.data.profiles.push(p);
    this.save('profiles');
    return p;
  }

  updateProfile(id: string, patch: { name?: unknown; color?: unknown }) {
    const p = this.profile(id);
    if (patch.name !== undefined) {
      const name = cleanProfileName(patch.name);
      if (this.data.profiles.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('профиль с таким названием уже есть');
      }
      p.name = name;
    }
    if (patch.color !== undefined) {
      if (!isProfileColor(patch.color)) throw new Error('выберите цвет из предложенных');
      const color = patch.color.toLowerCase();
      if (this.data.profiles.some((x) => x.id !== id && x.color === color)) throw new Error('этот цвет уже у другого профиля');
      p.color = color;
    }
    this.save('profiles');
  }

  /** The caller wipes the profile's storage; the last profile cannot go. */
  removeProfile(id: string): ProfileRecord {
    if (this.data.profiles.length <= 1) throw new Error('последний профиль удалить нельзя');
    const p = this.profile(id);
    this.data.profiles = this.data.profiles.filter((x) => x.id !== id);
    this.data.openProfiles = this.data.openProfiles.filter((x) => x !== id);
    this.save('profiles');
    return p;
  }

  get openProfiles(): string[] {
    return this.data.openProfiles.filter((id) => this.data.profiles.some((p) => p.id === id));
  }

  set openProfiles(ids: string[]) {
    if (JSON.stringify(ids) === JSON.stringify(this.data.openProfiles)) return;
    this.data.openProfiles = [...ids];
    this.save('quiet');
  }

  /** The profile's server (its key, and its name for when it disappears). */
  setServer(id: string, server: { key: string; name: string }) {
    const p = this.profile(id);
    if (p.serverKey === server.key && p.serverName === server.name) return;
    p.serverKey = server.key;
    p.serverName = server.name;
    this.save('profiles');
  }

  setLastExit(id: string, exit: { ip?: string; country?: string; serverKey?: string }) {
    const p = this.profile(id);
    const next = {
      lastExitIp: exit.ip && exit.ip !== '?' ? exit.ip : p.lastExitIp,
      lastExitCountry: exit.ip && exit.ip !== '?' ? exit.country : p.lastExitCountry,
      lastServerKey: exit.serverKey ?? p.lastServerKey,
    };
    if (next.lastExitIp === p.lastExitIp && next.lastExitCountry === p.lastExitCountry && next.lastServerKey === p.lastServerKey) return;
    Object.assign(p, next);
    this.save('quiet');
  }

  // ---- bookmarks (per profile)

  bookmarksState(profileId: string): BookmarksState {
    return { items: this.profile(profileId).bookmarks, showBar: this.data.settings.showBookmarksBar };
  }

  bookmark(profileId: string, id: string): Bookmark | undefined {
    return this.profile(profileId).bookmarks.find((b) => b.id === id);
  }

  byUrl(profileId: string, url: string): Bookmark | undefined {
    return findByUrl(this.profile(profileId).bookmarks, url);
  }

  /** Adding a page that is already bookmarked returns the existing bookmark. */
  addBookmark(profileId: string, rawUrl: string, title: string, icon?: string): Bookmark {
    const p = this.profile(profileId);
    const url = normalizeBookmarkUrl(rawUrl);
    const existing = findByUrl(p.bookmarks, url);
    if (existing) return existing;
    if (p.bookmarks.length >= MAX_BOOKMARKS) throw new Error('слишком много закладок');
    const b: Bookmark = { id: randomUUID(), url, title: cleanTitle(title, url), createdAt: Date.now() };
    if (icon && icon.length <= MAX_ICON_CHARS) b.icon = icon;
    p.bookmarks.push(b);
    this.save({ bookmarks: profileId });
    return b;
  }

  removeBookmark(profileId: string, id: string) {
    const p = this.profile(profileId);
    p.bookmarks = p.bookmarks.filter((b) => b.id !== id);
    this.save({ bookmarks: profileId });
  }

  updateBookmark(profileId: string, id: string, patch: { title?: string; url?: string }) {
    const b = this.bookmark(profileId, id);
    if (!b) throw new Error('закладка не найдена');
    const url = patch.url !== undefined ? normalizeBookmarkUrl(patch.url) : b.url;
    const title = patch.title !== undefined ? cleanTitle(patch.title, url) : b.title;
    if (url !== b.url) delete b.icon;
    Object.assign(b, { url, title });
    this.save({ bookmarks: profileId });
  }

  moveBookmark(profileId: string, id: string, toIndex: number) {
    const p = this.profile(profileId);
    const from = p.bookmarks.findIndex((b) => b.id === id);
    p.bookmarks = moveItem(p.bookmarks, from, toIndex);
    this.save({ bookmarks: profileId });
  }

  /** A page's icon became known: bookmarks of that page show it from now on. */
  setBookmarkIcon(profileId: string, url: string, icon: string) {
    if (icon.length > MAX_ICON_CHARS) return;
    const b = this.byUrl(profileId, url);
    if (!b || b.icon === icon) return;
    b.icon = icon;
    this.save({ bookmarks: profileId });
  }

  // ---- last session's tabs (per profile)

  session(profileId: string): { tabs: SessionTab[]; activeIndex: number } | undefined {
    return this.data.settings.restoreTabs ? this.profile(profileId).session : undefined;
  }

  saveSession(profileId: string, tabs: SessionTab[], activeIndex: number) {
    if (!this.data.settings.restoreTabs) return;
    const p = this.data.profiles.find((x) => x.id === profileId);
    if (!p) return;
    const clean = tabs
      .filter((t) => /^https?:\/\//i.test(t.url))
      .slice(0, 200)
      .map((t) => ({ url: t.url.slice(0, 8000), title: t.title.slice(0, 300) }));
    const prev = JSON.stringify(p.session ?? null);
    const next = { tabs: clean, activeIndex: Math.max(0, Math.min(activeIndex, clean.length - 1)) };
    if (JSON.stringify(next) === prev) return;
    p.session = next;
    this.save('quiet');
  }
}
