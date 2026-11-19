import type { ReactElement } from 'react';

type P = { size?: number; filled?: boolean };
const svg = (d: ReactElement, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

export const Back = ({ size }: P) => svg(<path d="M15 18l-6-6 6-6" />, size);
export const Forward = ({ size }: P) => svg(<path d="M9 18l6-6-6-6" />, size);
export const Reload = ({ size }: P) => svg(<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></>, size);
export const Stop = ({ size }: P) => svg(<path d="M18 6L6 18M6 6l12 12" />, size);
export const Close = Stop;
export const Plus = ({ size }: P) => svg(<path d="M12 5v14M5 12h14" />, size);
export const Menu = ({ size }: P) => svg(<><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>, size);
export const Trash = ({ size }: P) => svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></>, size);
export const Lock = ({ size }: P) => svg(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, size);
export const Shield = ({ size }: P) => svg(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />, size);
export const ShieldOff = ({ size }: P) =>
  svg(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 9l6 6M15 9l-6 6" /></>, size);
export const Download = ({ size }: P) => svg(<><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></>, size);
export const Search = ({ size }: P) => svg(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>, size);
export const Warn = ({ size }: P) => svg(<><path d="M12 3l10 18H2L12 3z" /><path d="M12 10v4M12 18h.01" /></>, size);
export const Star = ({ size, filled }: P) => (
  <svg width={size ?? 16} height={size ?? 16} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3z" />
  </svg>
);
export const Edit = ({ size }: P) => svg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></>, size);
export const Bookmarks = ({ size }: P) => svg(<path d="M6 3h12v18l-6-4-6 4V3z" />, size);
export const Windows = ({ size }: P) => svg(<><rect x="3" y="7" width="14" height="13" rx="2" /><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" /></>, size);
export const Layout = ({ size }: P) => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11" /></>, size);
export const Info = ({ size }: P) => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></>, size);
export const Gear = ({ size }: P) =>
  svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>,
    size,
  );
export const Clock = ({ size }: P) => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, size);
export const Link = ({ size }: P) => svg(<><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>, size);
