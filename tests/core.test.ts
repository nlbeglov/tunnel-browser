// Runs generated configs through the real bundled Xray core:
//  - every supported link format must pass `xray run -test`;
//  - real tunnels to a local Xray "server" must carry traffic (needs internet);
//  - the client must refuse to carry traffic to localhost / LAN.
// Skipped when the core has not been downloaded (npm run fetch-xray).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getViaProxy, probeTunnel } from '../src/main/health';
import { parseLink } from '../src/main/links';
import { buildXrayConfig } from '../src/main/xrayConfig';
import { XrayProcess, coreFileName, freePort, randomToken } from '../src/main/xray';
import { LINKS } from './fixtures';

const OS = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform as 'win32' | 'darwin' | 'linux'];
const CORE = join(__dirname, '..', 'resources', 'xray', `${OS}-${process.arch}`, coreFileName());
const hasCore = existsSync(CORE);
const online = !process.env.NO_NETWORK;

function testConfig(config: unknown): { ok: boolean; out: string } {
  try {
    const out = execFileSync(CORE, ['run', '-test', '-config', 'stdin:'], { input: JSON.stringify(config), stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, out: out.toString() };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe.skipIf(!hasCore)('generated configs pass xray -test', () => {
  for (const [name, link] of Object.entries(LINKS)) {
    it(name, () => {
      const cfg = buildXrayConfig(parseLink(link), { port: 10808, user: 'u', pass: 'p' });
      const r = testConfig(cfg);
      expect(r.ok, r.out).toBe(true);
    });
  }
});

describe.skipIf(!hasCore || !online)('real tunnels through a local server', () => {
  let server: ChildProcess;
  const links: Record<string, string> = {};
  let canary: http.Server;
  let canaryPort = 0;
  let canaryHits = 0;

  beforeAll(async () => {
    const keys = execFileSync(CORE, ['x25519']).toString();
    const priv = /PrivateKey:\s*(\S+)/.exec(keys)![1];
    const pub = /(?:Password|PublicKey)[^:]*:\s*(\S+)/.exec(keys)![1];
    const uuid = execFileSync(CORE, ['uuid']).toString().trim();
    const ssKey = Buffer.from(randomToken(16)).subarray(0, 16).toString('base64');
    const [pReality, pWs, pSs, pVmess] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);

    const config = {
      log: { loglevel: 'warning' },
      inbounds: [
        {
          listen: '127.0.0.1',
          port: pReality,
          protocol: 'vless',
          settings: { clients: [{ id: uuid, flow: 'xtls-rprx-vision' }], decryption: 'none' },
          streamSettings: {
            network: 'raw',
            security: 'reality',
            realitySettings: { target: 'www.microsoft.com:443', serverNames: ['www.microsoft.com'], privateKey: priv, shortIds: ['a1b2c3d4'] },
          },
        },
        {
          listen: '127.0.0.1',
          port: pWs,
          protocol: 'vless',
          settings: { clients: [{ id: uuid }], decryption: 'none' },
          streamSettings: { network: 'ws', wsSettings: { path: '/ws' } },
        },
        { listen: '127.0.0.1', port: pSs, protocol: 'shadowsocks', settings: { method: '2022-blake3-aes-128-gcm', password: ssKey, network: 'tcp' } },
        {
          listen: '127.0.0.1',
          port: pVmess,
          protocol: 'vmess',
          settings: { clients: [{ id: uuid }] },
          streamSettings: { network: 'xhttp', xhttpSettings: { path: '/xh' } },
        },
      ],
      outbounds: [{ protocol: 'freedom' }],
    };
    const t = testConfig(config);
    if (!t.ok) throw new Error(`server config rejected: ${t.out}`);
    server = spawn(CORE, ['run', '-config', 'stdin:'], { stdio: ['pipe', 'ignore', 'inherit'] });
    server.stdin!.on('error', () => {});
    server.stdin!.end(JSON.stringify(config));
    await new Promise((r) => setTimeout(r, 1500));

    links.reality = `vless://${uuid}@127.0.0.1:${pReality}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=${pub}&sid=a1b2c3d4&type=tcp#reality`;
    links.ws = `vless://${uuid}@127.0.0.1:${pWs}?encryption=none&security=none&type=ws&path=%2Fws#ws`;
    links.ss2022 = `ss://2022-blake3-aes-128-gcm:${encodeURIComponent(ssKey)}@127.0.0.1:${pSs}#ss`;
    links.vmessXhttp =
      'vmess://' +
      Buffer.from(JSON.stringify({ v: '2', ps: 'vm', add: '127.0.0.1', port: String(pVmess), id: uuid, net: 'xhttp', path: '/xh', tls: '' })).toString('base64');

    canary = http.createServer((_q, s) => {
      canaryHits++;
      s.end('canary');
    });
    await new Promise<void>((r) => canary.listen(0, '127.0.0.1', r));
    canaryPort = (canary.address() as { port: number }).port;
  }, 30_000);

  afterAll(() => {
    server?.kill('SIGKILL');
    canary?.close();
  });

  async function withClient<T>(link: string, fn: (p: { port: number; user: string; pass: string }) => Promise<T>): Promise<T> {
    const port = await freePort();
    const creds = { port, user: randomToken(8), pass: randomToken(16) };
    const x = new XrayProcess(CORE);
    await x.start({ config: buildXrayConfig(parseLink(link), creds), port });
    try {
      return await fn(creds);
    } finally {
      await x.stop();
    }
  }

  for (const name of ['reality', 'ws', 'ss2022', 'vmessXhttp']) {
    it(`${name}: traffic reaches the internet through the server`, async () => {
      const ms = await withClient(links[name], (c) => probeTunnel(c, 10_000));
      expect(ms).toBeGreaterThan(0);
    }, 30_000);
  }

  it('wrong proxy password is refused', async () => {
    await withClient(links.ws, async (c) => {
      await expect(getViaProxy({ ...c, pass: 'wrong' }, 'www.gstatic.com', '/generate_204', 5000)).rejects.toThrow();
    });
  }, 30_000);

  it('the tunnel refuses localhost and LAN destinations', async () => {
    await withClient(links.ws, async (c) => {
      const tryConnect = (target: string) =>
        new Promise<number>((resolve) => {
          const auth = Buffer.from(`${c.user}:${c.pass}`).toString('base64');
          const req = http.request({ host: '127.0.0.1', port: c.port, method: 'CONNECT', path: target, headers: { 'Proxy-Authorization': `Basic ${auth}` } });
          req.on('connect', (res, sock) => {
            // Xray answers 200 then the blackhole drops the stream; send a request and see.
            sock.write(`GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
            let got = '';
            sock.on('data', (d) => (got += d));
            sock.on('close', () => resolve(got.includes('canary') ? 1 : 0));
            sock.on('error', () => resolve(0));
            setTimeout(() => {
              sock.destroy();
              resolve(got.includes('canary') ? 1 : 0);
            }, 3000);
            void res;
          });
          req.on('error', () => resolve(0));
          req.end();
        });
      expect(await tryConnect(`127.0.0.1:${canaryPort}`)).toBe(0);
      expect(await tryConnect(`[::ffff:127.0.0.1]:${canaryPort}`)).toBe(0);
      expect(await tryConnect(`localhost:${canaryPort}`)).toBe(0);
      expect(canaryHits).toBe(0);
    });
  }, 30_000);
});
