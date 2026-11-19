// Window profiles: each window of the browser is one profile with its own name, colour,
// server and Chromium storage, so sites cannot tell that two windows are the same person.
// Pure data and migration rules. No Electron imports: unit-tested.

import type { Bookmark, BrowserSettings } from '../shared/types';

export interface SessionTab {
  url: string;
  title: string;
}

export interface ProfileRecord {
  id: string;
  name: string;
  /** one of PROFILE_COLORS: the window's tab strip, its badge and its taskbar icon */
  color: string;
  /** Chromium storage of this profile's pages (cookies, logins, cache); never shared */
  partition: string;
  /**
   * The server this profile connects to, by its connection settings (links.ts serverKey):
   * ids are re-created and names change when a subscription refreshes.
   */
  serverKey?: string;
  /** that server's name when last seen, to name it if it disappears */
  serverName?: string;
  /** 0.4.0 kept the server by link (it broke when a provider renamed servers); read once */
  serverLink?: string;
  bookmarks: Bookmark[];
  session?: { tabs: SessionTab[]; activeIndex: number };
  /** what sites saw last time: a different IP is a new address for them */
  lastExitIp?: string;
  lastExitCountry?: string;
  /** the server of the last working connection, for when its IP was not known */
  lastServerKey?: string;
  /** 0.4.0 */
  lastServerLink?: string;
  createdAt: number;
}

export interface BrowserDataV2 {
  version: 2;
  settings: BrowserSettings;
  profiles: ProfileRecord[];
  /** profiles whose windows were open when the app last quit */
  openProfiles: string[];
  /** the user said no to "move to Applications" (macOS) */
  declinedMoveToApplications?: boolean;
}

/** Before profiles: one window, one storage. */
export interface BrowserDataV1 {
  version: 1;
  bookmarks: Bookmark[];
  settings: Partial<BrowserSettings>;
  session?: { tabs: SessionTab[]; activeIndex: number };
  declinedMoveToApplications?: boolean;
  lastServerId?: string;
  lastExitIp?: string;
}

export const DEFAULT_SETTINGS: BrowserSettings = { restoreTabs: true, showBookmarksBar: true, warnOnServerSwitch: true, bookmarksHint: true };

/** The storage every version before profiles used: the first profile keeps it, cookies and all. */
export const FIRST_PARTITION = 'persist:tunnel';
export const FIRST_PROFILE_ID = 'main';
export const MAX_PROFILES = 12;

/**
 * Window colours. Neighbours differ in lightness as well as hue, so two windows stay apart
 * for colour-blind people too. A colour in use is not offered to a new profile.
 */
export const PROFILE_COLORS = ['#2457d6', '#f2a33a', '#0f766e', '#be123c', '#7c3aed', '#facc15', '#16a34a', '#64748b'] as const;

export function newPartition(id: string): string {
  return `persist:profile-${id}`;
}

export function freeColors(profiles: Array<{ color: string }>): string[] {
  const used = new Set(profiles.map((p) => p.color.toLowerCase()));
  return PROFILE_COLORS.filter((c) => !used.has(c));
}

export function isProfileColor(c: unknown): c is string {
  return typeof c === 'string' && (PROFILE_COLORS as readonly string[]).includes(c.toLowerCase());
}

export function cleanProfileName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('укажите название профиля');
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!name) throw new Error('укажите название профиля');
  return name;
}

/**
 * Servers kept by link (0.4.0, and the migration below) get their key. The link itself is
 * parsed, so a server is still found after the provider renamed it.
 */
export function upgradeServerKeys(data: BrowserDataV2, keyOf: (link: string) => { key: string; name: string } | undefined): BrowserDataV2 {
  for (const p of data.profiles) {
    if (p.serverLink) {
      const k = keyOf(p.serverLink);
      if (k && !p.serverKey) {
        p.serverKey = k.key;
        p.serverName = k.name;
      }
      delete p.serverLink;
    }
    if (p.lastServerLink) {
      const k = keyOf(p.lastServerLink);
      if (k && !p.lastServerKey) p.lastServerKey = k.key;
      delete p.lastServerLink;
    }
  }
  return data;
}

/**
 * Data from before profiles becomes the first profile, "Основной": same storage (so its
 * cookies and logins stay), same bookmarks, last tabs and last exit. `linkOf` turns the old
 * server id into its link.
 */
export function migrate(raw: unknown, linkOf: (serverId: string | undefined) => string | undefined): BrowserDataV2 {
  const data = (raw ?? {}) as Partial<BrowserDataV2> & Partial<BrowserDataV1>;
  if (data.version === 2 && Array.isArray(data.profiles) && data.profiles.length) {
    return {
      version: 2,
      settings: { ...DEFAULT_SETTINGS, ...data.settings },
      profiles: data.profiles.map((p) => ({ ...p, bookmarks: Array.isArray(p.bookmarks) ? p.bookmarks : [] })),
      openProfiles: Array.isArray(data.openProfiles) ? data.openProfiles : [],
      declinedMoveToApplications: data.declinedMoveToApplications,
    };
  }
  const v1 = data as Partial<BrowserDataV1>;
  const first: ProfileRecord = {
    id: FIRST_PROFILE_ID,
    name: 'Основной',
    color: PROFILE_COLORS[0],
    partition: FIRST_PARTITION,
    serverLink: linkOf(undefined),
    bookmarks: Array.isArray(v1.bookmarks) ? v1.bookmarks : [],
    session: v1.session,
    lastExitIp: v1.lastExitIp,
    lastServerLink: v1.lastServerId ? linkOf(v1.lastServerId) : undefined,
    createdAt: Date.now(),
  };
  return {
    version: 2,
    settings: { ...DEFAULT_SETTINGS, ...v1.settings },
    profiles: [first],
    openProfiles: [FIRST_PROFILE_ID],
    declinedMoveToApplications: v1.declinedMoveToApplications,
  };
}
