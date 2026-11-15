// End-to-end self-test in real Electron: starts a local Xray server (VLESS + Reality),
// launches the app in self-test mode and checks the kill-switch from the inside.
//   npm run smoke            (needs internet and the core: npm run fetch-xray)

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OS = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
const core = join(root, 'resources', 'xray', `${OS}-${process.arch}`, process.platform === 'win32' ? 'tunnel-browser-core.exe' : 'tunnel-browser-core');
if (!existsSync(core)) {
  console.error('Нет ядра Xray. Сначала: npm run fetch-xray');
  process.exit(1);
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

execFileSync(process.execPath, [join(root, 'scripts/build.mjs'), '--smoke'], { stdio: 'inherit' });

const work = mkdtempSync(join(tmpdir(), 'tb-smoke-'));
const keys = execFileSync(core, ['x25519']).toString();
const priv = /PrivateKey:\s*(\S+)/.exec(keys)[1];
const pub = /(?:Password|PublicKey)[^:]*:\s*(\S+)/.exec(keys)[1];
const uuid = execFileSync(core, ['uuid']).toString().trim();
const port = await freePort();
const accessLog = join(work, 'server-access.log');

const serverConfig = {
  log: { loglevel: 'warning', access: accessLog },
  inbounds: [
    {
      listen: '127.0.0.1',
      port,
      protocol: 'vless',
      settings: { clients: [{ id: uuid, flow: 'xtls-rprx-vision' }], decryption: 'none' },
      streamSettings: {
        network: 'raw',
        security: 'reality',
        realitySettings: { target: 'www.microsoft.com:443', serverNames: ['www.microsoft.com'], privateKey: priv, shortIds: ['5eed'] },
      },
    },
  ],
  outbounds: [{ protocol: 'freedom' }],
};
const server = spawn(core, ['run', '-config', 'stdin:'], { stdio: ['pipe', 'ignore', 'inherit'] });
server.stdin.end(JSON.stringify(serverConfig));
await new Promise((r) => setTimeout(r, 1500));

const link = `vless://${uuid}@127.0.0.1:${port}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=${pub}&sid=5eed&type=tcp#Smoke`;
const electron = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const app = spawn(electron, ['.'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, TB_SMOKE: '1', TB_SMOKE_LINK: link, TB_SMOKE_OUT: work, TB_SMOKE_USERDATA: join(work, 'userdata') },
});
const code = await new Promise((r) => app.on('exit', r));
server.kill('SIGKILL');

let viaServer = false;
try {
  viaServer = /cloudflare\.com/.test(readFileSync(accessLog, 'utf8'));
} catch {
  /* no log */
}
console.log(`${viaServer ? 'PASS' : 'FAIL'}  запросы страницы прошли через VPN-сервер (по его журналу)`);
console.log(`\nСкриншоты и results.json: ${work}`);
process.exit(code === 0 && viaServer ? 0 : 1);
