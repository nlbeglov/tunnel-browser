// Regression test: connection trouble during a tunnel probe must reject the probe, never
// crash the process. First seen on Windows CI: a TLS error after the handshake followed by
// a TCP reset produced an uncaught "read ECONNRESET".
// A fake proxy relays to a real HTTPS host and breaks the stream in different ways.

import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getViaProxy } from '../src/main/health';

type Mode = 'corrupt-then-reset' | 'garbage-then-reset' | 'reset-after-200' | 'reset-after-first-data';

const online = !process.env.NO_NETWORK;

describe.skipIf(!online)('health probe survives broken connections', () => {
  let mode: Mode = 'reset-after-200';
  let proxy: net.Server;
  let port = 0;
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => uncaught.push(e);

  beforeAll(async () => {
    process.on('uncaughtException', onUncaught);
    proxy = net.createServer((client) => {
      client.on('error', () => {});
      client.once('data', (d) => {
        const [host, p] = /^CONNECT ([^ ]+) /.exec(d.toString())![1].split(':');
        if (mode === 'reset-after-200') {
          client.write('HTTP/1.1 200 Connection established\r\n\r\n', () => client.resetAndDestroy());
          return;
        }
        if (mode === 'garbage-then-reset') {
          client.write('HTTP/1.1 200 Connection established\r\n\r\n');
          client.once('data', () => {
            client.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            setTimeout(() => client.resetAndDestroy(), 2);
          });
          return;
        }
        const up = net.connect(Number(p), host, () => client.write('HTTP/1.1 200 Connection established\r\n\r\n'));
        up.on('error', () => client.destroy());
        let fromClient = 0;
        client.on('data', (c) => {
          fromClient++;
          up.write(c);
        });
        up.on('data', (c) => {
          if (client.destroyed) return;
          if (mode === 'corrupt-then-reset' && fromClient >= 2) {
            // After the handshake: damage an encrypted record, then reset like Windows does.
            const bad = Buffer.from(c);
            bad[bad.length - 1] ^= 0xff;
            client.write(bad);
            setTimeout(() => client.resetAndDestroy(), 20);
            return;
          }
          client.write(c);
          if (mode === 'reset-after-first-data') client.resetAndDestroy();
        });
        up.on('end', () => client.end());
      });
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    port = (proxy.address() as net.AddressInfo).port;
  });

  afterAll(() => {
    proxy.close();
    process.off('uncaughtException', onUncaught);
  });

  for (const m of ['corrupt-then-reset', 'garbage-then-reset', 'reset-after-200', 'reset-after-first-data'] as Mode[]) {
    it(m, async () => {
      mode = m;
      uncaught.length = 0;
      for (let i = 0; i < 3; i++) {
        await expect(getViaProxy({ port, user: 'u', pass: 'p' }, 'www.gstatic.com', '/generate_204', 5000)).rejects.toThrow();
      }
      await new Promise((r) => setTimeout(r, 300));
      expect(uncaught.map(String)).toEqual([]);
    }, 30_000);
  }
});
