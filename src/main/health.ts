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
  ms: number;
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
      s.once('secureConnect', () => {
        s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
      });
      s.on('data', (c: Buffer) => {
        chunks.push(c);
        size += c.length;
        if (size > 64 * 1024) fail(new Error('слишком большой ответ'));
      });
      s.once('close', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
        if (!m) return fail(new Error('пустой ответ'));
        const bodyAt = raw.indexOf('\r\n\r\n');
        const result = { status: Number(m[1]), body: bodyAt >= 0 ? raw.slice(bodyAt + 4) : '', ms: Date.now() - started };
        settle(() => resolve(result));
      });
    });
    req.end();
  });
}

export interface ExitInfo {
  ip: string;
  country?: string;
  latencyMs: number;
}

const PROBES: Array<[string, string]> = [
  ['www.gstatic.com', '/generate_204'],
  ['cp.cloudflare.com', '/generate_204'],
];

/** Resolves when any probe returns 204 through the tunnel; rejects with the last error. */
export async function probeTunnel(proxy: ProxyEndpoint, timeoutMs = 8000): Promise<number> {
  let last: unknown;
  for (const [host, path] of PROBES) {
    try {
      const r = await getViaProxy(proxy, host, path, timeoutMs);
      if (r.status === 204) return r.ms;
      last = new Error(`${host} ответил ${r.status}`);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error('туннель не отвечает');
}

/** Learns the public exit IP and country as seen by the internet. */
export async function exitInfo(proxy: ProxyEndpoint): Promise<ExitInfo> {
  const latencyMs = await probeTunnel(proxy);
  try {
    const r = await getViaProxy(proxy, 'www.cloudflare.com', '/cdn-cgi/trace');
    // Body may be chunked; the key=value lines survive either way.
    const ip = /^ip=(.+)$/m.exec(r.body)?.[1]?.trim();
    const loc = /^loc=(.+)$/m.exec(r.body)?.[1]?.trim();
    return { ip: ip ?? '?', country: loc, latencyMs };
  } catch {
    return { ip: '?', latencyMs };
  }
}
