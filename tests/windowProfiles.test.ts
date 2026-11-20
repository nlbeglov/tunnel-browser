// Window profiles: data from before profiles becomes the first profile with everything it
// had, colours stay unique, and the site-icon checks.

import { describe, expect, it } from 'vitest';
import { fetchableIconUrl, iconType } from '../src/main/favicon';
import { findServer, isSameServer, parseLink, serverKey, serverKeyOfLink } from '../src/main/links';
import {
  FIRST_PARTITION,
  FIRST_PROFILE_ID,
  PROFILE_COLORS,
  cleanProfileName,
  freeColors,
  isProfileColor,
  migrate,
  newPartition,
  upgradeServerKeys,
} from '../src/main/windowProfiles';
import { LINKS, UUID } from './fixtures';

describe('migration from one window to profiles', () => {
  const v1 = {
    version: 1,
    bookmarks: [{ id: 'b1', title: 'Почта', url: 'https://mail.example.com/', createdAt: 1 }],
    settings: { restoreTabs: true, showBookmarksBar: false },
    session: { tabs: [{ url: 'https://news.example.org/', title: 'Новости' }], activeIndex: 0 },
    lastServerId: 'old-id',
    lastExitIp: '198.51.100.23',
    declinedMoveToApplications: true,
  };
  const links: Record<string, string> = { 'old-id': 'vless://old', selected: 'vless://selected' };

  it('everything becomes the first profile, on the storage it always used', () => {
    const d = migrate(v1, (id) => links[id ?? 'selected']);
    expect(d.version).toBe(2);
    expect(d.profiles).toHaveLength(1);
    const p = d.profiles[0];
    // Same Chromium partition: cookies and logins are still there.
    expect(p).toMatchObject({ id: FIRST_PROFILE_ID, name: 'Основной', partition: FIRST_PARTITION, color: PROFILE_COLORS[0] });
    expect(p.bookmarks).toEqual(v1.bookmarks);
    expect(p.session).toEqual(v1.session);
    expect(p.lastExitIp).toBe('198.51.100.23');
    // Server ids change when a subscription refreshes, links do not.
    expect(p.lastServerLink).toBe('vless://old');
    expect(p.serverLink).toBe('vless://selected');
    expect(d.settings).toEqual({ restoreTabs: true, showBookmarksBar: false, warnOnServerSwitch: true, bookmarksHint: true });
    expect(d.openProfiles).toEqual([FIRST_PROFILE_ID]);
    expect(d.declinedMoveToApplications).toBe(true);
  });

  it('a first start gets one empty profile', () => {
    const d = migrate(undefined, () => undefined);
    expect(d.profiles.map((p) => p.name)).toEqual(['Основной']);
    expect(d.profiles[0].bookmarks).toEqual([]);
  });

  it('version 2 is read as it is', () => {
    const once = migrate(v1, (id) => links[id ?? 'selected']);
    once.profiles.push({ ...once.profiles[0], id: 'x', name: 'Работа', color: PROFILE_COLORS[1], partition: newPartition('x') });
    expect(migrate(JSON.parse(JSON.stringify(once)), () => 'unused')).toEqual(once);
  });
});

