// Runs the bundled Xray binary as a child process. Config goes in through stdin, so
// server credentials never touch the disk. No Electron imports: usable from tests.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';

export const CORE_NAME = 'tunnel-browser-core';

export function coreFileName(platform = process.platform): string {
  return platform === 'win32' ? `${CORE_NAME}.exe` : CORE_NAME;
}

/** Asks the OS for a free loopback port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

export function randomToken(bytes = 18): string {
  return randomBytes(bytes).toString('base64url');
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(500, () => done(false));
  });
}

function processName(pid: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) =>
        resolve(err ? '' : out),
      );
    } else {
      execFile('ps', ['-p', String(pid), '-o', 'comm='], (err, out) => resolve(err ? '' : out));
    }
  });
}

/**
 * If the app crashed last time, its Xray child may still be running and holding a port.
 * Kill it, but only if that PID really is our core binary (PIDs get reused).
 */
export async function killStaleCore(pidFile: string): Promise<void> {
  if (!existsSync(pidFile)) return;
  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    if (Number.isInteger(pid) && pid > 0 && (await processName(pid)).includes(CORE_NAME)) {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
  rmSync(pidFile, { force: true });
}

export interface StartOptions {
  config: unknown;
  port: number;
  timeoutMs?: number;
}

export class XrayProcess extends EventEmitter<{ exit: [code: number | null, expected: boolean, signal: string | null] }> {
  private child: ChildProcess | null = null;
  private stopping = false;
  private logLines: string[] = [];

  constructor(
    private readonly binPath: string,
    private readonly pidFile?: string,
    private readonly assetDir?: string,
  ) {
    super();
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  logs(): string[] {
    return [...this.logLines];
  }

  private log(chunk: Buffer) {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.logLines.push(line);
      if (this.logLines.length > 200) this.logLines.shift();
    }
  }

  async start({ config, port, timeoutMs = 8000 }: StartOptions): Promise<void> {
    if (this.child) await this.stop();
    if (!existsSync(this.binPath)) throw new Error(`не найдено ядро Xray: ${this.binPath}`);
    this.stopping = false;
    this.logLines = [];

    const child = spawn(this.binPath, ['run', '-config', 'stdin:'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...(this.assetDir ? { XRAY_LOCATION_ASSET: this.assetDir } : {}) },
    });
    this.child = child;
    child.stdout?.on('data', (c: Buffer) => this.log(c));
    child.stderr?.on('data', (c: Buffer) => this.log(c));
    if (this.pidFile && child.pid) writeFileSync(this.pidFile, String(child.pid));

    let exited = false;
    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        exited = true;
        if (this.child === child) this.child = null;
        if (this.pidFile) rmSync(this.pidFile, { force: true });
        this.emit('exit', code, this.stopping, signal);
        resolve();
      });
    });
    child.once('error', (e) => this.logLines.push(`spawn error: ${e.message}`));
    // If the core dies before reading its config, writing to stdin fails with EPIPE.
    child.stdin?.on('error', (e) => this.logLines.push(`stdin: ${e.message}`));
    child.stdin?.end(JSON.stringify(config));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited) break;
      if (await canConnect(port)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!exited) {
      child.kill('SIGKILL');
      await exitPromise;
    }
    const tail = this.logLines.slice(-5).join('\n');
    throw new Error(`ядро Xray не запустилось${tail ? `:\n${tail}` : ''}`);
  }

  stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.resolve();
    this.stopping = true;
    return new Promise((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.kill();
    });
  }

  /** Synchronous kill for process exit paths where we cannot await. */
  killNow(): void {
    this.stopping = true;
    this.child?.kill('SIGKILL');
  }
}

export function coreVersion(binPath: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(binPath, ['version'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      const m = /Xray\s+(\S+)/.exec(out ?? '');
      resolve(err || !m ? 'неизвестно' : m[1]);
    });
  });
}
