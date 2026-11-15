// Parsing of share links (vless://, vmess://, trojan://, ss://) and subscription bodies.
// Pure module: no Electron imports, covered by unit tests.

import { randomUUID } from 'node:crypto';
import type { Security, ServerProfile, Transport, TransportType } from '../shared/types';
import { isLocalHost } from './guard';

export class LinkError extends Error {}

const TRANSPORTS: TransportType[] = ['tcp', 'ws', 'grpc', 'httpupgrade', 'xhttp', 'kcp'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decodes standard or URL-safe base64, with or without padding. Returns null if it is not base64. */
export function decodeBase64(input: string): string | null {
  const s = input.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!s || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const out = Buffer.from(padded, 'base64').toString('utf8');
  // Reject results that are clearly binary (decoding garbage still "succeeds").
  if (out.includes('�')) return null;
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parsePort(raw: string | number | undefined): number {
  const port = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new LinkError(`некорректный порт: ${raw}`);
  return port;
}

function cleanHost(host: string): string {
  const h = host.replace(/^\[|\]$/g, '').trim();
  if (!h) throw new LinkError('не указан адрес сервера');
  return h;
}

function splitList(v: string | null | undefined): string[] | undefined {
  if (!v) return undefined;
  const items = v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function parseTransport(q: URLSearchParams): Transport {
  const rawType = (q.get('type') || 'tcp').toLowerCase();
  const type = (rawType === 'raw' ? 'tcp' : rawType === 'splithttp' ? 'xhttp' : rawType) as TransportType;
  if (!TRANSPORTS.includes(type)) throw new LinkError(`транспорт "${rawType}" не поддерживается`);
  const t: Transport = { type };
  const path = q.get('path');
  const host = q.get('host');
  if (path) t.path = path;
  if (host) t.host = host;
  if (type === 'grpc') {
    t.serviceName = q.get('serviceName') || q.get('path') || '';
    delete t.path;
    const authority = q.get('authority');
    if (authority) t.authority = authority;
    const mode = q.get('mode');
    if (mode) t.mode = mode;
  }
  if (type === 'xhttp') {
    const mode = q.get('mode');
    if (mode) t.mode = mode;
    const extra = q.get('extra');
    if (extra) {
      try {
        const parsed = JSON.parse(extra);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) t.extra = parsed;
      } catch {
        throw new LinkError('параметр extra для xhttp не является JSON');
      }
    }
  }
  if (type === 'tcp' || type === 'kcp') {
    const headerType = q.get('headerType');
    if (headerType && headerType !== 'none') t.headerType = headerType;
  }
  if (type === 'kcp') {
    const seed = q.get('seed');
    if (seed) t.seed = seed;
  }
  return t;
}

function parseSecurity(q: URLSearchParams, defaultType: Security['type']): Security {
  const raw = (q.get('security') || defaultType).toLowerCase();
  if (raw !== 'none' && raw !== 'tls' && raw !== 'reality') {
    throw new LinkError(`тип шифрования "${raw}" не поддерживается`);
  }
  const s: Security = { type: raw };
  if (raw === 'none') return s;
  const sni = q.get('sni') || q.get('peer');
  if (sni) s.sni = sni;
  s.fingerprint = q.get('fp') || 'chrome';
  const alpn = splitList(q.get('alpn'));
  if (alpn) s.alpn = alpn;
  if (raw === 'tls') {
    const pcs = q.get('pcs');
    const vcn = q.get('vcn');
    if (pcs) s.pinnedPeerCertSha256 = pcs;
    if (vcn) s.verifyPeerCertByName = vcn;
    const insecure = q.get('allowInsecure') ?? q.get('insecure');
    if ((insecure === '1' || insecure === 'true') && !pcs) {
      // Xray removed allowInsecure: connecting without certificate checks would allow MITM.
      throw new LinkError(
        'сервер требует отключить проверку сертификата (allowInsecure) — это небезопасно и не поддерживается Xray; попросите у провайдера ссылку с закреплённым сертификатом (pcs)',
      );
    }
  }
  if (raw === 'reality') {
    const pbk = q.get('pbk');
    if (!pbk) throw new LinkError('для Reality нужен публичный ключ (pbk)');
    s.publicKey = pbk;
    const sid = q.get('sid');
    if (sid) s.shortId = sid;
    const spx = q.get('spx');
    if (spx) s.spiderX = spx;
    const pqv = q.get('pqv');
    if (pqv) s.mldsa65Verify = pqv;
  }
  return s;
}

function parseUrlLike(link: string): URL {
  try {
    return new URL(link);
  } catch {
    throw new LinkError('ссылка повреждена');
  }
}

function nameFrom(url: URL, fallback: string): string {
  const n = safeDecode(url.hash.replace(/^#/, '')).trim();
  return n || fallback;
}

function parseVless(link: string): ServerProfile {
  const u = parseUrlLike(link);
  const uuid = safeDecode(u.username);
  if (!uuid) throw new LinkError('в ссылке нет UUID');
  const address = cleanHost(u.hostname);
  const port = parsePort(u.port || 443);
  const q = u.searchParams;
  const encryption = q.get('encryption') || 'none';
  const flow = q.get('flow') || undefined;
  const security = parseSecurity(q, 'none');
  if (security.type === 'none' && encryption === 'none' && !isLocalHost(address)) {
    // Xray refuses this too: the traffic would cross the internet in the clear.
    throw new LinkError('VLESS без TLS/Reality и без шифрования передаёт данные открытым текстом — Xray такое запрещает');
  }
  return {
    id: randomUUID(),
    name: nameFrom(u, `${address}:${port}`),
    protocol: 'vless',
    address,
    port,
    uuid,
    encryption,
    flow,
    transport: parseTransport(q),
    security,
    link,
  };
}

function parseTrojan(link: string): ServerProfile {
  const u = parseUrlLike(link);
  const password = safeDecode(u.username);
  if (!password) throw new LinkError('в ссылке нет пароля');
  const address = cleanHost(u.hostname);
  const port = parsePort(u.port || 443);
  const q = u.searchParams;
  return {
    id: randomUUID(),
    name: nameFrom(u, `${address}:${port}`),
    protocol: 'trojan',
    address,
    port,
    password,
    transport: parseTransport(q),
    security: parseSecurity(q, 'tls'),
    link,
  };
}

interface VmessJson {
  ps?: string;
  add?: string;
  port?: string | number;
  id?: string;
  scy?: string;
  net?: string;
  type?: string;
  host?: string;
  path?: string;
  tls?: string;
  sni?: string;
  alpn?: string;
  fp?: string;
  allowInsecure?: string | number | boolean;
}

function parseVmess(link: string): ServerProfile {
  const body = link.slice('vmess://'.length).split('#')[0];
  const decoded = decodeBase64(body);
  if (!decoded) throw new LinkError('vmess-ссылка не в формате base64');
  let j: VmessJson;
  try {
    j = JSON.parse(decoded);
  } catch {
    throw new LinkError('vmess-ссылка содержит некорректный JSON');
  }
  if (!j.id) throw new LinkError('в vmess-ссылке нет id');
  const address = cleanHost(String(j.add ?? ''));
  const port = parsePort(j.port);
  const q = new URLSearchParams();
  q.set('type', j.net || 'tcp');
  if (j.host) q.set('host', j.host);
  if (j.path) q.set('path', j.path);
  if (j.net === 'grpc' && j.path) q.set('serviceName', j.path);
  if (j.net === 'grpc' && j.type) q.set('mode', j.type);
  if ((j.net === 'tcp' || j.net === 'kcp' || !j.net) && j.type) q.set('headerType', j.type);
  q.set('security', j.tls === 'tls' ? 'tls' : 'none');
  if (j.sni) q.set('sni', j.sni);
  else if (j.tls === 'tls' && j.host) q.set('sni', j.host.split(',')[0]);
  if (j.alpn) q.set('alpn', j.alpn);
  if (j.fp) q.set('fp', j.fp);
  if (j.allowInsecure === true || j.allowInsecure === 1 || j.allowInsecure === '1' || j.allowInsecure === 'true') {
    q.set('allowInsecure', '1');
  }
  return {
    id: randomUUID(),
    name: (j.ps || '').trim() || `${address}:${port}`,
    protocol: 'vmess',
    address,
    port,
    uuid: j.id,
    cipher: j.scy || 'auto',
    transport: parseTransport(q),
    security: parseSecurity(q, 'none'),
    link,
  };
}

const SS_METHODS = new Set([
  'aes-128-gcm',
  'aes-256-gcm',
  'chacha20-poly1305',
  'chacha20-ietf-poly1305',
  'xchacha20-poly1305',
  'xchacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
  'none',
  'plain',
]);

function parseShadowsocks(link: string): ServerProfile {
  const hashIdx = link.indexOf('#');
  const name = hashIdx >= 0 ? safeDecode(link.slice(hashIdx + 1)).trim() : '';
  let rest = link.slice('ss://'.length, hashIdx >= 0 ? hashIdx : undefined);
  const qIdx = rest.indexOf('?');
  const query = new URLSearchParams(qIdx >= 0 ? rest.slice(qIdx + 1) : '');
  if (qIdx >= 0) rest = rest.slice(0, qIdx);
  rest = rest.replace(/\/$/, '');
  if (query.get('plugin')) throw new LinkError('плагины Shadowsocks (obfs, v2ray-plugin) не поддерживаются');

  let userinfo: string;
  let hostport: string;
  if (rest.includes('@')) {
    // SIP002: base64(method:password)@host:port, or percent-encoded method:password for 2022 ciphers
    const at = rest.lastIndexOf('@');
    const rawUser = rest.slice(0, at);
    hostport = rest.slice(at + 1);
    const decoded = decodeBase64(safeDecode(rawUser));
    userinfo = decoded && decoded.includes(':') ? decoded : safeDecode(rawUser);
  } else {
    // Legacy: base64(method:password@host:port)
    const decoded = decodeBase64(rest);
    if (!decoded || !decoded.includes('@')) throw new LinkError('ss-ссылка повреждена');
    const at = decoded.lastIndexOf('@');
    userinfo = decoded.slice(0, at);
    hostport = decoded.slice(at + 1);
  }
  const colon = userinfo.indexOf(':');
  if (colon < 0) throw new LinkError('в ss-ссылке нет метода или пароля');
  const method = userinfo.slice(0, colon).toLowerCase();
  const password = userinfo.slice(colon + 1);
  if (!SS_METHODS.has(method)) throw new LinkError(`метод шифрования Shadowsocks "${method}" не поддерживается`);

  const hp = parseUrlLike(`ss://x@${hostport}`);
  const address = cleanHost(hp.hostname);
  const port = parsePort(hp.port);
  return {
    id: randomUUID(),
    name: name || `${address}:${port}`,
    protocol: 'shadowsocks',
    address,
    port,
    method,
    password,
    transport: { type: 'tcp' },
    security: { type: 'none' },
    link,
  };
}

/** Parses one share link. Throws LinkError with a human-readable (Russian) message. */
export function parseLink(raw: string): ServerProfile {
  const link = raw.trim();
  const scheme = link.slice(0, link.indexOf('://')).toLowerCase();
  let profile: ServerProfile;
  switch (scheme) {
    case 'vless':
      profile = parseVless(link);
      break;
    case 'vmess':
      profile = parseVmess(link);
      break;
    case 'trojan':
      profile = parseTrojan(link);
      break;
    case 'ss':
      profile = parseShadowsocks(link);
      break;
    case 'hysteria2':
    case 'hy2':
    case 'tuic':
    case 'wireguard':
      throw new LinkError(`протокол ${scheme} пока не поддерживается`);
    default:
      throw new LinkError('неизвестный формат ссылки');
  }
  if ((profile.protocol === 'vless' || profile.protocol === 'vmess') && !UUID_RE.test(profile.uuid ?? '')) {
    // Xray also accepts arbitrary strings (mapped to UUIDv5), so this is only a sanity limit.
    if (!profile.uuid || profile.uuid.length > 64) throw new LinkError('некорректный UUID');
  }
  return profile;
}

const LINK_RE = /^(vless|vmess|trojan|ss|hysteria2|hy2|tuic|wireguard):\/\//i;

/**
 * Splits pasted text or a subscription body into share links.
 * Accepts plain text (one link per line) or base64 of the same.
 */
export function extractLinks(body: string): string[] {
  const text = body.trim();
  const lines = (t: string) =>
    t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => LINK_RE.test(l));
  const direct = lines(text);
  if (direct.length) return direct;
  const decoded = decodeBase64(text);
  return decoded ? lines(decoded) : [];
}

export interface ParsedBatch {
  profiles: ServerProfile[];
  errors: string[];
}

export function parseMany(body: string): ParsedBatch {
  const links = extractLinks(body);
  const profiles: ServerProfile[] = [];
  const errors: string[] = [];
  if (!links.length) {
    errors.push('не найдено ни одной ссылки на сервер');
    return { profiles, errors };
  }
  for (const l of links) {
    try {
      profiles.push(parseLink(l));
    } catch (e) {
      const short = l.length > 40 ? `${l.slice(0, 40)}…` : l;
      errors.push(`${short}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { profiles, errors };
}
