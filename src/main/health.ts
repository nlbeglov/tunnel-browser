// Checks that traffic really leaves through the tunnel: opens an HTTP CONNECT through the
// local Xray inbound, then a TLS request to a public endpoint. No Electron imports.

import http from 'node:http';
import tls from 'node:tls';

export interface ProxyEndpoint {
  port: number;
  user: string;
  pass: string;
}

interface HttpsResult {
  status: number;
  body: string;
  /** the whole request: CONNECT, the server's handshake, TLS, response, close */
  ms: number;
  /**
   * Round trip through the tunnel: from sending the request over the established connection
   * to the first byte of the answer. This is the "ping" (you -> VPN server -> site -> back);
   * the setup of a fresh connection is not in it.
   */
  rtt: number;
}

/**
 * GET https://host/path through the proxy.
 *
 * Every socket involved keeps a permanent 'error' listener and is destroyed when the
 * probe settles. A TLS socket can emit 'error' more than once: Node reports a TLS error
 * after the handshake without closing the socket, and a reset can follow (Windows sends
 * RST eagerly). A one-shot listener would let the second error crash the process.
 */
export function getViaProxy(proxy: ProxyEndpoint, host: string, path: string, timeoutMs = 8000): Promise<HttpsResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const sockets: Array<{ destroy(): void }> = [];
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const s of sockets) s.destroy();
      fn();
    };
    const fail = (e: Error) => settle(() => reject(e));
    const timer = setTimeout(() => fail(new Error('таймаут')), timeoutMs);

    const auth = Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:443`,
      headers: { Host: `${host}:443`, 'Proxy-Authorization': `Basic ${auth}` },
      agent: false,
    });
    sockets.push(req);
    req.on('error', fail);
    req.once('connect', (res, socket) => {
      // http drops its own error listener from the socket it hands over on CONNECT.
      socket.on('error', fail);
      sockets.push(socket);
      if (settled) return;
      if (res.statusCode !== 200) return fail(new Error(`прокси ответил ${res.statusCode}`));

      const s = tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] });
      sockets.push(s);
      s.on('error', fail);
      const chunks: Buffer[] = [];
      let size = 0;
      let sentAt = 0;
      let firstByteAt = 0;
      s.once('secureConnect', () => {
        sentAt = performance.now();
        s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
      });
      s.on('data', (c: Buffer) => {
        if (!firstByteAt) firstByteAt = performance.now();
        chunks.push(c);
        size += c.length;
        if (size > 64 * 1024) fail(new Error('слишком большой ответ'));
      });
      s.once('close', () => {
        const raw = Buffer.concat(chunks);
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(raw.subarray(0, 16).toString('latin1'));
        if (!m) return fail(new Error('пустой ответ'));
        const bodyAt = raw.indexOf('\r\n\r\n');
        const head = bodyAt >= 0 ? raw.subarray(0, bodyAt).toString('latin1') : '';
        const body = bodyAt >= 0 ? raw.subarray(bodyAt + 4) : Buffer.alloc(0);
        const result = {
          status: Number(m[1]),
          body: (/^transfer-encoding:\s*chunked/im.test(head) ? dechunk(body) : body).toString('utf8'),
          ms: Date.now() - started,
          rtt: Math.max(1, Math.round(firstByteAt - sentAt)),
        };
        settle(() => resolve(result));
      });
    });
    req.end();
  });
}

/** The body of a `Transfer-Encoding: chunked` answer, without the chunk sizes. */
export function dechunk(b: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (i < b.length) {
    const eol = b.indexOf('\r\n', i);
    if (eol < 0) break;
    const size = Number.parseInt(b.subarray(i, eol).toString('latin1').split(';')[0].trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    out.push(b.subarray(eol + 2, eol + 2 + size));
    i = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}

export interface ExitInfo {
  /** '?' when no service told it */
  ip: string;
  country?: string;
  /** Cloudflare data centre that answered (IATA code): the exit's region */
  colo?: string;
  /** the time zone the IP service reports for the exit, when it is not Cloudflare */
  zone?: string;
  latencyMs: number;
  /** why the IP is unknown: what each service answered */
  ipError?: string;
}

type Located = Pick<ExitInfo, 'ip' | 'country' | 'colo' | 'zone'>;

const line = (body: string, key: string) => new RegExp(`^${key}=(.+)$`, 'm').exec(body)?.[1]?.trim();
const field = (body: string, key: string) => new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(body)?.[1]?.trim();
const trace = (body: string): Partial<Located> => ({ ip: line(body, 'ip'), country: line(body, 'loc'), colo: line(body, 'colo') });

/**
 * Where the exit IP is learnt, through the tunnel, in this order: the first that answers with
 * an IP wins. Cloudflare comes first, its data centre tells the region of big countries; the
 * others are there for when it does not answer or shows a check page instead of the trace.
 */
export const IP_SOURCES: Array<{ host: string; path: string; parse: (body: string) => Partial<Located> }> = [
  { host: 'www.cloudflare.com', path: '/cdn-cgi/trace', parse: trace },
  { host: 'one.one.one.one', path: '/cdn-cgi/trace', parse: trace },
  { host: 'ifconfig.co', path: '/json', parse: (b) => ({ ip: field(b, 'ip'), country: field(b, 'country_iso'), zone: field(b, 'time_zone') }) },
  { host: 'ipinfo.io', path: '/json', parse: (b) => ({ ip: field(b, 'ip'), country: field(b, 'country'), zone: field(b, 'timezone') }) },
];

const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:.]+)$/i;

/** What an IP service answered, checked: a real IP, a two-letter country, or nothing. */
export function located(found: Partial<Located>): Located | undefined {
  const ip = found.ip?.trim();
  if (!ip || !IP_RE.test(ip)) return undefined;
  const cc = found.country?.trim().toUpperCase();
  const zone = found.zone?.trim();
  return {
    ip,
    country: cc && /^[A-Z]{2}$/.test(cc) ? cc : undefined,
    colo: found.colo?.trim() || undefined,
    zone: zone && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(zone) ? zone : undefined,
  };
}

const PROBES: Array<[string, string]> = [
  ['www.gstatic.com', '/generate_204'],
  ['cp.cloudflare.com', '/generate_204'],
];

/**
 * All probes run at once; resolves with the round trip (rtt) of the first 204 through the
 * tunnel, rejects with the last error once every probe has failed. A dead server is reported
 * within one timeout.
 */
export function probeTunnel(proxy: ProxyEndpoint, timeoutMs = 8000): Promise<number> {
  return probeTunnelFrom(proxy, timeoutMs).then((r) => r.rtt);
}

/** probeTunnel, telling which host answered first. */
export function probeTunnelFrom(proxy: ProxyEndpoint, timeoutMs = 8000): Promise<{ rtt: number; host: string }> {
  return new Promise((resolve, reject) => {
    let left = PROBES.length;
    let last: unknown;
    const failed = (e: unknown) => {
      last = e;
      if (--left === 0) reject(last instanceof Error ? last : new Error('туннель не отвечает'));
    };
    for (const [host, path] of PROBES) {
      getViaProxy(proxy, host, path, timeoutMs).then(
        (r) => (r.status === 204 ? resolve({ rtt: r.rtt, host }) : failed(new Error(`${host} ответил ${r.status}`))),
        failed,
      );
    }
  });
}

class TimeoutError extends Error {
  constructor() {
    super('таймаут');
  }
}

/**
 * The regular check over one HTTPS connection through the tunnel that stays open between
 * checks: a check is one small request (under a kilobyte) instead of a new connection and TLS
 * handshake each time (about ten). When the connection is gone (the site or Xray closed it),
 * it is opened again; its setup is never part of the measured time.
 */
export class KeepAlivePing {
  private sock: tls.TLSSocket | null = null;
  private host = PROBES[0][0];

  constructor(
    private readonly proxy: ProxyEndpoint,
    /** for tests: a CA for the fake site */
    private readonly tlsExtra: tls.ConnectionOptions = {},
  ) {}

  get connected(): boolean {
    return this.sock !== null;
  }

  /** The host whose probe answered last: the kept connection goes there from now on. */
  prefer(host: string) {
    if (host === this.host || !PROBES.some(([h]) => h === host)) return;
    this.host = host;
    this.close();
  }

  close() {
    this.sock?.destroy();
    this.sock = null;
  }

  async ping(timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    const reused = this.sock !== null;
    try {
      return await this.request(this.sock ?? (await this.open(timeoutMs)), deadline);
    } catch (e) {
      this.close();
      // The other side may have closed a kept connection just now: one new attempt. A
      // timeout is a real answer, though: the server is not getting through.
      if (!reused || e instanceof TimeoutError || Date.now() >= deadline) throw e;
      try {
        return await this.request(await this.open(deadline - Date.now()), deadline);
      } catch (again) {
        this.close();
        throw again;
      }
    }
  }

  private open(timeoutMs: number): Promise<tls.TLSSocket> {
    const host = this.host;
    return new Promise((resolve, reject) => {
      const parts: Array<{ destroy(): void }> = [];
      let done = false;
      const fail = (e: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const p of parts) p.destroy();
        reject(e);
      };
      const timer = setTimeout(() => fail(new TimeoutError()), Math.max(1, timeoutMs));
      const auth = Buffer.from(`${this.proxy.user}:${this.proxy.pass}`).toString('base64');
      const req = http.request({
        host: '127.0.0.1',
        port: this.proxy.port,
        method: 'CONNECT',
        path: `${host}:443`,
        headers: { Host: `${host}:443`, 'Proxy-Authorization': `Basic ${auth}` },
        agent: false,
      });
      parts.push(req);
      req.on('error', fail);
      req.once('connect', (res, socket) => {
        // Permanent listeners: a socket can report errors after it is set up (see getViaProxy).
        socket.on('error', (e) => fail(e));
        parts.push(socket);
        if (done) return socket.destroy();
        if (res.statusCode !== 200) return fail(new Error(`прокси ответил ${res.statusCode}`));
        const s = tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'], ...this.tlsExtra });
        parts.push(s);
        s.on('error', (e) => fail(e));
        s.once('secureConnect', () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const drop = () => {
            if (this.sock === s) this.sock = null;
            s.destroy();
          };
          s.on('error', drop);
          s.on('close', drop);
          socket.on('close', drop);
          resolve(s);
        });
      });
      req.end();
    });
  }

  private request(s: tls.TLSSocket, deadline: number): Promise<number> {
    this.sock = s;
    const host = this.host;
    const path = PROBES.find(([h]) => h === host)?.[1] ?? '/generate_204';
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let sentAt = 0;
      let firstByteAt = 0;
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        s.off('data', onData);
        s.off('close', onClose);
        s.off('error', onError);
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new TimeoutError())), Math.max(1, deadline - Date.now()));
      const onData = (c: Buffer) => {
        if (!firstByteAt) firstByteAt = performance.now();
        buf = Buffer.concat([buf, c]);
        if (buf.length > 16 * 1024) return finish(() => reject(new Error('слишком большой ответ')));
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('latin1');
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
        finish(() => {
          if (status !== 204) {
            this.close();
            return reject(new Error(`${host} ответил ${status || 'непонятно что'}`));
          }
          // A body to skip, or the site is about to close: start over next time.
          const length = Number(/^content-length:\s*(\d+)/im.exec(head)?.[1] ?? 0);
          if (length > 0 || /^connection:\s*close/im.test(head) || /^transfer-encoding:/im.test(head)) this.close();
          resolve(Math.max(1, Math.round(firstByteAt - sentAt)));
        });
      };
      const onClose = () => finish(() => reject(new Error('соединение закрыто')));
      const onError = (e: Error) => finish(() => reject(e));
      s.on('data', onData);
      s.on('close', onClose);
      s.on('error', onError);
      if (s.destroyed) return onClose();
      sentAt = performance.now();
      s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\n\r\n`);
    });
  }
}

