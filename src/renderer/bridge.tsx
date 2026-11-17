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

/**
 * The site's icon. It is fetched in the page's own session, through its tunnel (tabs.ts),
 * and arrives here as a data: URL: the UI itself never touches the network. Until then, or
 * when a site has none, a coloured first letter.
 */
export function SiteIcon({ url, icon, size = 16 }: { url: string; icon?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [icon]);
  if (icon && !broken) {
    return <img className="site-icon" src={icon} alt="" width={size} height={size} draggable={false} onError={() => setBroken(true)} />;
  }
  return <LetterIcon url={url} size={size} />;
}

function LetterIcon({ url, size = 16 }: { url: string; size?: number }) {
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
