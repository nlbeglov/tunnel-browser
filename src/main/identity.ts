// What pages are told about where the user is. A browser whose time zone, language or
// locale belongs to another country than its IP address is the classic sign of a VPN, so
// all of it follows the tunnel's exit instead of this computer. Pure: no Electron imports.
//
// Nothing here makes a request: the country and the Cloudflare data centre come from the
// trace the tunnel check already fetches through the server (health.ts).

import { COUNTRY_ZONE } from './timezones';

/** Language and formats every page sees, whatever this computer uses. */
export const SITE_LOCALE = 'en-US';
export const SITE_LANGUAGES = 'en-US';
/** When the exit country is unknown: a zone that says nothing about the user. */
export const FALLBACK_ZONE = 'UTC';

export interface SiteIdentity {
  timezone: string;
  locale: string;
  /** navigator.languages and Accept-Language */
  languages: string;
}

export const NEUTRAL_IDENTITY: SiteIdentity = { timezone: FALLBACK_ZONE, locale: SITE_LOCALE, languages: SITE_LANGUAGES };

// Countries that span several UTC offsets: Cloudflare data centre (IATA code from
// /cdn-cgi/trace "colo") -> zone. Anything not listed falls back to the country's zone.
const COLO_ZONE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  US: {
    ATL: 'America/New_York', BOS: 'America/New_York', BUF: 'America/New_York', CLT: 'America/New_York',
    CMH: 'America/New_York', EWR: 'America/New_York', IAD: 'America/New_York', JAX: 'America/New_York',
    MIA: 'America/New_York', ORF: 'America/New_York', PHL: 'America/New_York', PIT: 'America/New_York',
    RDU: 'America/New_York', RIC: 'America/New_York', TPA: 'America/New_York', TLH: 'America/New_York',
    DTW: 'America/Detroit', IND: 'America/Indiana/Indianapolis',
    ORD: 'America/Chicago', DFW: 'America/Chicago', IAH: 'America/Chicago', MCI: 'America/Chicago',
    MEM: 'America/Chicago', MSP: 'America/Chicago', OMA: 'America/Chicago', STL: 'America/Chicago',
    AUS: 'America/Chicago', SAT: 'America/Chicago', BNA: 'America/Chicago', MSY: 'America/Chicago',
    OKC: 'America/Chicago', MFE: 'America/Chicago',
    DEN: 'America/Denver', SLC: 'America/Denver', ABQ: 'America/Denver', BOI: 'America/Boise',
    PHX: 'America/Phoenix',
    LAX: 'America/Los_Angeles', SJC: 'America/Los_Angeles', SFO: 'America/Los_Angeles', SEA: 'America/Los_Angeles',
    PDX: 'America/Los_Angeles', SAN: 'America/Los_Angeles', SMF: 'America/Los_Angeles', LAS: 'America/Los_Angeles',
    ANC: 'America/Anchorage', HNL: 'Pacific/Honolulu',
  },
  CA: {
    YYZ: 'America/Toronto', YOW: 'America/Toronto', YUL: 'America/Toronto', YHZ: 'America/Halifax',
    YWG: 'America/Winnipeg', YXE: 'America/Regina', YYC: 'America/Edmonton', YVR: 'America/Vancouver',
  },
  RU: {
    DME: 'Europe/Moscow', SVO: 'Europe/Moscow', VKO: 'Europe/Moscow', LED: 'Europe/Moscow', KZN: 'Europe/Moscow',
    KGD: 'Europe/Kaliningrad', SVX: 'Asia/Yekaterinburg', OVB: 'Asia/Novosibirsk', KJA: 'Asia/Krasnoyarsk',
    VVO: 'Asia/Vladivostok', KHV: 'Asia/Vladivostok',
  },
  AU: {
    SYD: 'Australia/Sydney', CBR: 'Australia/Sydney', MEL: 'Australia/Melbourne', BNE: 'Australia/Brisbane',
    ADL: 'Australia/Adelaide', PER: 'Australia/Perth', HBA: 'Australia/Hobart',
  },
  BR: {
    GRU: 'America/Sao_Paulo', GIG: 'America/Sao_Paulo', CNF: 'America/Sao_Paulo', BSB: 'America/Sao_Paulo',
    CWB: 'America/Sao_Paulo', POA: 'America/Sao_Paulo', VCP: 'America/Sao_Paulo', FLN: 'America/Sao_Paulo',
    FOR: 'America/Fortaleza', REC: 'America/Recife', SSA: 'America/Bahia', BEL: 'America/Belem',
    MAO: 'America/Manaus', CGB: 'America/Cuiaba',
  },
  MX: { MEX: 'America/Mexico_City', QRO: 'America/Mexico_City', GDL: 'America/Mexico_City', MTY: 'America/Monterrey', TIJ: 'America/Tijuana' },
  ID: { CGK: 'Asia/Jakarta', SUB: 'Asia/Jakarta', JOG: 'Asia/Jakarta', DPS: 'Asia/Makassar', UPG: 'Asia/Makassar' },
};

/**
 * The time zone a local of the exit's country (and region, where the data centre tells)
 * would have. Unknown country: UTC rather than this computer's zone.
 */
export function exitTimezone(country?: string, colo?: string): string {
  const cc = country?.trim().toUpperCase();
  if (!cc || !/^[A-Z]{2}$/.test(cc)) return FALLBACK_ZONE;
  const byColo = colo ? COLO_ZONE[cc]?.[colo.trim().toUpperCase()] : undefined;
  return byColo ?? COUNTRY_ZONE[cc] ?? FALLBACK_ZONE;
}

export function identityFor(country?: string, colo?: string): SiteIdentity {
  return { timezone: exitTimezone(country, colo), locale: SITE_LOCALE, languages: SITE_LANGUAGES };
}

/** All zones this module can hand out, for tests. */
export function knownZones(): string[] {
  return [...new Set([FALLBACK_ZONE, ...Object.values(COUNTRY_ZONE), ...Object.values(COLO_ZONE).flatMap((m) => Object.values(m))])];
}
