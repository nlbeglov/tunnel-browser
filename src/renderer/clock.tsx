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

/** 14:05:09 in that zone. */
export function timeIn(zone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now);
  } catch {
    return '';
  }
}

/** "Центральная Европа, GMT+1"; for UTC just "UTC". */
export function zoneLabel(zone: string, now: Date): string {
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
  const part = (timeZoneName: 'longGeneric' | 'shortOffset') => {
    try {
      return new Intl.DateTimeFormat('ru-RU', { timeZone: zone, timeZoneName }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch {
      return '';
    }
  };
  const offset = part('shortOffset').replace('-', '−');
  const name = part('longGeneric');
  if (!name || name.startsWith('GMT')) return offset || zone;
  return offset ? `${name}, ${offset}` : name;
}
