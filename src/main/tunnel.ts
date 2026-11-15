// Tunnel lifecycle: start Xray, verify the path end to end, only then open the browser gate.
// Any failure, crash or disconnect closes the gate before anything else happens.

import { EventEmitter } from 'node:events';
import type { ServerProfile, TunnelState } from '../shared/types';
import { exitInfo, probeTunnel, type ProxyEndpoint } from './health';
import { TunnelSession } from './tunnelSession';
import { buildXrayConfig } from './xrayConfig';
import { freePort, randomToken, XrayProcess } from './xray';

const MONITOR_EVERY_MS = 30_000;
const FAILURES_BEFORE_DEGRADED = 2;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class Tunnel extends EventEmitter<{ change: [TunnelState] }> {
  private st: TunnelState = { status: 'disconnected' };
  private readonly xray: XrayProcess;
  private creds: ProxyEndpoint | null = null;
  private monitor: NodeJS.Timeout | null = null;
  private failures = 0;
  /** bumps on every connect/disconnect so a slow, superseded attempt cannot win */
  private generation = 0;

  constructor(
    private readonly gate: TunnelSession,
    binPath: string,
    pidFile: string,
  ) {
    super();
    this.xray = new XrayProcess(binPath, pidFile);
    this.xray.on('exit', (code, expected, signal) => {
      if (expected) return;
      this.generation++;
      this.stopMonitor();
      this.gate.closeGateNow();
      this.set({
        status: 'error',
        profileId: this.st.profileId,
        profileName: this.st.profileName,
        message: `Ядро Xray неожиданно завершилось (${code !== null ? `код ${code}` : `сигнал ${signal ?? '?'}`}). Браузер заблокирован.`,
      });
    });
  }

  get state(): TunnelState {
    return this.st;
  }

  get locked(): boolean {
    return this.st.status !== 'connected' && this.st.status !== 'degraded';
  }

  logs(): string[] {
    return this.xray.logs();
  }

  private set(s: TunnelState) {
    this.st = s;
    this.emit('change', s);
  }

  async connect(profile: ServerProfile): Promise<void> {
    const gen = ++this.generation;
    this.stopMonitor();
    await this.gate.closeGate();
    await this.xray.stop();
    this.set({ status: 'connecting', profileId: profile.id, profileName: profile.name });

    try {
      const port = await freePort();
      const creds: ProxyEndpoint = { port, user: randomToken(12), pass: randomToken(24) };
      await this.xray.start({ config: buildXrayConfig(profile, creds), port });
      if (gen !== this.generation) return;

      // The gate stays closed until a real request has made it through the server.
      const exit = await exitInfo(creds).catch((e) => {
        throw new Error(`сервер не отвечает: ${errorText(e)}`);
      });
      if (gen !== this.generation) return;

      await this.gate.openGate(creds);
      if (gen !== this.generation) {
        await this.gate.closeGate();
        return;
      }
      this.creds = creds;
      this.failures = 0;
      this.set({ status: 'connected', profileId: profile.id, profileName: profile.name, exit, since: Date.now() });
      this.startMonitor(gen);
    } catch (e) {
      if (gen !== this.generation) return;
      await this.gate.closeGate();
      await this.xray.stop();
      this.creds = null;
      this.set({ status: 'error', profileId: profile.id, profileName: profile.name, message: errorText(e) });
    }
  }

  async disconnect(): Promise<void> {
    this.generation++;
    this.stopMonitor();
    await this.gate.closeGate();
    await this.xray.stop();
    this.creds = null;
    this.set({ status: 'disconnected' });
  }

  /** For app exit: no awaiting, just make sure nothing is left running. */
  killNow(): void {
    this.generation++;
    this.stopMonitor();
    this.gate.closeGateNow();
    this.xray.killNow();
  }

  private startMonitor(gen: number) {
    this.stopMonitor();
    this.monitor = setInterval(() => void this.check(gen), MONITOR_EVERY_MS);
  }

  private stopMonitor() {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
  }

  private async check(gen: number) {
    const creds = this.creds;
    if (!creds || gen !== this.generation) return;
    try {
      const latencyMs = await probeTunnel(creds);
      if (gen !== this.generation) return;
      this.failures = 0;
      const exit = this.st.exit ? { ...this.st.exit, latencyMs } : undefined;
      this.set({ ...this.st, status: 'connected', message: undefined, exit });
    } catch (e) {
      if (gen !== this.generation) return;
      this.failures++;
      if (this.failures >= FAILURES_BEFORE_DEGRADED) {
        // The gate stays open: requests can only go to Xray, which cannot reach the server,
        // so nothing leaks. We only tell the user why pages are not loading.
        this.set({ ...this.st, status: 'degraded', message: `Сервер перестал отвечать: ${errorText(e)}` });
      }
    }
  }
}
