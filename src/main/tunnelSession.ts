// The browser's network session and its kill-switch.
//
// Three independent layers keep traffic from leaving outside the tunnel:
//  1. Proxy: the session's only route is the local Xray inbound ("fixed_servers", no DIRECT
//     fallback). While the tunnel is down, the proxy points at a sinkhole port this process
//     holds open itself, so no other program can take that port over.
//  2. Gate: every request is checked in webRequest.onBeforeRequest and cancelled unless the
//     tunnel is verified up. Local and private addresses are always refused.
//  3. UI: tabs are detached from the window while locked (see tabs.ts).
// Pages also may not send anything until their time zone and language are replaced with
// the exit's (pageGuard.ts); service workers are refused, since they outlive their pages.
// The session also watches page traffic for the signs of a dead server and reports them as
// 'trouble'; the tunnel then verifies with its own probe (tunnel.ts).
// Plus per-page hardening: WebRTC may not use UDP outside the proxy, permissions that
// expose the device (location, camera, USB...) are denied, non-web schemes are blocked.

import { app, session, type Session, type WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { cleanUserAgent, gateAllows, isProxyFailureResponse, isServiceWorkerScript, isTunnelTroubleError, isWebUrl } from './guard';
import { SITE_LANGUAGES } from './identity';
import { PageGuard } from './pageGuard';

export { cleanUserAgent, isLocalHost, isWebUrl } from './guard';

export const TUNNEL_PARTITION = 'persist:tunnel';

export interface ProxyCreds {
  port: number;
  user: string;
  pass: string;
}

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'window-management']);
export class TunnelSession extends EventEmitter<{ trouble: [] }> {
  readonly ses: Session;
  /** set up in init(): it needs the session's final user agent */
  guard!: PageGuard;
  private open = false;
  private creds: ProxyCreds | null = null;
  /** kept referenced so the port stays ours for the app's lifetime */
  private sinkhole: net.Server | null = null;
  private sinkholePort = 0;

  constructor() {
    super();
    this.ses = session.fromPartition(TUNNEL_PARTITION);
  }

  async init(): Promise<void> {
    const ses = this.ses;
    const userAgent = cleanUserAgent(ses.getUserAgent());
    // Accept-Language: the same neutral list for everyone, not this computer's languages.
    ses.setUserAgent(userAgent, SITE_LANGUAGES);
    ses.setSpellCheckerEnabled(false);
    this.guard = new PageGuard(userAgent);

    // Layer 2: the gate.
    ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !this.allows(details.url, details.webContentsId) }));
    // Service workers keep running after their pages close, where nothing covers their time
    // zone; registration fails as if the script could not be fetched. Older versions may
    // have left some registered.
    ses.webRequest.onBeforeSendHeaders((details, cb) =>
      cb(isServiceWorkerScript(details.requestHeaders) ? { cancel: true } : { requestHeaders: details.requestHeaders }),
    );
    await ses.clearStorageData({ storages: ['serviceworkers'] }).catch(() => {});

    // Page traffic is the first to notice a dead server: Xray answers plain http with an
    // empty 503 and drops https streams. Only a hint; the tunnel confirms it with a probe.
    ses.webRequest.onCompleted((d) => {
      if (this.open && isProxyFailureResponse(d.statusCode, d.responseHeaders)) this.emit('trouble');
    });
    ses.webRequest.onErrorOccurred((d) => {
      if (this.open && isTunnelTroubleError(d.error)) this.emit('trouble');
    });

    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
    ses.setDevicePermissionHandler(() => false);
    ses.on('select-hid-device', (e, _d, cb) => {
      e.preventDefault();
      cb('');
    });
    ses.on('select-serial-port', (e, _p, _wc, cb) => {
      e.preventDefault();
      cb('');
    });
    ses.on('select-usb-device', (e, _d, cb) => {
      e.preventDefault();
      cb('');
    });

    // Proxy auth for our own inbound only (Chromium has no SOCKS5 auth, hence HTTP inbound).
    app.on('login', (event, wc, _details, authInfo, cb) => {
      const c = this.creds;
      if (!authInfo.isProxy || !c) return;
      if (authInfo.host !== '127.0.0.1' || authInfo.port !== c.port) return;
      if (wc && wc.session !== this.ses) return;
      event.preventDefault();
      cb(c.user, c.pass);
    });

    this.sinkholePort = await this.startSinkhole();
    await this.closeGate();
  }

  private startSinkhole(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((sock) => sock.destroy());
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const a = srv.address();
        this.sinkhole = srv;
        if (a && typeof a === 'object') resolve(a.port);
        else reject(new Error('sinkhole failed'));
      });
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  get sinkholeListening(): boolean {
    return this.sinkhole?.listening ?? false;
  }

  /** Is this request allowed to leave right now? */
  allows(raw: string, webContentsId?: number): boolean {
    return gateAllows(raw, this.open, webContentsId === undefined || this.guard.isReady(webContentsId));
  }

  private async applyProxy(port: number): Promise<void> {
    await this.ses.setProxy({
      mode: 'fixed_servers',
      proxyRules: `http://127.0.0.1:${port}`,
      // "<-loopback>" removes Chromium's implicit "localhost goes direct" rule.
      proxyBypassRules: '<-loopback>',
    });
    await this.ses.closeAllConnections();
    const resolved = await this.ses.resolveProxy('https://example.com/');
    if (resolved.trim() !== `PROXY 127.0.0.1:${port}`) {
      throw new Error(`прокси браузера не применился (${resolved}) — браузер остаётся заблокированным`);
    }
  }

  /** Called only after the tunnel has been verified end to end. */
  async openGate(creds: ProxyCreds): Promise<void> {
    this.creds = creds;
    await this.ses.clearAuthCache();
    await this.applyProxy(creds.port);
    this.open = true;
  }

  /** Close first, then tear down: the gate drops before anything else changes. */
  async closeGate(): Promise<void> {
    this.open = false;
    this.creds = null;
    await this.applyProxy(this.sinkholePort);
    await this.ses.clearAuthCache();
  }

  /** Synchronous part of closing, for crash/exit paths. */
  closeGateNow(): void {
    this.open = false;
    this.creds = null;
    void this.closeGate().catch(() => {});
  }

  async clearData(): Promise<void> {
    await this.ses.clearStorageData();
    await this.ses.clearCache();
    await this.ses.clearAuthCache();
    await this.ses.clearHostResolverCache();
  }
}

/** Hardening applied to every page that lives in the tunnel session (tabs and popups). */
export function hardenWebContents(wc: WebContents): void {
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  const guard = (e: { preventDefault(): void }, url: string) => {
    if (!isWebUrl(url) && !url.startsWith('about:blank')) e.preventDefault();
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('will-frame-navigate', (e) => {
    if (!isWebUrl(e.url) && !e.url.startsWith('about:') && !e.url.startsWith('data:') && !e.url.startsWith('blob:')) {
      e.preventDefault();
    }
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
}
