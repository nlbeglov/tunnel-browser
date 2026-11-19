// Types shared by the main process, the preload bridge and the UI.

export type Protocol = 'vless' | 'vmess' | 'trojan' | 'shadowsocks';
export type TransportType = 'tcp' | 'ws' | 'grpc' | 'httpupgrade' | 'xhttp' | 'kcp';
export type SecurityType = 'none' | 'tls' | 'reality';

export interface Transport {
  type: TransportType;
  path?: string;
  host?: string;
  /** grpc */
  serviceName?: string;
  authority?: string;
  /** grpc: "gun" | "multi"; xhttp: "auto" | "packet-up" | "stream-up" | "stream-one" */
  mode?: string;
  /** tcp: "none" | "http"; kcp: header type */
  headerType?: string;
  /** kcp seed */
  seed?: string;
  /** xhttp "extra" JSON object, already parsed */
  extra?: Record<string, unknown>;
}

export interface Security {
  type: SecurityType;
  sni?: string;
  alpn?: string[];
  fingerprint?: string;
  /** tls: certificate pinning, replaces the removed `allowInsecure` (link params pcs / vcn) */
  pinnedPeerCertSha256?: string;
  verifyPeerCertByName?: string;
  /** reality */
  publicKey?: string;
  shortId?: string;
  spiderX?: string;
  mldsa65Verify?: string;
}

export interface ServerProfile {
  id: string;
  name: string;
  protocol: Protocol;
  address: string;
  port: number;
  /** vless / vmess user id */
  uuid?: string;
  /** vless */
  flow?: string;
  encryption?: string;
  /** vmess cipher ("auto", "aes-128-gcm", ...) */
  cipher?: string;
  /** trojan / shadowsocks */
  password?: string;
  /** shadowsocks method */
  method?: string;
  transport: Transport;
  security: Security;
  /** original share link, kept for export */
  link: string;
  subscriptionId?: string;
}

export interface Subscription {
  id: string;
  url: string;
  title: string;
  updatedAt: number;
  /** from the `subscription-userinfo` header */
  usage?: { upload: number; download: number; total: number; expire: number };
  updateIntervalHours?: number;
  lastError?: string;
}

export type TunnelStatus = 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'error';

export interface TunnelState {
  status: TunnelStatus;
  profileId?: string;
  profileName?: string;
  /** what the user should see when status is "error" or "degraded" */
  message?: string;
  exit?: {
    ip: string;
    country?: string;
    colo?: string;
    latencyMs: number;
    /** the time zone pages are given, matching the exit */
    timezone?: string;
  };
  since?: number;
}

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
  /** the site's icon as a data: URL, fetched through the tunnel */
  icon?: string;
}

export interface TabsState {
  tabs: TabInfo[];
  activeId: number | null;
  /** a recently closed tab can be reopened (Ctrl/Cmd+Shift+T) */
  canReopen: boolean;
}

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  createdAt: number;
  /** the site's icon as a data: URL, fetched through the tunnel */
  icon?: string;
}

export interface BookmarksState {
  items: Bookmark[];
  showBar: boolean;
}

export interface BrowserSettings {
  /** reopen the tabs of the last session on start (they load once the tunnel is up) */
  restoreTabs: boolean;
  showBookmarksBar: boolean;
  /** ask before sites see a new exit IP while they hold cookies */
  warnOnServerSwitch: boolean;
}

export type OpenMode = 'current' | 'new-tab' | 'background';
export type PanelName = 'servers' | 'settings' | 'bookmarks' | 'profiles';

/**
 * The settings tab: drawn by the UI in the tab strip, it has no page and no address. While it
 * is the active one, the page view of the selected tab is hidden.
 */
export type SettingsTabState = 'closed' | 'open' | 'active';
/** What the menu's tab commands ask of the settings tab when it is open. */
export type SettingsTabCommand = 'close' | 'next' | 'prev';

/** A window profile as the UI sees it (windowProfiles.ts). */
export interface WindowProfileInfo {
  id: string;
  name: string;
  color: string;
  /** a window of this profile is open */
  open: boolean;
  /** the profile of the window asking */
  current: boolean;
  serverName?: string;
  /** the profile's server is no longer in any subscription (or was removed) */
  serverMissing?: boolean;
  /** the live exit when its window is connected, else the last one sites saw */
  exit?: { ip: string; country?: string; live: boolean };
}

