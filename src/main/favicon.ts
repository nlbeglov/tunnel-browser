// Site icons. They are fetched in the page's own session, so through its tunnel and gate
// like the page itself (tabs.ts); this file only decides what a downloaded file is.
// No Electron imports: unit-tested.

/** Bigger downloads are not icons worth showing. */
export const MAX_ICON_BYTES = 512 * 1024;
/** Formats kept as they are (when the OS image decoder cannot shrink them) must be small. */
export const MAX_RAW_ICON_BYTES = 32 * 1024;

export type IconType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/x-icon' | 'image/svg+xml' | 'image/bmp';

/**
 * What the bytes are, by their signature rather than by what the server says: a site's
 * error page sent as "image/png" is not an icon. SVG is recognised by its root element.
 */
export function iconType(buf: Uint8Array): IconType | null {
  const b = (i: number) => buf[i] ?? -1;
  const ascii = (from: number, s: string) => [...s].every((c, i) => b(from + i) === c.charCodeAt(0));
  if (b(0) === 0x89 && ascii(1, 'PNG')) return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (b(0) === 0 && b(1) === 0 && (b(2) === 1 || b(2) === 2) && b(3) === 0) return 'image/x-icon';
  if (ascii(0, 'BM')) return 'image/bmp';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, 512)).replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Icon addresses worth fetching: web addresses, or an image the page embeds itself. */
export function fetchableIconUrl(raw: string): 'web' | 'data' | null {
  if (/^data:image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i.test(raw)) return 'data';
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? 'web' : null;
  } catch {
    return null;
  }
}
