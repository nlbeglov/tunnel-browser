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

/** GET https://host/path through the proxy. */
export function getViaProxy(proxy: ProxyEndpoint, host: string, path: string, timeoutMs = 8000): Promise<HttpsResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    const timer = setTimeout(() => {
      req.destroy();
      fail(new Error('таймаут'));
    }, timeoutMs);

    const auth = Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:443`,
      headers: { Host: `${host}:443`, 'Proxy-Authorization': `Basic ${auth}` },
      agent: false,
    });
    req.once('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        socket.destroy();
        fail(new Error(`прокси ответил ${res.statusCode}`));
        return;
      }
      const s = tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] });
      const chunks: Buffer[] = [];
      s.once('secureConnect', () => {
        s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
      });
      s.on('data', (c: Buffer) => {
        chunks.push(c);
        if (Buffer.concat(chunks).length > 64 * 1024) s.destroy();
      });
      s.once('error', (e) => {
        clearTimeout(timer);
        fail(e);
      });
      s.once('close', () => {
        clearTimeout(timer);
        if (settled) return;
        const raw = Buffer.concat(chunks).toString('utf8');
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
        if (!m) return fail(new Error('пустой ответ'));
        settled = true;
        const bodyAt = raw.indexOf('\r\n\r\n');
        resolve({ status: Number(m[1]), body: bodyAt >= 0 ? raw.slice(bodyAt + 4) : '', ms: Date.now() - started });
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
