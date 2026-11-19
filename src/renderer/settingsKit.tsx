// Building blocks of the settings page (settings.tsx): rows in cards, a switch, the mark of
// settings that belong to this window's profile only, and search, which hides the rows that
// do not match (a card or section with no row left is hidden by CSS).

import { createContext, useContext, useState, type ReactNode } from 'react';
import type { WindowProfileInfo } from '../shared/types';
import * as I from './icons';

/** The search query, lower case; empty when not searching. */
export const Query = createContext('');

export function useMatch(...texts: Array<string | undefined>): boolean {
  const q = useContext(Query);
  if (!q) return true;
  return texts.some((t) => t?.toLowerCase().includes(q));
}

/** An explanation behind a small "?" next to a title: shown on hover, or on click for keyboard and touch. */
export function Hint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`s-hint ${open ? 'open' : ''}`} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="s-hint-btn"
        aria-label={`Подсказка: ${text}`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        onBlur={() => setOpen(false)}
      >
        <I.Help size={14} />
      </button>
      <span className="s-hint-pop" role="tooltip">
        {text}
      </span>
    </span>
  );
}

export function Row(props: { title: ReactNode; desc?: ReactNode; hint?: string; children?: ReactNode; search?: string; className?: string }) {
  const { title, desc, hint, children, search, className } = props;
  const visible = useMatch(typeof title === 'string' ? title : undefined, typeof desc === 'string' ? desc : undefined, hint, search);
  return (
    <div className={`s-row ${className ?? ''}`} hidden={!visible}>
      <div className="s-text">
        <div className="s-title">
          {title}
          {hint && <Hint text={hint} />}
        </div>
        {desc && <div className="s-desc">{desc}</div>}
      </div>
      {children && <div className="s-control">{children}</div>}
    </div>
  );
}

export function Card(props: { title?: string; hint?: string; scope?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`s-card ${props.className ?? ''}`}>
      {props.title && (
        <h3 className="s-card-title">
          {props.title}
          {props.hint && <Hint text={props.hint} />}
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
