// Pure URL / host checks used by the kill-switch. No Electron imports: unit-tested.

import net from 'node:net';
import { BLOCKED_CIDRS } from './xrayConfig';

const NO_NETWORK_SCHEMES = new Set(['data:', 'blob:', 'about:', 'devtools:']);
const WEB_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

const blocked = new net.BlockList();
for (const cidr of BLOCKED_CIDRS) {
  const [addr, bits] = cidr.split('/');
  blocked.addSubnet(addr, Number(bits), addr.includes(':') ? 'ipv6' : 'ipv4');
}

/** True for hosts that point at this machine or a private network. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const kind = net.isIP(h);
  if (kind === 4) return blocked.check(h, 'ipv4');
  if (kind === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(h, 'ipv6');
  }
  // Chromium also accepts numeric hosts like http://2130706433/ — treat anything that is
  // all digits/hex as an address we cannot vouch for.
  return /^(0x[0-9a-f]+|\d+)$/.test(h);
}

export function isWebUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Removes "Electron/x" and the app token so sites see an ordinary Chrome. */
export function cleanUserAgent(ua: string): string {
  return ua
    .replace(/\s?Electron\/\S+/, '')
    .replace(/\s?tunnel-browser\/\S+/i, '')
    .replace(/\s?Tunnel Browser\/\S+/i, '')
    .replace(/Chrome\/(\d+)\.[\d.]+/, 'Chrome/$1.0.0.0');
}

// What a page sees when the tunnel's server is unreachable: Xray's HTTP inbound drops the
// CONNECT stream for https, or the connection to the inbound itself fails.
const TUNNEL_TROUBLE_ERRORS = new Set([
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_FAILED',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_TIMED_OUT',
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_TUNNEL_CONNECTION_FAILED',
  'net::ERR_PROXY_CONNECTION_FAILED',
  'net::ERR_SSL_PROTOCOL_ERROR',
  'net::ERR_HTTP2_PING_FAILED',
  'net::ERR_SOCKET_NOT_CONNECTED',
]);

/** A page request failed in a way a dead tunnel causes (not a block, abort or bad page). */
export function isTunnelTroubleError(error: string): boolean {
  return TUNNEL_TROUBLE_ERRORS.has(error);
}

/**
 * Xray's own answer to a plain-http request it could not deliver: 503, empty body, and no
 * Date header (real servers send one). A site's own 503 does not count.
 */
export function isProxyFailureResponse(statusCode: number, headers: Record<string, string[] | string> | undefined): boolean {
  if (statusCode !== 503) return false;
  return !Object.keys(headers ?? {}).some((k) => k.toLowerCase() === 'date');
}

/** The gate's decision for one request. */
export function gateAllows(raw: string, tunnelOpen: boolean): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (NO_NETWORK_SCHEMES.has(u.protocol)) return true;
  if (!WEB_SCHEMES.has(u.protocol)) return false;
  if (!tunnelOpen) return false;
  return !isLocalHost(u.hostname);
}
