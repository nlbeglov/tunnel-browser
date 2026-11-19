// Tunnel lifecycle: start Xray, verify the path end to end, only then open the browser gate.
// Any failure, crash or disconnect closes the gate before anything else happens.
//
// This class is the one source of truth for the tunnel's state. The UI and the tabs only
// follow `change` events; the gate reports trouble it sees in page traffic and the tunnel
// confirms it with its own probe before the state changes.

import { EventEmitter } from 'node:events';
import type { ServerProfile, TunnelState } from '../shared/types';
import { checkTunnel, exitInfo, measureLatency, releaseTunnel, type ExitInfo, type ProxyEndpoint } from './health';
import type { TunnelSession } from './tunnelSession';
import { buildXrayConfig } from './xrayConfig';
import { freePort, randomToken, XrayProcess } from './xray';

/** The part of the gate the tunnel drives (TunnelSession; a fake in tests). */
export type TunnelGate = Pick<TunnelSession, 'openGate' | 'closeGate' | 'closeGateNow'> & {
  on(event: 'trouble', listener: () => void): unknown;
};

export interface TunnelOptions {
  /** between checks while the tunnel works */
  checkEveryMs: number;
  /** after one failed check the next comes quickly, to confirm or clear it */
  retryAfterMs: number;
  /** while the server is down: how often to look for it coming back */
  degradedEveryMs: number;
  /** trouble seen in page traffic starts a check at most this often */
  troubleGapMs: number;
  probeTimeoutMs: number;
  /** consecutive failed checks before the tunnel counts as down */
  failuresBeforeDown: number;
  /** the regular check; `fresh`: over new connections instead of the kept one (health.ts) */
  probe: (proxy: ProxyEndpoint, timeoutMs: number, fresh: boolean) => Promise<number>;
  /** the tunnel is gone: let go of what `probe` keeps for it */
  release: (proxy: ProxyEndpoint) => void;
  exitInfo: (proxy: ProxyEndpoint) => Promise<ExitInfo>;
  measure: (proxy: ProxyEndpoint) => Promise<number>;
  /**
   * Runs after the exit is known and before the gate opens, so pages can reach nothing yet:
   * they get the exit's time zone (pageGuard.ts), and the user can be asked about a new IP.
   * `cancel` leaves the tunnel disconnected.
   */
  beforeOpen: (exit: ExitInfo, profile: ServerProfile) => Promise<{ timezone?: string; cancel?: boolean } | void>;
}

