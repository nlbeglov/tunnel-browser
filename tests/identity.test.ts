// What pages are told about the user's location, the DNS-leak reader, and the update route.

import { describe, expect, it } from 'vitest';
import { gateAllows, isServiceWorkerScript } from '../src/main/guard';
import { FALLBACK_ZONE, SITE_LANGUAGES, SITE_LOCALE, exitTimezone, identityFor, knownZones } from '../src/main/identity';
import { dnsLookups, type NetLog } from '../src/main/netlog';
import { COUNTRY_ZONE } from '../src/main/timezones';
import { isUpdateHost } from '../src/main/updateProxy';

describe('time zone of the exit', () => {
  it.each([
    ['NL', undefined, 'Europe/Amsterdam'],
    ['de', 'FRA', 'Europe/Berlin'],
    ['FI', 'HEL', 'Europe/Helsinki'],
    ['US', 'LAX', 'America/Los_Angeles'],
    ['US', 'ORD', 'America/Chicago'],
    ['US', 'IAD', 'America/New_York'],
    ['US', undefined, 'America/New_York'],
    ['US', 'XYZ', 'America/New_York'],
    ['RU', 'OVB', 'Asia/Novosibirsk'],
    ['RU', undefined, 'Europe/Moscow'],
    ['CA', 'YVR', 'America/Vancouver'],
    ['AU', 'PER', 'Australia/Perth'],
    ['KZ', 'ALA', 'Asia/Almaty'],
  ])('%s via %s -> %s', (cc, colo, tz) => expect(exitTimezone(cc, colo)).toBe(tz));

  it('a data centre abroad does not move the country', () => {
    // A US address answered by Toronto keeps a US zone.
    expect(exitTimezone('US', 'YYZ')).toBe('America/New_York');
  });

  it('unknown or broken country: UTC, never this computer', () => {
    for (const bad of [undefined, '', 'XX', 'T1', 'NLD', '??']) expect(exitTimezone(bad)).toBe(FALLBACK_ZONE);
  });

  it('every country has a zone and every zone is one the browser knows', () => {
    expect(Object.keys(COUNTRY_ZONE).length).toBeGreaterThan(240);
    const known = new Set(Intl.supportedValuesOf('timeZone'));
    for (const tz of knownZones()) {
      // Chromium and Node share ICU; an unknown id would make the override fail.
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz }), tz).not.toThrow();
      if (!known.has(tz)) expect(new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone).toBeTruthy();
    }
  });

  it('language and formats are the same for everyone', () => {
    expect(identityFor('NL', 'AMS')).toEqual({ timezone: 'Europe/Amsterdam', locale: SITE_LOCALE, languages: SITE_LANGUAGES });
    expect(SITE_LOCALE).toBe('en-US');
  });
});

describe('gate and pages that are not covered yet', () => {
  it('a page without its overrides may not reach the network', () => {
    expect(gateAllows('https://example.com/', true, false)).toBe(false);
    expect(gateAllows('https://example.com/', true, true)).toBe(true);
    // Nothing leaves for these anyway.
    expect(gateAllows('about:blank', true, false)).toBe(true);
    expect(gateAllows('data:text/plain,x', true, false)).toBe(true);
  });

  it('service worker scripts are recognised by their request header', () => {
    expect(isServiceWorkerScript({ 'Service-Worker': 'script', Accept: '*/*' })).toBe(true);
    expect(isServiceWorkerScript({ Accept: '*/*' })).toBe(false);
  });
});

describe('DNS in a Chromium net log', () => {
  const types = { HOST_RESOLVER_MANAGER_REQUEST: 1, HOST_RESOLVER_MANAGER_JOB: 2, DNS_TRANSACTION_QUERY: 3, HOST_RESOLVER_SYSTEM_TASK: 4 };

  it('finds lookups that went out', () => {
    // Shape taken from a real Electron 45 net log.
    const log: NetLog = {
      constants: { logEventTypes: types },
      events: [
        { type: 1, phase: 1, params: { host: 'https://leak.example', dns_query_type: 'UNSPECIFIED' } },
        { type: 2, phase: 1, params: { host: 'https://leak.example', dns_query_types: ['A', 'HTTPS'] } },
        { type: 3, phase: 1, params: { qname: 'leak.example' } },
        { type: 4, phase: 1 },
      ],
    };
    expect(dnsLookups(log)).toEqual(['leak.example']);
  });

  it('a lookup refused by host-resolver-rules is not a leak', () => {
    const log: NetLog = {
      constants: { logEventTypes: types },
      events: [{ type: 1, phase: 1, params: { host: 'http://~notfound', dns_query_type: 'UNSPECIFIED' } }],
    };
    expect(dnsLookups(log)).toEqual([]);
  });
});

describe('direct route for updates', () => {
  it.each(['github.com:443', 'api.github.com:443', 'objects.githubusercontent.com:443', 'release-assets.githubusercontent.com:443'])(
    '%s is allowed',
    (t) => expect(isUpdateHost(t)).toBe(true),
  );
  it.each(['github.com:80', 'evilgithub.com:443', 'github.com.evil.net:443', 'example.com:443', '127.0.0.1:443', 'github.com'])(
    '%s is refused',
    (t) => expect(isUpdateHost(t)).toBe(false),
  );
});
