// One-button updates from GitHub Releases (electron-updater), plus the version history.

import { app } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { EventEmitter } from 'node:events';
import type { ReleaseEntry, UpdateState } from '../shared/types';

declare const __APP_REPO__: string;
export const APP_REPO = __APP_REPO__;

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function notesText(notes: UpdateInfo['releaseNotes']): string {
  const raw = Array.isArray(notes) ? notes.map((n) => n.note ?? '').join('\n\n') : (notes ?? '');
  return htmlToText(raw);
}

/** GitHub sends release notes as HTML; the UI shows plain text only. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/(p|div|h\d|li|ul|ol)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class Updater extends EventEmitter<{ change: [UpdateState] }> {
  private st: UpdateState;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly beforeInstall: () => Promise<void>) {
    super();
    const currentVersion = app.getVersion();
    if (!app.isPackaged) {
      this.st = { status: 'disabled', currentVersion, message: 'Обновления работают только в установленной версии.' };
      return;
    }
    this.st = { status: 'idle', currentVersion };
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => this.patch({ status: 'checking', message: undefined }));
    autoUpdater.on('update-available', (info) =>
      this.patch({ status: 'available', version: info.version, notes: notesText(info.releaseNotes) }),
    );
    autoUpdater.on('update-not-available', () => this.patch({ status: 'not-available', version: undefined }));
    autoUpdater.on('download-progress', (p) => this.patch({ status: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('error', (e) =>
      this.patch({ status: 'error', message: `Не удалось обновиться: ${e?.message ?? e}`, percent: undefined }),
    );
  }

  get state(): UpdateState {
    return this.st;
  }

  private patch(p: Partial<UpdateState>) {
    this.st = { ...this.st, ...p };
    this.emit('change', this.st);
  }

  start() {
    if (this.st.status === 'disabled') return;
    setTimeout(() => void this.check(), 5_000);
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<void> {
    if (this.st.status === 'disabled' || this.st.status === 'downloading' || this.st.status === 'installing') return;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.patch({ status: 'error', message: `Не удалось проверить обновления: ${e instanceof Error ? e.message : e}` });
    }
  }

  /** The one button: download, stop the tunnel cleanly, install, restart. */
  async install(): Promise<void> {
    if (this.st.status !== 'available' && this.st.status !== 'error') return;
    if (!this.st.version) return;
    try {
      this.patch({ status: 'downloading', percent: 0, message: undefined });
      await autoUpdater.downloadUpdate();
      this.patch({ status: 'installing' });
      // Xray must be stopped so the installer can replace its executable on Windows.
      await this.beforeInstall();
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
    } catch (e) {
      this.patch({ status: 'error', message: `Не удалось обновиться: ${e instanceof Error ? e.message : e}` });
    }
  }
}

export async function releaseHistory(): Promise<ReleaseEntry[]> {
  if (!APP_REPO) return [];
  const res = await fetch(`https://api.github.com/repos/${APP_REPO}/releases?per_page=30`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tunnel-browser' },
  });
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  const list = (await res.json()) as Array<{
    tag_name: string;
    name: string | null;
    published_at: string | null;
    body: string | null;
    html_url: string;
    draft: boolean;
    prerelease: boolean;
  }>;
  return list
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({
      version: r.tag_name.replace(/^v/, ''),
      name: r.name || r.tag_name,
      date: r.published_at ?? '',
      notes: (r.body ?? '').trim(),
      url: r.html_url,
    }));
}