describe("a profile's server", () => {
  // What providers do on every refresh: the name carries the traffic left.
  const before = `${LINKS.vlessReality.split('#')[0]}#${encodeURIComponent('🇳🇱 NL | 120 GB left')}`;
  const after = `${LINKS.vlessReality.split('#')[0]}#${encodeURIComponent('🇳🇱 NL | 119.5 GB left')}`;

  it('is the same server when only its name changed', () => {
    expect(serverKey(parseLink(before))).toBe(serverKey(parseLink(after)));
    // ids are random per parse, links differ: neither can identify it
    expect(parseLink(before).link).not.toBe(parseLink(after).link);
  });

  it('is another server when anything of the connection changed', () => {
    const otherUser = before.replace(UUID, 'aaaaaaaa-7350-4ed6-829b-d32f7fb9a2b6');
    const otherPort = before.replace(':443?', ':8443?');
    for (const l of [otherUser, otherPort, LINKS.trojan]) expect(serverKey(parseLink(l))).not.toBe(serverKey(parseLink(before)));
  });

  it('is still the same server when the provider picks another Reality short id, spiderX or fingerprint', () => {
    // What many provider panels do on every subscription download: the server is the same.
    const stored = serverKey(parseLink(before));
    const redrawn = parseLink(after.replace('sid=6ba85179e30d4fc2', 'sid=a1b2').replace('spx=%2F', 'spx=%2Fxyz').replace('fp=chrome', 'fp=firefox'));
    expect(serverKey(redrawn)).not.toBe(stored);
    expect(findServer([parseLink(LINKS.trojan), redrawn], stored)).toBe(redrawn);
    expect(isSameServer(stored, redrawn)).toBe(true);
  });

  it('the exact settings win over the same server with changed details', () => {
    const stored = serverKey(parseLink(before));
    const changed = parseLink(before.replace('sid=6ba85179e30d4fc2', 'sid=a1b2'));
    const exact = parseLink(after);
    expect(findServer([changed, exact], stored)).toBe(exact);
  });

  it('another address, port or user is another server: none is picked for the profile', () => {
    const stored = serverKey(parseLink(before));
    const others = [
      before.replace('nl1.example.com', 'nl2.example.com'),
      before.replace(':443?', ':8443?'),
      before.replace(UUID, 'aaaaaaaa-7350-4ed6-829b-d32f7fb9a2b6'),
    ].map((l) => parseLink(l));
    expect(findServer(others, stored)).toBeUndefined();
    expect(findServer([parseLink(LINKS.trojan)], stored)).toBeUndefined();
    expect(findServer([parseLink(before)], undefined)).toBeUndefined();
  });

  it('0.4.0 profiles kept the server by link: they get its key, even if it was renamed since', () => {
    const d = migrate(undefined, () => undefined);
    d.profiles[0].serverLink = before;
    d.profiles[0].lastServerLink = before;
    upgradeServerKeys(d, serverKeyOfLink);
    expect(d.profiles[0].serverKey).toBe(serverKey(parseLink(after)));
    expect(d.profiles[0].serverName).toBe('🇳🇱 NL | 120 GB left');
    expect(d.profiles[0].lastServerKey).toBe(d.profiles[0].serverKey);
    expect(d.profiles[0].serverLink).toBeUndefined();
  });

  it('a link that cannot be read leaves the profile without a server, not with a guessed one', () => {
    const d = migrate(undefined, () => undefined);
    d.profiles[0].serverLink = 'garbage';
    upgradeServerKeys(d, serverKeyOfLink);
    expect(d.profiles[0].serverKey).toBeUndefined();
  });
});

describe('profile colours and names', () => {
  it('a colour in use is not offered again', () => {
    expect(freeColors([{ color: PROFILE_COLORS[0] }, { color: PROFILE_COLORS[2].toUpperCase() }])).toEqual(
      PROFILE_COLORS.filter((_, i) => i !== 0 && i !== 2),
    );
  });

  it('only palette colours', () => {
    expect(isProfileColor(PROFILE_COLORS[3])).toBe(true);
    expect(isProfileColor('#123456')).toBe(false);
    expect(isProfileColor(5)).toBe(false);
  });

  it('names are trimmed and required', () => {
    expect(cleanProfileName('  Работа   и   дом ')).toBe('Работа и дом');
    expect(() => cleanProfileName('   ')).toThrow();
    expect(cleanProfileName('x'.repeat(100))).toHaveLength(40);
  });

  it('every new profile has its own storage', () => {
    expect(newPartition('a')).not.toBe(newPartition('b'));
    expect(newPartition('a')).toMatch(/^persist:/);
  });
});

describe('site icons', () => {
  const bytes = (...b: number[]) => Uint8Array.from(b);
  const text = (s: string) => new TextEncoder().encode(s);

  it.each([
    ['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a), 'image/png'],
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    ['gif', text('GIF89a'), 'image/gif'],
    ['webp', text('RIFF\0\0\0\0WEBPVP8 '), 'image/webp'],
    ['ico', bytes(0, 0, 1, 0, 1, 0), 'image/x-icon'],
    ['svg', text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'],
    ['svg with a comment', text('<!-- logo --><svg viewBox="0 0 1 1"/>'), 'image/svg+xml'],
  ])('%s is recognised by its bytes', (_n, buf, type) => expect(iconType(buf)).toBe(type));

  it.each([
    ['an HTML error page', text('<!doctype html><html><body>404</body></html>')],
    ['JSON', text('{"error":"not found"}')],
    ['empty', bytes()],
  ])('%s is not an icon', (_n, buf) => expect(iconType(buf)).toBeNull());

  it('only web addresses or embedded images are fetched', () => {
    expect(fetchableIconUrl('https://example.com/favicon.ico')).toBe('web');
    expect(fetchableIconUrl('data:image/png;base64,AAAA')).toBe('data');
    expect(fetchableIconUrl('data:text/html,<script>')).toBeNull();
    expect(fetchableIconUrl('file:///etc/passwd')).toBeNull();
    expect(fetchableIconUrl('chrome://favicon/x')).toBeNull();
  });
});