const DEFAULTS: TunnelOptions = {
  checkEveryMs: 10_000,
  retryAfterMs: 1_000,
  degradedEveryMs: 3_000,
  troubleGapMs: 3_000,
  probeTimeoutMs: 5_000,
  failuresBeforeDown: 2,
  probe: checkTunnel,
  release: releaseTunnel,
  exitInfo,
  measure: (proxy) => measureLatency(proxy),
  beforeOpen: async () => {},
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class Tunnel extends EventEmitter<{ change: [TunnelState] }> {
  private st: TunnelState = { status: 'disconnected' };
  private readonly xray: XrayProcess;
  private readonly opt: TunnelOptions;
  private creds: ProxyEndpoint | null = null;
  private monitor: NodeJS.Timeout | null = null;
  private failures = 0;
  /** generation of the check in flight, if any */
  private checking: number | null = null;
  private lastCheckAt = 0;
  /** bumps on every connect/disconnect so a slow, superseded attempt cannot win */
  private generation = 0;
  /** the next check goes over new connections (pages reported trouble) */
  private freshNext = false;

  constructor(
    private readonly gate: TunnelGate,
    binPath: string,
    pidFile?: string,
    options: Partial<TunnelOptions> = {},
  ) {
    super();
    this.opt = { ...DEFAULTS, ...options };
    this.xray = new XrayProcess(binPath, pidFile);
    this.xray.on('exit', (code, expected, signal) => {
      if (expected) return;
      this.generation++;
      this.stopMonitor();
      this.dropCreds();
      this.gate.closeGateNow();
      this.set({
        status: 'error',
        profileId: this.st.profileId,
        profileName: this.st.profileName,
        message: `Ядро Xray неожиданно завершилось (${code !== null ? `код ${code}` : `сигнал ${signal ?? '?'}`}). Браузер заблокирован.`,
      });
    });
    gate.on('trouble', () => this.trouble());
  }

  get state(): TunnelState {
    return this.st;
  }

  /** Tabs are hidden and navigation is off unless the tunnel is verified and answering. */
  get locked(): boolean {
    return this.st.status !== 'connected';
  }

  logs(): string[] {
    return this.xray.logs();
  }

  private dropCreds() {
    if (this.creds) this.opt.release(this.creds);
    this.creds = null;
  }

  private set(s: TunnelState) {
    this.st = s;
    this.emit('change', s);
  }

  async connect(profile: ServerProfile): Promise<void> {
    const gen = ++this.generation;
    this.stopMonitor();
    this.dropCreds();
    // The gate drops synchronously inside closeGate(); the UI locks in the same tick, before
    // any of the slow teardown below, so no tab is left on screen with a stale status.
    const closing = this.gate.closeGate();
    this.set({ status: 'connecting', profileId: profile.id, profileName: profile.name });

    try {
      await closing;
      await this.xray.stop();
      if (gen !== this.generation) return;
      const port = await freePort();
      const creds: ProxyEndpoint = { port, user: randomToken(12), pass: randomToken(24) };
      await this.xray.start({ config: buildXrayConfig(profile, creds), port });
      if (gen !== this.generation) return;

      // The gate stays closed until a real request has made it through the server.
      const exit = await this.opt.exitInfo(creds).catch((e) => {
        throw new Error(`сервер не отвечает: ${errorText(e)}`);
      });
      if (gen !== this.generation) return;
      const { cancel, ...extra } = (await this.opt.beforeOpen(exit, profile)) ?? {};
      if (gen !== this.generation) return;
      if (cancel) {
        await this.xray.stop();
        this.set({ status: 'disconnected' });
        return;
      }

      await this.gate.openGate(creds);
      if (gen !== this.generation) {
        await this.gate.closeGate();
        return;
      }
      this.creds = creds;
      this.failures = 0;
      this.freshNext = false;
      this.lastCheckAt = Date.now();
      this.set({ status: 'connected', profileId: profile.id, profileName: profile.name, exit: { ...exit, ...extra }, since: Date.now() });
      this.schedule(gen, this.opt.checkEveryMs);
    } catch (e) {
      if (gen !== this.generation) return;
      await this.gate.closeGate().catch(() => {});
      await this.xray.stop();
      this.dropCreds();
      this.set({ status: 'error', profileId: profile.id, profileName: profile.name, message: errorText(e) });
    }
  }

  async disconnect(): Promise<void> {
    this.generation++;
    this.stopMonitor();
    this.dropCreds();
    const closing = this.gate.closeGate();
    this.set({ status: 'disconnected' });
    try {
      await closing;
    } finally {
      await this.xray.stop();
    }
  }

  /** For app exit: no awaiting. Everything is stopped first, then the UI is told. */
  killNow(): void {
    this.generation++;
    this.stopMonitor();
    this.gate.closeGateNow();
    this.xray.killNow();
    this.dropCreds();
    if (this.st.status === 'disconnected') return;
    try {
      this.set({ status: 'disconnected' });
    } catch {
      // the window may already be gone
    }
  }

  /** Measures the ping again on request (the button next to it). */
  async measureLatency(): Promise<number | undefined> {
    const gen = this.generation;
    const creds = this.creds;
    if (!creds || this.st.status !== 'connected') return undefined;
    const ms = await this.opt.measure(creds);
    if (gen !== this.generation || !this.st.exit) return undefined;
    this.set({ ...this.st, exit: { ...this.st.exit, latencyMs: ms } });
    return ms;
  }

  /**
   * A page request failed the way it does when the server is gone (Xray answers plain http
   * with an empty 503 and drops https streams). Check now instead of waiting for the timer.
   */
  trouble(): void {
    if (this.st.status !== 'connected' || this.checking === this.generation) return;
    if (Date.now() - this.lastCheckAt < this.opt.troubleGapMs) return;
    this.freshNext = true;
    void this.check(this.generation);
  }

  private schedule(gen: number, ms: number) {
    this.stopMonitor();
    this.monitor = setTimeout(() => void this.check(gen), ms);
  }

  private stopMonitor() {
    if (this.monitor) clearTimeout(this.monitor);
    this.monitor = null;
  }

  private async check(gen: number) {
    const creds = this.creds;
    if (!creds || gen !== this.generation || this.checking === gen) return;
    this.stopMonitor();
    this.checking = gen;
    this.lastCheckAt = Date.now();
    // Over the kept connection while all is well; over new ones once anything looked wrong.
    const fresh = this.freshNext || this.failures > 0 || this.st.status !== 'connected';
    this.freshNext = false;
    let latencyMs: number | null = null;
    let error: unknown;
    try {
      latencyMs = await this.opt.probe(creds, this.opt.probeTimeoutMs, fresh);
    } catch (e) {
      error = e;
    } finally {
      if (this.checking === gen) this.checking = null;
    }
    if (gen !== this.generation) return;

    if (latencyMs !== null) {
      this.failures = 0;
      // Every check shows its own round trip: a ping that keeps changing shows the tunnel is alive.
      const exit = this.st.exit ? { ...this.st.exit, latencyMs } : undefined;
      this.set({ ...this.st, status: 'connected', message: undefined, exit });
      this.schedule(gen, this.opt.checkEveryMs);
      return;
    }
    this.failures++;
    if (this.failures < this.opt.failuresBeforeDown) {
      this.schedule(gen, this.opt.retryAfterMs);
      return;
    }
    // The gate stays open: requests can only go to Xray, which cannot reach the server, so
    // nothing leaks. The tabs are hidden (see `locked`) and come back on their own as soon
    // as a check passes again.
    const message = `Сервер перестал отвечать: ${errorText(error)}`;
    if (this.st.status !== 'degraded' || this.st.message !== message) this.set({ ...this.st, status: 'degraded', message });
    this.schedule(gen, this.opt.degradedEveryMs);
  }
}
