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
        const raw = Buffer.concat(chunks).toString('utf8');
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
        if (!m) return fail(new Error('пустой ответ'));
        const bodyAt = raw.indexOf('\r\n\r\n');
        const result = {
          status: Number(m[1]),
          body: bodyAt >= 0 ? raw.slice(bodyAt + 4) : '',
          ms: Date.now() - started,
          rtt: Math.max(1, Math.round(firstByteAt - sentAt)),
        };
        settle(() => resolve(result));
      });
    });
    req.end();
  });
}

export interface ExitInfo {
  ip: string;
  country?: string;
  /** Cloudflare data centre that answered (IATA code): the exit's region */
  colo?: string;
  latencyMs: number;
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
  return new Promise((resolve, reject) => {
    let left = PROBES.length;
    let last: unknown;
    const failed = (e: unknown) => {
      last = e;
      if (--left === 0) reject(last instanceof Error ? last : new Error('туннель не отвечает'));
    };
    for (const [host, path] of PROBES) {
      getViaProxy(proxy, host, path, timeoutMs).then(
        (r) => (r.status === 204 ? resolve(r.rtt) : failed(new Error(`${host} ответил ${r.status}`))),
        failed,
      );
    }
  });
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

/** Learns the public exit IP and country as seen by the internet, and the ping. */
export async function exitInfo(proxy: ProxyEndpoint): Promise<ExitInfo> {
  const first = await probeTunnel(proxy);
  try {
    const r = await getViaProxy(proxy, 'www.cloudflare.com', '/cdn-cgi/trace');
    // Body may be chunked; the key=value lines survive either way.
    const ip = /^ip=(.+)$/m.exec(r.body)?.[1]?.trim();
    const loc = /^loc=(.+)$/m.exec(r.body)?.[1]?.trim();
    const colo = /^colo=(.+)$/m.exec(r.body)?.[1]?.trim();
    // Two round trips are better than one: the very first through a fresh core can be slow.
    return { ip: ip ?? '?', country: loc, colo, latencyMs: Math.min(first, r.rtt) };
  } catch {
    return { ip: '?', latencyMs: first };
  }
}
