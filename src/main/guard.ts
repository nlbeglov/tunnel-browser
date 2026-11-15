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
