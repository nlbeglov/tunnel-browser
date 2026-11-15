// Pure bookmark helpers. No Electron imports: unit-tested.

import type { Bookmark } from '../shared/types';

export const MAX_BOOKMARKS = 5000;
const MAX_TITLE = 300;
const MAX_URL = 8000;

/** Only http(s) can be bookmarked: anything else could not be opened in the browser anyway. */
export function normalizeBookmarkUrl(raw: string): string {
  const s = raw.trim();
  if (!s || s.length > MAX_URL) throw new Error('некорректный адрес');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('некорректный адрес');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('в закладки можно добавить только сайт (http или https)');
  return u.toString();
}

export function cleanTitle(title: string, url: string): string {
  const t = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  if (t) return t;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, MAX_TITLE);
  }
}

/** Same page, ignoring a trailing slash and the #fragment, as Chrome's star does. */
export function sameUrl(a: string, b: string): boolean {
  const norm = (x: string) => {
    try {
      const u = new URL(x);
      u.hash = '';
      return u.toString().replace(/\/$/, '');
    } catch {
      return x;
    }
  };
  return norm(a) === norm(b);
}

export function findByUrl(items: Bookmark[], url: string): Bookmark | undefined {
  return items.find((b) => sameUrl(b.url, url));
}

/** Moves the item at `from` so that it ends up at index `to` (clamped). Returns a new array. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return items;
  const out = items.slice();
  const [it] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, it);
  return out;
}
