import type { ServerProfile, Subscription } from '../shared/types';

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function profileLine(p: ServerProfile): string {
  const proto = { vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'Shadowsocks' }[p.protocol];
  const transport = p.transport.type === 'tcp' ? '' : ` · ${p.transport.type}`;
  const sec = p.security.type === 'none' ? '' : ` · ${p.security.type === 'reality' ? 'Reality' : 'TLS'}`;
  return `${proto}${transport}${sec}`;
}

export function bytes(n: number): string {
  if (!n) return '0';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

export function usageLine(s: Subscription): string {
  const parts: string[] = [];
  const u = s.usage;
  if (u && (u.total || u.upload || u.download)) {
    const used = bytes(u.upload + u.download);
    parts.push(u.total ? `${used} из ${bytes(u.total)}` : `${used} использовано`);
  }
  if (u?.expire) parts.push(`до ${new Date(u.expire * 1000).toLocaleDateString('ru-RU')}`);
  if (s.updatedAt) parts.push(`обновлено ${new Date(s.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`);
  return parts.join(' · ');
}

export function flag(country?: string): string {
  if (!country || !/^[A-Z]{2}$/.test(country)) return '';
  return String.fromCodePoint(...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** The exit IP for people: the tunnel works even when no service could tell it. */
export function ipText(ip?: string): string {
  return !ip || ip === '?' ? 'IP не определён' : ip;
}
