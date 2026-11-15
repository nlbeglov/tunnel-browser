// One-click updates for macOS builds that are not signed with an Apple Developer ID.
//
// Squirrel.Mac (electron-updater's macOS path) only accepts updates whose signature
// matches a Developer ID, so unsigned builds update themselves here instead:
//   1. download the zip for this CPU from the GitHub release, checking SHA-512 from
//      latest-mac.yml (fetched over HTTPS from the same release);
//   2. unpack it with ditto, check the bundle id, the version and that the code
//      signature is intact;
//   3. after the app quits, a small detached shell script swaps the bundles (keeping the
//      old one until the new one is in place) and starts the new version.
// No Electron imports: unit-tested.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, accessSync, createWriteStream, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ReleaseFile {
  url: string;
  sha512: string;
  size?: number;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd}: ${stderr.trim() || err.message}`)) : resolve(stdout.trim()),
    );
  });
}

/** The zip built for this CPU (artifact names end in -arm64.zip / -x64.zip). */
export function pickMacZip(files: ReleaseFile[], arch: string): ReleaseFile {
  const f = files.find((x) => x.url.endsWith(`-${arch}.zip`));
  if (!f) throw new Error(`в релизе нет сборки для ${arch}`);
  return f;
}

/** Path of the .app bundle that contains this executable. */
export function bundleOf(exePath: string): string {
  const i = exePath.indexOf('.app/Contents/MacOS/');
  if (i < 0) throw new Error('приложение запущено не из .app');
  return exePath.slice(0, i + 4);
}

/** The bundle must be somewhere we can replace it: not translocated, folder writable. */
export function assertReplaceable(bundle: string): void {
  if (bundle.includes('/AppTranslocation/')) {
    throw new Error('macOS запустил приложение из временной копии. Перенесите его в «Программы» и откройте снова.');
  }
  try {
    accessSync(dirname(bundle), constants.W_OK);
    accessSync(bundle, constants.W_OK);
  } catch {
    throw new Error(`нет прав на запись в ${dirname(bundle)}. Перенесите приложение в «Программы».`);
  }
}

export async function downloadVerified(
  url: string,
  dest: string,
  sha512Base64: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'tunnel-browser-updater' } });
  if (!res.ok || !res.body) throw new Error(`не удалось скачать обновление: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha512');
  const out = createWriteStream(dest);
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      got += value.length;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      if (total) onProgress?.(Math.min(99, Math.floor((got / total) * 100)));
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  }
  if (hash.digest('base64') !== sha512Base64) {
    rmSync(dest, { force: true });
    throw new Error('контрольная сумма обновления не совпадает — файл повреждён или подменён');
  }
}

export async function unpackApp(zip: string, dir: string): Promise<string> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await run('/usr/bin/ditto', ['-x', '-k', zip, dir]);
  const app = readdirSync(dir).find((n) => n.endsWith('.app'));
  if (!app) throw new Error('в архиве обновления нет приложения');
  return join(dir, app);
}

export async function checkBundle(bundle: string, expect: { bundleId: string; version: string }): Promise<void> {
  const plist = join(bundle, 'Contents', 'Info.plist');
  const read = (key: string) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
  const [id, version] = await Promise.all([read('CFBundleIdentifier'), read('CFBundleShortVersionString')]);
  if (id !== expect.bundleId) throw new Error(`обновление от другого приложения (${id})`);
  if (version !== expect.version) throw new Error(`в архиве версия ${version}, а ожидалась ${expect.version}`);
  // Ad-hoc or Developer ID, the signature must cover every file unchanged.
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
}

/**
 * Waits for the app (pid) to exit, swaps the bundles and starts the new one. If the new
 * bundle cannot be moved in, the old one is put back. Arguments: pid, current bundle,
 * new bundle, log file, launcher ("open" in real use).
 */
export const SWAP_SCRIPT = `
PID="$1"; CUR="$2"; NEW="$3"; LOG="$4"; LAUNCH="$5"
exec >>"$LOG" 2>&1
echo "$(date) update: waiting for $PID"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i+1)); if [ "$i" -gt 600 ]; then echo "app did not exit"; exit 1; fi
  sleep 0.1
done
BACKUP="$CUR.previous-$$"
if mv "$CUR" "$BACKUP"; then
  if mv "$NEW" "$CUR"; then
    rm -rf "$BACKUP"
    echo "swapped"
  else
    mv "$BACKUP" "$CUR"
    echo "swap failed, restored the old version"
  fi
else
  echo "could not move the current app"
fi
"$LAUNCH" "$CUR"
`;

export function launchSwap(pid: number, current: string, next: string, logFile: string, launcher = '/usr/bin/open'): void {
  const child = spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'tb-update', String(pid), current, next, logFile, launcher], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
