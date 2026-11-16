// What happens when the server goes away while the browser is open.
//
// 1. Where the "HTTP 503, empty body" that pages see comes from: Xray's own HTTP inbound,
//    when it cannot reach the server. The tunnel must treat it as a sign of a dead server.
// 2. The tunnel's state machine: a dead server turns the state into "degraded" (tabs hidden)
//    within seconds, the state comes back by itself, and every state change that locks the
//    UI is announced before the slow teardown starts.
// Runs the real bundled Xray core against a server address nobody listens on; the probe
// itself is a fake, so no internet is needed. Skipped without the core (npm run fetch-xray).

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TunnelState } from '../src/shared/types';
import { isProxyFailureResponse } from '../src/main/guard';
import { parseLink } from '../src/main/links';
import { Tunnel, type TunnelOptions } from '../src/main/tunnel';
import { buildXrayConfig } from '../src/main/xrayConfig';
import { XrayProcess, coreFileName, freePort, randomToken } from '../src/main/xray';
import { UUID } from './fixtures';

const OS = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform as 'win32' | 'darwin' | 'linux'];
const CORE = join(__dirname, '..', 'resources', 'xray', `${OS}-${process.arch}`, coreFileName());
const hasCore = existsSync(CORE);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deadServerLink(): Promise<string> {
  const port = await freePort(); // free, so nothing answers there
  return `vless://${UUID}@127.0.0.1:${port}?encryption=none&security=none&type=ws&path=%2Fws#dead`;
}

describe.skipIf(!hasCore)("Xray's answer when the server is unreachable", () => {
  it('plain http gets 503 with an empty body and no Date header', async () => {
    const port = await freePort();
    const creds = { port, user: randomToken(8), pass: randomToken(16) };
    const x = new XrayProcess(CORE);
    await x.start({ config: buildXrayConfig(parseLink(await deadServerLink()), creds), port });
    try {
      const auth = Buffer.from(`${creds.user}:${creds.pass}`).toString('base64');
      const res = await new Promise<{ status: number; headers: Record<string, string[]>; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: 'http://203.0.113.10:8080/ip',
            headers: { Host: '203.0.113.10:8080', 'Proxy-Authorization': `Basic ${auth}` },
          },
          (r) => {
            let body = '';
            r.on('data', (c) => (body += c));
            r.on('end', () => {
              const headers: Record<string, string[]> = {};
              for (let i = 0; i < r.rawHeaders.length; i += 2) (headers[r.rawHeaders[i]] ??= []).push(r.rawHeaders[i + 1]);
              resolve({ status: r.statusCode ?? 0, headers, body });
            });
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(res.status).toBe(503);
      expect(res.body).toBe('');
      expect(isProxyFailureResponse(res.status, res.headers)).toBe(true);
    } finally {
      await x.stop();
    }
  }, 30_000);
});

class FakeGate extends EventEmitter<{ trouble: [] }> {
  open = false;
  closeCalls = 0;
  /** how long closeGate takes; the UI must not wait for it */
  closeDelayMs = 0;
  log: string[] = [];

  async openGate(): Promise<void> {
    this.open = true;
  }

  async closeGate(): Promise<void> {
    this.open = false;
    this.closeCalls++;
    this.log.push('closeGate:start');
    await sleep(this.closeDelayMs);
    this.log.push('closeGate:done');
  }

  closeGateNow(): void {
    this.open = false;
  }
}

describe.skipIf(!hasCore)('tunnel state when the server goes away', () => {
  let tunnel: Tunnel | null = null;
  afterEach(async () => {
    await tunnel?.disconnect();
    tunnel = null;
  });

  async function connected(opts: Partial<TunnelOptions> & { probeOk: () => boolean }) {
    const gate = new FakeGate();
    let probes = 0;
    tunnel = new Tunnel(gate, CORE, undefined, {
      checkEveryMs: 60_000,
      retryAfterMs: 50,
      degradedEveryMs: 50,
      troubleGapMs: 0,
      exitInfo: async () => ({ ip: '198.51.100.7', country: 'NL', latencyMs: 10 }),
      probe: async () => {
        probes++;
        if (!opts.probeOk()) throw new Error('таймаут');
        return 12;
      },
      ...opts,
    });
    const states: TunnelState[] = [];
    tunnel.on('change', (s) => {
      states.push(s);
      gate.log.push(`state:${s.status}`);
    });
    await tunnel.connect(parseLink(await deadServerLink()));
    expect(tunnel.state.status).toBe('connected');
    expect(tunnel.locked).toBe(false);
    return { gate, states, probes: () => probes, t: tunnel };
  }

  async function waitFor(fn: () => boolean, ms = 3000) {
    const until = Date.now() + ms;
    while (!fn() && Date.now() < until) await sleep(10);
    return fn();
  }

  it('trouble in page traffic: down within seconds, tabs locked, back by itself', async () => {
    let up = true;
    const { gate, t } = await connected({ probeOk: () => up });

    up = false;
    gate.emit('trouble'); // a page got Xray's empty 503
    expect(await waitFor(() => t.state.status === 'degraded')).toBe(true);
    expect(t.locked).toBe(true);
    expect(t.state.message).toMatch(/перестал отвечать/);
    // Nothing can leak while degraded, so the gate is left as it is for a quick recovery.
    expect(gate.open).toBe(true);

    up = true;
    expect(await waitFor(() => t.state.status === 'connected')).toBe(true);
    expect(t.locked).toBe(false);
    expect(t.state.exit?.ip).toBe('198.51.100.7');
  });

  it('a quiet page: the regular check finds the dead server too', async () => {
    let up = true;
    const { t } = await connected({ checkEveryMs: 50, probeOk: () => up });
    up = false;
    expect(await waitFor(() => t.state.status === 'degraded')).toBe(true);
  });

  it('one failed check is not enough to hide the tabs', async () => {
    let fails = 1;
    const { gate, states, t } = await connected({
      retryAfterMs: 100,
      probeOk: () => fails-- <= 0,
    });
    gate.emit('trouble');
    await sleep(400);
    expect(states.some((s) => s.status === 'degraded')).toBe(false);
    expect(t.state.status).toBe('connected');
  });

  it('a burst of trouble starts one check, not one per request', async () => {
    const { gate, probes } = await connected({ troubleGapMs: 1000, probeOk: () => true });
    const before = probes();
    await sleep(1100);
    for (let i = 0; i < 20; i++) gate.emit('trouble');
    await sleep(100);
    expect(probes() - before).toBe(1);
  });

  it('disconnect and reconnect lock the UI before the slow teardown', async () => {
    const { gate, t } = await connected({ probeOk: () => true });
    gate.closeDelayMs = 200;

    gate.log = [];
    const reconnect = t.connect(parseLink(await deadServerLink()));
    expect(t.locked).toBe(true); // synchronously, before closeGate has finished
    await reconnect;
    expect(gate.log.slice(0, 3)).toEqual(['closeGate:start', 'state:connecting', 'closeGate:done']);

    gate.log = [];
    const disconnect = t.disconnect();
    expect(t.state.status).toBe('disconnected');
    await disconnect;
    expect(gate.log).toEqual(['closeGate:start', 'state:disconnected', 'closeGate:done']);
  });
});
