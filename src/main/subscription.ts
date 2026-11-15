// Subscription download and header parsing. No Electron imports.

import type { Subscription } from '../shared/types';
import { decodeBase64 } from './links';

export interface FetchedSubscription {
  body: string;
  title?: string;
  usage?: Subscription['usage'];
  updateIntervalHours?: number;
}

export function parseUserinfo(h: string | null): Subscription['usage'] | undefined {
  if (!h) return undefined;
  const get = (k: string) => Number(new RegExp(`${k}=(\\d+)`).exec(h)?.[1] ?? 0);
  return { upload: get('upload'), download: get('download'), total: get('total'), expire: get('expire') };
}

export function parseTitle(h: string | null): string | undefined {
  if (!h) return undefined;
  const v = h.trim();
  if (v.toLowerCase().startsWith('base64:')) return decodeBase64(v.slice(7))?.trim() || undefined;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function validateSubscriptionUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('это не ссылка');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('ссылка подписки должна начинаться с https://');
  return u;
}

export async function fetchSubscription(rawUrl: string, userAgent: string): Promise<FetchedSubscription> {
  const url = validateSubscriptionUrl(rawUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'text/plain, */*' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`сервер подписки ответил ${res.status}`);
    const body = await res.text();
    if (body.length > 5 * 1024 * 1024) throw new Error('подписка слишком большая');
    const interval = Number(res.headers.get('profile-update-interval'));
    return {
      body,
      title: parseTitle(res.headers.get('profile-title')),
      usage: parseUserinfo(res.headers.get('subscription-userinfo')),
      updateIntervalHours: Number.isFinite(interval) && interval > 0 ? interval : undefined,
    };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('сервер подписки не ответил за 20 секунд');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