const kept = new WeakMap<ProxyEndpoint, KeepAlivePing>();

/**
 * The tunnel's regular check: one request over the kept connection. `fresh` (after a failed
 * check, while the server is down, when pages report trouble) asks both probe hosts over new
 * connections, like the first check: a kept connection can still work while new ones through
 * the server fail, and those are what pages need.
 */
export async function checkTunnel(proxy: ProxyEndpoint, timeoutMs: number, fresh = false): Promise<number> {
  let k = kept.get(proxy);
  if (!k) kept.set(proxy, (k = new KeepAlivePing(proxy)));
  if (!fresh) return k.ping(timeoutMs);
  const { rtt, host } = await probeTunnelFrom(proxy, timeoutMs);
  k.prefer(host);
  return rtt;
}

/** The tunnel is gone: close its kept connection. */
export function releaseTunnel(proxy: ProxyEndpoint): void {
  kept.get(proxy)?.close();
  kept.delete(proxy);
}

/**
 * The tunnel's ping: several round trips, one after another, the best one counts (a single
 * one can catch a hiccup). Each goes over its own fresh connection, whose setup is not timed.
 */
export async function measureLatency(proxy: ProxyEndpoint, rounds = 3, timeoutMs = 5000): Promise<number> {
  const times: number[] = [];
  let last: unknown;
  for (let i = 0; i < rounds; i++) {
    for (const [host, path] of PROBES) {
      try {
        const r = await getViaProxy(proxy, host, path, timeoutMs);
        if (r.status !== 204) throw new Error(`${host} ответил ${r.status}`);
        times.push(r.rtt);
        break;
      } catch (e) {
        last = e;
      }
    }
  }
  if (!times.length) throw last instanceof Error ? last : new Error('туннель не отвечает');
  return Math.min(...times);
}

/**
 * Learns the public exit IP and country as seen by the internet, and the ping. The tunnel
 * works once the probe passes; an unknown IP is not a failure (the reason is kept).
 */
export async function exitInfo(proxy: ProxyEndpoint, sources = IP_SOURCES, timeoutMs = 6000): Promise<ExitInfo> {
  const first = await probeTunnel(proxy);
  const failures: string[] = [];
  for (const src of sources) {
    try {
      const r = await getViaProxy(proxy, src.host, src.path, timeoutMs);
      const found = r.status === 200 ? located(src.parse(r.body)) : undefined;
      if (found) {
        // Two round trips are better than one: the very first through a fresh core can be slow.
        return { ...found, latencyMs: Math.min(first, r.rtt) };
      }
      failures.push(`${src.host}: ${r.status === 200 ? 'нет IP в ответе' : `ответ ${r.status}`}`);
    } catch (e) {
      failures.push(`${src.host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ip: '?', latencyMs: first, ipError: failures.join('; ') };
}