export interface WindowProfilesState {
  profiles: WindowProfileInfo[];
  /** colours no profile uses yet: offered for a new one */
  freeColors: string[];
  /** id of the profile of the window asking */
  current: string;
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'installing'
  | 'error'
  | 'disabled';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  version?: string;
  notes?: string;
  percent?: number;
  message?: string;
}

export interface ReleaseEntry {
  version: string;
  name: string;
  date: string;
  notes: string;
  url: string;
}

export interface ProfilesState {
  profiles: ServerProfile[];
  subscriptions: Subscription[];
  selectedId?: string;
}

export interface ImportResult {
  added: number;
  errors: string[];
}

export interface UiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The API the preload script exposes to the UI as `window.api`. */
export interface BridgeApi {
  profiles: {
    get(): Promise<ProfilesState>;
    importText(text: string): Promise<ImportResult>;
    remove(id: string): Promise<void>;
    select(id: string): Promise<void>;
    addSubscription(url: string): Promise<ImportResult>;
    refreshSubscription(id: string): Promise<ImportResult>;
    removeSubscription(id: string): Promise<void>;
    onChange(cb: (state: ProfilesState) => void): () => void;
  };
  tunnel: {
    get(): Promise<TunnelState>;
    connect(profileId?: string): Promise<void>;
    disconnect(): Promise<void>;
    /** the ping again; resolves with it (undefined when not connected) */
    measure(): Promise<number | undefined>;
    onChange(cb: (state: TunnelState) => void): () => void;
  };
  tabs: {
    get(): Promise<TabsState>;
    create(input?: string): Promise<void>;
    close(id: number): Promise<void>;
    activate(id: number): Promise<void>;
    navigate(id: number, input: string): Promise<void>;
    back(id: number): Promise<void>;
    forward(id: number): Promise<void>;
    reload(id: number): Promise<void>;
    stop(id: number): Promise<void>;
    move(id: number, toIndex: number): Promise<void>;
    contextMenu(id: number): Promise<void>;
    reopenClosed(): Promise<void>;
    setBounds(rect: UiRect): void;
    setSettingsTab(state: SettingsTabState): void;
    onChange(cb: (state: TabsState) => void): () => void;
    onFocusAddressBar(cb: () => void): () => void;
    onSettingsTabCommand(cb: (cmd: SettingsTabCommand) => void): () => void;
  };
  bookmarks: {
    get(): Promise<BookmarksState>;
    add(url: string, title: string): Promise<Bookmark>;
    remove(id: string): Promise<void>;
    update(id: string, patch: { title?: string; url?: string }): Promise<void>;
    move(id: string, toIndex: number): Promise<void>;
    open(id: string, mode: OpenMode): Promise<void>;
    contextMenu(id: string): Promise<void>;
    overflowMenu(ids: string[]): Promise<void>;
    onChange(cb: (state: BookmarksState) => void): () => void;
  };
  windows: {
    get(): Promise<WindowProfilesState>;
    /** opens a window of the profile, or brings its window to the front */
    open(id: string): Promise<void>;
    create(input: { name: string; color: string; serverId?: string }): Promise<void>;
    update(id: string, patch: { name?: string; color?: string }): Promise<void>;
    remove(id: string): Promise<void>;
    onChange(cb: (state: WindowProfilesState) => void): () => void;
  };
  updates: {
    get(): Promise<UpdateState>;
    check(): Promise<void>;
    install(): Promise<void>;
    history(): Promise<ReleaseEntry[]>;
    onChange(cb: (state: UpdateState) => void): () => void;
  };
  app: {
    platform: string;
    info(): Promise<{ version: string; platform: string; xrayVersion: string; repo: string }>;
    clearBrowsingData(): Promise<void>;
    settings(): Promise<BrowserSettings>;
    setSettings(patch: Partial<BrowserSettings>): Promise<BrowserSettings>;
    onSettingsChange(cb: (s: BrowserSettings) => void): () => void;
    onOpenPanel(cb: (panel: PanelName, bookmarkId?: string) => void): () => void;
    onFullScreen(cb: (full: boolean) => void): () => void;
    /** Windows: colours for the window buttons drawn over the tab strip */
    setTitleBarColors(colors: { color: string; symbolColor: string }): void;
    /** Windows: the small picture over this window's taskbar icon (profile colour and flag) */
    setTaskbarBadge(png: string | null, description: string): void;
    onError(cb: (message: string) => void): () => void;
  };
}
