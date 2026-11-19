// Building blocks of the settings page (settings.tsx): rows in cards, a switch, the mark of
// settings that belong to this window's profile only, and search, which hides the rows that
// do not match (a card or section with no row left is hidden by CSS).

import { createContext, useContext, type ReactNode } from 'react';
import type { WindowProfileInfo } from '../shared/types';

/** The search query, lower case; empty when not searching. */
export const Query = createContext('');

export function useMatch(...texts: Array<string | undefined>): boolean {
  const q = useContext(Query);
  if (!q) return true;
  return texts.some((t) => t?.toLowerCase().includes(q));
}

export function Row(props: { title: ReactNode; desc?: ReactNode; children?: ReactNode; search?: string; className?: string }) {
  const { title, desc, children, search, className } = props;
  const visible = useMatch(typeof title === 'string' ? title : undefined, typeof desc === 'string' ? desc : undefined, search);
  return (
    <div className={`s-row ${className ?? ''}`} hidden={!visible}>
      <div className="s-text">
        <div className="s-title">{title}</div>
        {desc && <div className="s-desc">{desc}</div>}
      </div>
      {children && <div className="s-control">{children}</div>}
    </div>
  );
}

export function Card(props: { title?: string; scope?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`s-card ${props.className ?? ''}`}>
      {props.title && (
        <h3 className="s-card-title">
          {props.title}
          {props.scope}
        </h3>
      )}
      {props.children}
    </section>
  );
}

/** Marks what belongs to this window's profile only; everything else is shared by all windows. */
export function Scope({ me }: { me: WindowProfileInfo | undefined }) {
  if (!me) return null;
  return (
    <span className="s-scope" title="Касается только этого окна и его профиля" ref={(el) => el?.style.setProperty('--c', me.color)}>
      <span className="s-scope-dot" aria-hidden="true" />
      только «{me.name}»
    </span>
  );
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="s-switch"
      aria-label={props.label}
      checked={props.checked}
      onChange={(e) => props.onChange(e.target.checked)}
    />
  );
}
