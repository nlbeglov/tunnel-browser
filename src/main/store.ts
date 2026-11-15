// Persistent app data (servers, subscriptions, selection). Server links contain secrets
// (UUIDs, passwords, keys), so the file is encrypted with the OS key store via safeStorage:
// DPAPI on Windows, Keychain on macOS.

import { app, safeStorage } from 'electron';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfilesState, ServerProfile, Subscription } from '../shared/types';

interface StoreData {
  version: 1;
  profiles: ServerProfile[];
  subscriptions: Subscription[];
  selectedId?: string;
}

const EMPTY: StoreData = { version: 1, profiles: [], subscriptions: [] };
const MAGIC_ENC = 'TBENC1\n';
const MAGIC_PLAIN = 'TBRAW1\n';

export class Store extends EventEmitter<{ change: [ProfilesState] }> {
  private data: StoreData = structuredClone(EMPTY);
  private readonly file = join(app.getPath('userData'), 'profiles.dat');
  /** false only on systems without a key store (some Linux setups) */
  encrypted = true;

  async load(): Promise<void> {
    if (!existsSync(this.file)) return;
    try {
      const raw = readFileSync(this.file);
      const head = raw.subarray(0, MAGIC_ENC.length).toString('utf8');
      let json: string;
      let reEncrypt = false;
      if (head === MAGIC_ENC) {
        const r = await safeStorage.decryptStringAsync(raw.subarray(MAGIC_ENC.length));
        json = r.result;
        reEncrypt = r.shouldReEncrypt;
      } else if (head === MAGIC_PLAIN) {
        json = raw.subarray(MAGIC_PLAIN.length).toString('utf8');
        reEncrypt = true; // encrypt it as soon as the key store is available
      } else throw new Error('unknown format');
      const parsed = JSON.parse(json) as StoreData;
      this.data = { ...structuredClone(EMPTY), ...parsed };
      if (reEncrypt) this.save();
    } catch (e) {
      // Do not silently overwrite a file we failed to read: keep it aside for recovery.
      const backup = `${this.file}.broken-${Date.now()}`;
      try {
        renameSync(this.file, backup);
      } catch {
        /* ignore */
      }
      console.error('Не удалось прочитать сохранённые серверы, файл сохранён как', backup, e);
    }
  }

  private writing: Promise<void> = Promise.resolve();

  /** Writes are serialized; each one snapshots the data at call time. */
  private save(): void {
    this.emit('change', this.state());
    const json = JSON.stringify(this.data);
    this.writing = this.writing.then(async () => {
      try {
        this.encrypted = await safeStorage.isAsyncEncryptionAvailable();
        const payload = this.encrypted
          ? Buffer.concat([Buffer.from(MAGIC_ENC), await safeStorage.encryptStringAsync(json)])
          : Buffer.from(MAGIC_PLAIN + json);
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, payload, { mode: 0o600 });
        renameSync(tmp, this.file);
      } catch (e) {
        console.error('Не удалось сохранить серверы', e);
      }
    });
  }

  /** Waits for pending writes (before quitting). */
  flush(): Promise<void> {
    return this.writing;
  }

  state(): ProfilesState {
    return {
      profiles: this.data.profiles,
      subscriptions: this.data.subscriptions,
      selectedId: this.data.selectedId,
    };
  }

  profile(id: string | undefined): ServerProfile | undefined {
    return id ? this.data.profiles.find((p) => p.id === id) : undefined;
  }

  get selectedId(): string | undefined {
    return this.data.selectedId;
  }

  addProfiles(list: ServerProfile[]): number {
    const known = new Set(this.data.profiles.map((p) => p.link));
    const fresh = list.filter((p) => !known.has(p.link));
    this.data.profiles.push(...fresh);
    if (!this.data.selectedId && this.data.profiles.length) this.data.selectedId = this.data.profiles[0].id;
    this.save();
    return fresh.length;
  }

  removeProfile(id: string): void {
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    if (this.data.selectedId === id) this.data.selectedId = this.data.profiles[0]?.id;
    this.save();
  }

  select(id: string): void {
    if (!this.profile(id)) throw new Error('сервер не найден');
    this.data.selectedId = id;
    this.save();
  }

  upsertSubscription(sub: Subscription, profiles: ServerProfile[]): void {
    // Keep the selection on the "same" server across refreshes when its link is unchanged.
    const selectedLink = this.profile(this.data.selectedId)?.link;
    this.data.profiles = this.data.profiles.filter((p) => p.subscriptionId !== sub.id);
    for (const p of profiles) p.subscriptionId = sub.id;
    this.data.profiles.push(...profiles);
    const i = this.data.subscriptions.findIndex((s) => s.id === sub.id);
    if (i >= 0) this.data.subscriptions[i] = sub;
    else this.data.subscriptions.push(sub);
    const again = selectedLink ? this.data.profiles.find((p) => p.link === selectedLink) : undefined;
    this.data.selectedId = again?.id ?? this.profile(this.data.selectedId)?.id ?? this.data.profiles[0]?.id;
    this.save();
  }

  subscription(id: string): Subscription | undefined {
    return this.data.subscriptions.find((s) => s.id === id);
  }

  setSubscriptionError(id: string, message: string): void {
    const s = this.subscription(id);
    if (!s) return;
    s.lastError = message;
    this.save();
  }

  removeSubscription(id: string): void {
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.id !== id);
    this.data.profiles = this.data.profiles.filter((p) => p.subscriptionId !== id);
    if (!this.profile(this.data.selectedId)) this.data.selectedId = this.data.profiles[0]?.id;
    this.save();
  }
}
