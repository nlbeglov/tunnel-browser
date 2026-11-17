// Makes every page of the tunnel session report the exit's time zone and a neutral language
// and locale instead of this computer's (see identity.ts for why).
//
// Chromium has no switch for that, so each page runs under an attached DevTools session:
//  - a tab first loads about:blank, the session attaches and sets the overrides, and only
//    then the real page loads, so even the page's first script sees them;
//  - frames in other processes and dedicated workers start paused (waitForDebuggerOnStart)
//    and are released once their overrides are in;
//  - until a page is covered, the gate cancels every request it makes (isReady), so a page
//    that could see the real values has no way to send them anywhere.
// Shared and service workers, which can outlive their pages, are switched off for the
// session (index.ts, tunnelSession.ts).
//
// In Chromium the time zone and locale overrides are per renderer process and belong to
// the session that set them first; when that page goes away, the process loses them. So
// whenever a session ends, every remaining session sets them again.

import type { WebContents } from 'electron';
import { NEUTRAL_IDENTITY, type SiteIdentity } from './identity';

/** navigator.userAgentData as the real browser reports it (keeps client hints intact). */
export interface UaMetadata {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness?: string;
  wow64?: boolean;
}

interface Page {
  wc: WebContents;
  ready: boolean;
  listening?: boolean;
  /** child sessions (frames, workers) by session id -> target type */
  children: Map<string, string>;
  /** a page that failed to be covered stays blocked */
  failed?: string;
}

const COVERED_TYPES = new Set(['page', 'iframe', 'worker']);

/** Errors that only mean the frame or worker is already gone. */
function gone(message: string): boolean {
  return /target closed|No target available|not found|detached|Session with given id/i.test(message);
}

export class PageGuard {
  private identity: SiteIdentity = NEUTRAL_IDENTITY;
  private readonly pages = new Map<number, Page>();
  private metadata: UaMetadata | null = null;
  private metadataReady: Promise<void>;
  private resolveMetadata!: () => void;
  private reassertQueued = false;

  constructor(private readonly userAgent: string) {
    this.metadataReady = new Promise((r) => (this.resolveMetadata = r));
  }

  /** Client-hint values of this browser, read once from a real page (index.ts). */
  setMetadata(m: UaMetadata | null) {
    this.metadata = m;
    this.resolveMetadata();
  }

  get current(): SiteIdentity {
    return this.identity;
  }

  /** Requests from a page of the session may leave only when this is true. */
  isReady(webContentsId: number): boolean {
    return this.pages.get(webContentsId)?.ready === true;
  }

  /** Called for every new web contents of the session, before it can load anything. */
  track(wc: WebContents): void {
    if (this.pages.has(wc.id)) return;
    this.pages.set(wc.id, { wc, ready: false, children: new Map() });
    wc.once('destroyed', () => {
      this.pages.delete(wc.id);
      this.reassert();
    });
  }

  /** A tab: blank page first, then the overrides; resolves when real pages may load. */
  async protect(wc: WebContents): Promise<void> {
    this.track(wc);
    await wc.loadURL('about:blank');
    await this.attach(wc);
  }

  /**
   * A popup opened by a page. It starts inside its opener's process, where the opener's
   * session owns the overrides, so Chromium would not keep ours for it and a move to another
   * process would lose them. Its first navigation is blocked (not yet covered); it then goes
   * the way of a tab, blank page first, and loads the address it was opened with.
   */
  async adopt(wc: WebContents, url: string): Promise<void> {
    await this.protect(wc);
    if (!wc.isDestroyed()) await wc.loadURL(url).catch(() => {});
  }

  /** New exit: every page and frame gets the new values before the gate opens again. */
  async setIdentity(next: SiteIdentity): Promise<void> {
    this.identity = next;
    const jobs: Array<Promise<void>> = [];
    for (const p of this.pages.values()) {
      if (!p.ready) continue;
      jobs.push(this.applyAll(p).catch((e) => this.fail(p, e)));
    }
    await Promise.all(jobs);
  }

