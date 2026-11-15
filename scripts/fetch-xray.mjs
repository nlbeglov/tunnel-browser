// Downloads the official Xray-core release for a platform, checks it against a SHA-256
// pinned in this repository, and puts the binary into resources/xray/<os>-<arch>/.
//
//   node scripts/fetch-xray.mjs                      # host platform
//   node scripts/fetch-xray.mjs --platform win32 --arch x64
//
// To upgrade Xray: change XRAY_VERSION, take the SHA2-256 values from the *.zip.dgst
// files of that GitHub release, and update the table below.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const XRAY_VERSION = 'v26.10.31';

const ASSETS = {
  'win32-x64': { file: 'Xray-windows-64.zip', sha256: '2e04a9995a6f2ad1b28c0bb25c708ecb2695e43a1c9c7889c4b6ac2b48cf7a6a' },
  'win32-arm64': { file: 'Xray-windows-arm64-v8a.zip', sha256: 'db062e8a177facacc8ae53d4c9c0df4132b13fc3a89acda6f21d92d36633077e' },
  'darwin-x64': { file: 'Xray-macos-64.zip', sha256: '37c60b63c77ef5edcfb46a0d70349f7d96e0c132e6a356ead4fd20aeeacc5c75' },
  'darwin-arm64': { file: 'Xray-macos-arm64-v8a.zip', sha256: '0a05dca3bd311b0bc5a89c7ce56350cab1e829e131e4b2bcd48eb304fac07e9a' },
};

// electron-builder's ${os} macro names
const OS_NAME = { win32: 'win', darwin: 'mac', linux: 'linux' };
export const CORE_NAME = 'tunnel-browser-core';

/**
 * Unzips with the system's own tools. On Windows, call the built-in bsdtar by full path:
 * a bare "tar" from Git Bash is GNU tar, which reads "C:\..." as host "C" and hangs trying
 * to reach it. PowerShell is the fallback for Windows builds without tar.exe.
 */
function extractZip(zip, dest) {
  const opts = { stdio: 'inherit', timeout: 120_000, windowsHide: true };
  if (process.platform === 'win32') {
    const bsdtar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (existsSync(bsdtar)) return execFileSync(bsdtar, ['-xf', zip, '-C', dest], opts);
    const q = (p) => `'${p.replace(/'/g, "''")}'`; // PowerShell single-quoted literal
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(dest)} -Force`],
      opts,
    );
  }
  if (process.platform === 'darwin') return execFileSync('/usr/bin/tar', ['-xf', zip, '-C', dest], opts);
  return execFileSync('unzip', ['-q', zip, '-d', dest], opts);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const platform = arg('platform', process.platform);
const arch = arg('arch', process.arch);
const key = `${platform}-${arch}`;
const asset = ASSETS[key];
if (!asset) {
  console.error(`Нет сборки Xray для ${key}. Поддерживаются: ${Object.keys(ASSETS).join(', ')}`);
  process.exit(1);
}

const exe = platform === 'win32' ? `${CORE_NAME}.exe` : CORE_NAME;
const outDir = join(root, 'resources', 'xray', `${OS_NAME[platform]}-${arch}`);
const outBin = join(outDir, exe);
const stamp = join(outDir, 'VERSION');

if (existsSync(outBin) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === `${XRAY_VERSION} ${asset.sha256}`) {
  console.log(`Xray ${XRAY_VERSION} для ${key} уже на месте: ${outBin}`);
  process.exit(0);
}

const url = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${asset.file}`;
console.log(`Скачиваю ${url}`);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) {
  console.error(`Не удалось скачать: HTTP ${res.status}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const actual = createHash('sha256').update(buf).digest('hex');
if (actual !== asset.sha256) {
  console.error(`SHA-256 не совпадает!\n  ожидался ${asset.sha256}\n  получен  ${actual}`);
  process.exit(1);
}
console.log('SHA-256 совпадает с закреплённым значением');

const work = join(tmpdir(), `xray-${key}-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const zipPath = join(work, asset.file);
writeFileSync(zipPath, buf);
extractZip(zipPath, work);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
copyFileSync(join(work, platform === 'win32' ? 'xray.exe' : 'xray'), outBin);
if (platform !== 'win32') chmodSync(outBin, 0o755);
copyFileSync(join(work, 'LICENSE'), join(outDir, 'XRAY-LICENSE.txt'));
writeFileSync(stamp, `${XRAY_VERSION} ${asset.sha256}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`Готово: ${outBin}`);
