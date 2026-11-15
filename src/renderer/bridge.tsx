import { useEffect, useState } from 'react';
import type { BridgeApi } from '../shared/types';
import { hostOf } from './format';

declare global {
  interface Window {
    api: BridgeApi;
  }
}
export const api = window.api;

export type Run = (fn: () => Promise<unknown>) => Promise<void>;

export function useBridge<T>(initial: T, get: () => Promise<T>, onChange: (cb: (v: T) => void) => () => void): T {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    let live = true;
    void get().then((x) => live && setV(x));
    const off = onChange(setV);
    return () => {
      live = false;
      off();
    };
  }, []);
  return v;
}

export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Coloured first letter of the site. Real favicons are not loaded: the UI never touches
 * the network, and fetching them directly would bypass the tunnel. */
export function LetterIcon({ url, size = 16 }: { url: string; size?: number }) {
  const host = hostOf(url);
  const letter = (host[0] ?? '•').toUpperCase();
  let hue = 0;
  for (const ch of host) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      className="favicon"
      ref={(el) => {
        el?.style.setProperty('--hue', String(hue));
        el?.style.setProperty('--size', `${size}px`);
      }}
    >
      {letter}
    </span>
  );
}