  private async attach(wc: WebContents): Promise<void> {
    const page = this.pages.get(wc.id);
    if (!page || wc.isDestroyed()) throw new Error('страница уже закрыта');
    await this.metadataReady;
    const dbg = wc.debugger;
    if (!page.listening) {
      page.listening = true;
      dbg.on('message', (_e, method, params: Record<string, any>) => {
        if (method === 'Target.attachedToTarget') void this.onChild(page, params.sessionId, params.targetInfo?.type ?? '');
        else if (method === 'Target.detachedFromTarget') {
          // Only a frame can own a process's overrides; workers come and go in their page's.
          const type = page.children.get(params.sessionId);
          page.children.delete(params.sessionId);
          if (type === 'iframe') this.reassert();
        }
      });
      dbg.on('detach', (_e, reason) => {
        page.ready = false;
        page.children.clear();
        this.reassert();
        // A closing tab detaches first and is destroyed right after: wait to tell them apart.
        setTimeout(() => {
          if (wc.isDestroyed() || this.pages.get(wc.id) !== page) return;
          // Something dropped our session while the page lives on: stop it, keep it blocked,
          // cover it again and load it afresh.
          wc.stop();
          void this.attach(wc)
            .then(() => wc.reload())
            .catch((e) => this.fail(page, e ?? reason));
        }, 100);
      });
    }
    if (!dbg.isAttached()) dbg.attach('1.3');
    try {
      await dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      // A new exit may arrive while this runs (setIdentity skips pages not ready yet):
      // apply again until what was applied is the current identity.
      let applied: SiteIdentity;
      do {
        applied = this.identity;
        await this.apply(dbg, undefined, applied);
      } while (applied !== this.identity);
      page.ready = true;
      page.failed = undefined;
    } catch (e) {
      this.fail(page, e);
      throw e;
    }
  }

  private async onChild(page: Page, sessionId: string, type: string) {
    const dbg = page.wc.debugger;
    page.children.set(sessionId, type);
    try {
      if (COVERED_TYPES.has(type)) await this.apply(dbg, sessionId);
      await dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!gone(message)) {
        // A frame or worker we could not cover: the whole tab stops talking to the network.
        this.fail(page, e);
        return;
      }
    }
    await dbg.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  }

  private async apply(dbg: Electron.Debugger, sessionId: string | undefined, id: SiteIdentity = this.identity) {
    const send = async (method: string, params: Record<string, unknown>) => {
      try {
        await dbg.sendCommand(method, params, sessionId);
      } catch (e) {
        // The process already has these values from another page of ours.
        if (/already in effect/i.test(e instanceof Error ? e.message : String(e))) return;
        throw e;
      }
    };
    await send('Emulation.setTimezoneOverride', { timezoneId: id.timezone });
    await send('Emulation.setLocaleOverride', { locale: id.locale });
    await send('Emulation.setUserAgentOverride', {
      userAgent: this.userAgent,
      acceptLanguage: id.languages,
      ...(this.metadata ? { userAgentMetadata: this.metadata } : {}),
    });
  }

  private async applyAll(p: Page) {
    const dbg = p.wc.debugger;
    if (p.wc.isDestroyed() || !dbg.isAttached()) return;
    await this.apply(dbg, undefined);
    for (const [sid, type] of p.children) {
      if (!COVERED_TYPES.has(type)) continue;
      await this.apply(dbg, sid).catch((e) => {
        if (!gone(e instanceof Error ? e.message : String(e))) throw e;
      });
    }
  }

  /** Some session ended: the processes it covered must get the values from another one. */
  private reassert() {
    if (this.reassertQueued) return;
    this.reassertQueued = true;
    queueMicrotask(() => {
      this.reassertQueued = false;
      for (const p of this.pages.values()) {
        if (!p.ready) continue;
        void this.applyAll(p).catch((e) => this.fail(p, e));
      }
    });
  }

  private fail(page: Page, e: unknown) {
    page.ready = false;
    page.failed = e instanceof Error ? e.message : String(e);
    if (!page.wc.isDestroyed()) page.wc.stop();
  }
}
