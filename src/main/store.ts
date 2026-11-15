// Persistent app data (servers, subscriptions, selection). Server links contain secrets
// (UUIDs, passwords, keys), so the file is encrypted with the OS key store via safeStorage:
// DPAPI on Windows, Keychain on macOS.

import { app } from 'electron';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { ProfilesState, ServerProfile, Subscription } from '../shared/types';
import { EncryptedJsonFile } from './encryptedFile';

interface StoreData {
  version: 1;
  profiles: ServerProfile[];
  subscriptions: Subscription[];
  selectedId?: string;
}

const EMPTY: StoreData = { version: 1, profiles: [], subscriptions: [] };

export class Store extends EventEmitter<{ change: [ProfilesState] }> {
  private data: StoreData = structuredClone(EMPTY);
  private readonly file: EncryptedJsonFile<StoreData>;

  constructor(onError?: (message: string) => void) {
    super();
    this.file = new EncryptedJsonFile<StoreData>(join(app.getPath('userData'), 'profiles.dat'), 'серверы', onError);
  }

  get encrypted(): boolean {
    return this.file.encrypted;
  }

  async load(): Promise<void> {
    const r = await this.file.read();
    if (!r) return;
    this.data = { ...structuredClone(EMPTY), ...r.data };
    if (r.reEncrypt) this.save();
  }

  private save(): void {
    this.emit('change', this.state());
    this.file.write(this.data);
  }

  /** Waits for pending writes (before quitting). */
  flush(): Promise<void> {
    return this.file.flush();
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
