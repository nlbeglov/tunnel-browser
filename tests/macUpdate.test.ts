import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertReplaceable, bundleOf, downloadVerified, launchSwap, pickMacZip } from '../src/main/macUpdate';

const posix = process.platform !== 'win32';

describe('mac update helpers', () => {
  it('picks the zip for this CPU', () => {
    const files = [
      { url: 'TunnelBrowser-0.2.0-x64.zip', sha512: 'a' },
      { url: 'TunnelBrowser-0.2.0-arm64.zip', sha512: 'b' },
      { url: 'TunnelBrowser-0.2.0-arm64.dmg', sha512: 'c' },
    ];
    expect(pickMacZip(files, 'arm64').sha512).toBe('b');
    expect(pickMacZip(files, 'x64').sha512).toBe('a');
    expect(() => pickMacZip(files, 'ia32')).toThrow();
  });

  it('finds the bundle of the running executable', () => {
    expect(bundleOf('/Applications/Tunnel Browser.app/Contents/MacOS/Tunnel Browser')).toBe('/Applications/Tunnel Browser.app');
    expect(() => bundleOf('/usr/bin/node')).toThrow();
  });

  it('refuses to update a translocated copy', () => {
    expect(() => assertReplaceable('/private/var/folders/x/AppTranslocation/ABC/d/Tunnel Browser.app')).toThrow(/временной копии/);
  });
});

describe('downloadVerified', () => {
  const body = Buffer.from('pretend this is an app zip '.repeat(5000));
  const good = createHash('sha512').update(body).digest('base64');
  let server: http.Server;
  let url = '';
  const dir = mkdtempSync(join(tmpdir(), 'tb-dl-'));

  beforeAll(async () => {
    server = http.createServer((_q, res) => {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/file.zip`;
  });
  afterAll(() => server.close());

  it('keeps a file whose SHA-512 matches and reports progress', async () => {
    const dest = join(dir, 'ok.zip');
    const seen: number[] = [];
    await downloadVerified(url, dest, good, (p) => seen.push(p));
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('deletes a file whose SHA-512 does not match', async () => {
    const dest = join(dir, 'bad.zip');
    await expect(downloadVerified(url, dest, createHash('sha512').update('other').digest('base64'))).rejects.toThrow(/контрольная сумма/);
    expect(existsSync(dest)).toBe(false);
  });
});

describe.skipIf(!posix)('bundle swap after the app exits', () => {
  it('waits for the process, swaps the bundles and starts the new one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tb-swap-'));
    const cur = join(root, 'Apps', 'Tunnel Browser.app');
    const next = join(root, 'staging', 'Tunnel Browser.app');
    mkdirSync(cur, { recursive: true });
    mkdirSync(next, { recursive: true });
    writeFileSync(join(cur, 'version'), 'old');
    writeFileSync(join(next, 'version'), 'new');
    const log = join(root, 'update.log');
    // Stand-in for the running app: the swap must not happen before it exits.
    const app = spawn('/bin/sleep', ['1']);
    const launched = join(root, 'launched');
    const launcher = join(root, 'launch.sh');
    writeFileSync(launcher, `#!/bin/sh\necho "$1" > "${launched}"\n`, { mode: 0o755 });

    launchSwap(app.pid!, cur, next, log, launcher);
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(join(cur, 'version'), 'utf8')).toBe('old'); // app still running

    for (let i = 0; i < 50 && !existsSync(launched); i++) await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(join(cur, 'version'), 'utf8')).toBe('new');
    expect(readFileSync(launched, 'utf8').trim()).toBe(cur);
    expect(readFileSync(log, 'utf8')).toContain('swapped');
  }, 15_000);
});
