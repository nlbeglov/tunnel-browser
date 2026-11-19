// The regular tunnel check keeps one HTTPS connection open between checks (health.ts
// KeepAlivePing). A fake proxy (like Xray's HTTP inbound) and a fake site with a test
// certificate count connections and handshakes. Offline.

import https from 'node:https';
import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KeepAlivePing } from '../src/main/health';
import { TEST_CERT, TEST_KEY } from './tlsFixture';

type Mode = 'ok' | 'hang' | 'error';

describe('the regular check reuses one connection', () => {
  let mode: Mode = 'ok';
  let site: https.Server;
  let proxy: net.Server;
  let proxyPort = 0;
  let handshakes = 0;
  let requests = 0;
  let tunnels = 0;
  const sockets = new Set<net.Socket>();

  beforeAll(async () => {
    site = https.createServer({ cert: TEST_CERT, key: TEST_KEY }, (_req, res) => {
      requests++;
      if (mode === 'hang') return;
      if (mode === 'error') {
        res.writeHead(503, { 'content-length': '0' });
        return res.end();
      }
      res.writeHead(204);
      res.end();
    });
    site.on('secureConnection', () => handshakes++);
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const sitePort = (site.address() as net.AddressInfo).port;

    // CONNECT anything -> the fake site
    proxy = net.createServer((client) => {
      sockets.add(client);
      client.on('error', () => {});
      client.once('data', () => {
        tunnels++;
        const up = net.connect(sitePort, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection established\r\n\r\n');
          client.pipe(up).pipe(client);
        });
        sockets.add(up);
        up.on('error', () => client.destroy());
        client.on('close', () => up.destroy());
        up.on('close', () => client.destroy());
      });
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    proxyPort = (proxy.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    site.closeAllConnections();
    await new Promise((r) => site.close(r));
    await new Promise((r) => proxy.close(r));
  });

  beforeEach(() => {
    mode = 'ok';
    handshakes = requests = tunnels = 0;
  });

  const make = () => new KeepAlivePing({ port: proxyPort, user: 'u', pass: 'p' }, { ca: TEST_CERT });

  it('five checks: one connection, one handshake, five requests', async () => {
    const k = make();
    for (let i = 0; i < 5; i++) expect(await k.ping(2000)).toBeGreaterThan(0);
    expect({ tunnels, handshakes, requests }).toEqual({ tunnels: 1, handshakes: 1, requests: 5 });
    k.close();
  });

  it('the site closed the idle connection: the next check opens a new one and passes', async () => {
    const k = make();
    await k.ping(2000);
    site.closeAllConnections();
    await new Promise((r) => setTimeout(r, 50));
    expect(await k.ping(2000)).toBeGreaterThan(0);
    expect(handshakes).toBe(2);
    k.close();
  });

  it('no answer: the check fails within its timeout and the connection is dropped', async () => {
    const k = make();
    await k.ping(2000);
    mode = 'hang';
    const started = Date.now();
    await expect(k.ping(300)).rejects.toThrow('таймаут');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(k.connected).toBe(false);
    mode = 'ok';
    expect(await k.ping(2000)).toBeGreaterThan(0);
    expect(handshakes).toBe(2);
    k.close();
  });

  it('an answer other than 204 fails the check', async () => {
    const k = make();
    mode = 'error';
    await expect(k.ping(2000)).rejects.toThrow(/503/);
    k.close();
  });

  it('the proxy is gone: the check fails', async () => {
    const k = new KeepAlivePing({ port: 1, user: 'u', pass: 'p' }, { ca: TEST_CERT });
    await expect(k.ping(1000)).rejects.toThrow();
    expect(k.connected).toBe(false);
  });
});
