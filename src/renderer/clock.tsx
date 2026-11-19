// The time sites see: the clock of the exit's time zone (identity.ts), shown next to it.

import { useEffect, useState } from 'react';

/** The current time, re-rendered at the start of every second. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(new Date());
      timer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    };
    timer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    return () => clearTimeout(timer);
  }, []);
  return now;
}

/** 14:05 (or 14:05:09) in that zone. */
export function timeIn(zone: string, now: Date, seconds = false): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: zone, hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }).format(now);
  } catch {
    return '';
  }
}

/**
 * "Центральная Европа, Berlin, GMT+1, 14:05": the zone's name, its city (from the zone id, as
 * is), the offset and the time there. UTC: "UTC, 14:05".
 */
export function siteTime(zone: string, now: Date, seconds = false): string {
  const time = timeIn(zone, now, seconds);
  if (zone === 'UTC' || zone === 'Etc/UTC') return ['UTC', time].filter(Boolean).join(', ');
  const part = (timeZoneName: 'longGeneric' | 'shortOffset') => {
    try {
      return new Intl.DateTimeFormat('ru-RU', { timeZone: zone, timeZoneName }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch {
      return '';
    }
  };
  const region = part('longGeneric').replace(/,\s*(стандартное|летнее) время$/, '');
  const city = zone.split('/').pop()?.replace(/_/g, ' ') ?? '';
  const offset = part('shortOffset').replace('-', '−');
  const parts = [region.startsWith('GMT') ? '' : region, city === region ? '' : city, offset, time];
  return parts.filter(Boolean).join(', ');
}
