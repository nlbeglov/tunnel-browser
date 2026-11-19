// The panels under toolbar buttons (main/popup.ts lays this page over the window): the ⋮ menu,
// the connection panel under the IP and the bookmarks. Each opens leftwards from the right edge
// of its button; a click outside or Esc closes it. The data comes from the main process and
// stays live while the panel is open.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppMenuEntry, AppMenuItem, Bookmark, BookmarksPopupData, ConnectionPopupData, PopupData, PopupShow } from '../shared/types';
import { openModeFor } from './bookmarks';
import { SiteIcon, errText } from './bridge';
import { ConnectionCard } from './connectionCard';
import { flag, hostOf } from './format';
import * as I from './icons';

declare global {
  interface Window {
    popup: {
      onShow(cb: (d: PopupShow) => void): () => void;
      onData(cb: (d: PopupData) => void): () => void;
      act(id: string, arg?: unknown): Promise<unknown>;
      close(): void;
    };
  }
}

const act = (id: string, arg?: unknown) => window.popup.act(id, arg);

/** A panel under its button: right edge under the button's, inside the window, scrolls if tall. */
function Anchored({ show, className, children }: { show: PopupShow; className: string; children: ReactNode }) {
  const style: CSSProperties = {
    right: Math.max(8, innerWidth - show.right),
    top: Math.max(8, show.top),
    maxHeight: Math.max(160, innerHeight - show.top - 12),
  };
  return (
    <div className={`popup-panel ${className}`} style={style} role="dialog">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- ⋮ menu

function MenuItemButton({ item, open, onEnter, onPick }: { item: AppMenuItem; open?: boolean; onEnter: () => void; onPick: () => void }) {
  return (
    <button
      className={`mi ${open ? 'open' : ''}`}
      role="menuitem"
      disabled={item.disabled}
      aria-haspopup={item.sub ? 'menu' : undefined}
      aria-expanded={item.sub ? !!open : undefined}
      onMouseEnter={onEnter}
      onClick={onPick}
    >
      {(item.color || item.country) && (
        <span className="mi-icon">
          {item.color && <span className="mi-dot" ref={(el) => el?.style.setProperty('--c', item.color!)} />}
          {flag(item.country) && <span className="mi-flag">{flag(item.country)}</span>}
        </span>
      )}
      <span className="mi-label">{item.label}</span>
      {item.note && <span className="mi-note">{item.note}</span>}
      {item.accel && <span className="mi-accel">{item.accel}</span>}
      {item.sub && (
        <span className="mi-more">
          <I.Forward size={14} />
        </span>
      )}
    </button>
  );
}

function MenuList({ entries, openSub, onSub, onPick }: { entries: AppMenuEntry[]; openSub?: number | null; onSub?: (i: number | null, el?: HTMLElement) => void; onPick: (item: AppMenuItem, el: HTMLElement) => void }) {
  return (
    <>
      {entries.map((e, i) =>
        e === 'separator' ? (
          <div className="mi-sep" key={`s${i}`} />
        ) : (
          <MenuItemButton
            key={e.id}
            item={e}
            open={openSub === i}
            onEnter={() => onSub?.(e.sub ? i : null)}
            onPick={() => onPick(e, document.activeElement as HTMLElement)}
          />
        ),
      )}
    </>
  );
}

/** Moves focus among the enabled items of the panel that has it. */
function arrowKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false;
  e.preventDefault();
  const list = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('.mi:not(:disabled)')];
  if (!list.length) return true;
  const at = list.indexOf(document.activeElement as HTMLButtonElement);
  const step = e.key === 'ArrowDown' ? 1 : -1;
  list[at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length].focus();
  return true;
}

function MenuPanel({ show }: { show: Extract<PopupShow, { kind: 'menu' }> }) {
  const main = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<number | null>(null);
  const [subPos, setSubPos] = useState<CSSProperties>({ visibility: 'hidden' });
  const subItems = sub === null ? null : (show.items[sub] as AppMenuItem).sub ?? null;

  useEffect(() => main.current?.focus(), []);
  // The submenu opens to the left of the menu, to the right only when there is no room.
  useLayoutEffect(() => {
    if (sub === null || !main.current || !subRef.current) return;
    const m = main.current.getBoundingClientRect();
    const row = main.current.querySelectorAll('.mi')[show.items.slice(0, sub).filter((x) => x !== 'separator').length]?.getBoundingClientRect();
    const w = subRef.current.offsetWidth;
    const left = m.left - w + 4 >= 8 ? m.left - w + 4 : m.right - 4;
    const top = Math.max(8, Math.min((row?.top ?? m.top) - 7, innerHeight - subRef.current.offsetHeight - 8));
    setSubPos({ left, top });
  }, [sub]);
  const subLeft = typeof subPos.left === 'number' && main.current ? subPos.left < main.current.getBoundingClientRect().left : true;

  const pick = (item: AppMenuItem) => {
    if (item.sub) {
      setSub(show.items.indexOf(item));
      requestAnimationFrame(() => subRef.current?.querySelector<HTMLButtonElement>('.mi:not(:disabled)')?.focus());
    } else void act(item.id);
  };
  const style: CSSProperties = { right: Math.max(8, innerWidth - show.right), top: Math.max(8, show.top) };

  return (
    <>
      <div
        className="app-menu"
        role="menu"
        tabIndex={-1}
        ref={main}
        style={style}
        onKeyDown={(e) => {
          if (arrowKeys(e)) return;
          const current = document.activeElement as HTMLElement | null;
          if (e.key === (subLeft ? 'ArrowLeft' : 'ArrowRight') && current?.getAttribute('aria-haspopup')) {
            e.preventDefault();
            current.click();
          }
        }}
      >
        <MenuList entries={show.items} openSub={sub} onSub={(i) => setSub(i)} onPick={pick} />
      </div>
      {subItems && (
        <div
          className="app-menu"
          role="menu"
          ref={subRef}
          style={subPos}
          onKeyDown={(e) => {
            if (arrowKeys(e)) return;
            if (e.key === (subLeft ? 'ArrowRight' : 'ArrowLeft') || e.key === 'Escape') {
              e.preventDefault();
              setSub(null);
              main.current?.querySelectorAll<HTMLButtonElement>('.mi')[sub!]?.focus();
            }
          }}
        >
          <MenuList entries={subItems} onPick={pick} />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- connection

function ConnectionPanel({ data }: { data: ConnectionPopupData }) {
  return (
    <ConnectionCard
      tunnel={data.tunnel}
      server={data.server}
      me={data.me}
      className="popup-card"
      actions={{ connect: () => act('connect'), disconnect: () => act('disconnect'), measure: () => act('measure') }}
    >
      <button className="popup-link" onClick={() => void act('settings')}>
        <span>Серверы и подписки</span>
        <I.Forward size={14} />
      </button>
    </ConnectionCard>
  );
}

// ---------------------------------------------------------------- bookmarks

function BookmarkEditor({ b, onDone }: { b: Bookmark; onDone: () => void }) {
  const [title, setTitle] = useState(b.title);
  const [url, setUrl] = useState(b.url);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="bmp-edit"
      onSubmit={(e) => {
        e.preventDefault();
        act('update', { id: b.id, title, url }).then(onDone, (err) => setError(errText(err)));
      }}
    >
      <label className="field">
        <span className="s-desc">Название</span>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} spellCheck={false} />
      </label>
      <label className="field">
        <span className="s-desc">Адрес</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
      </label>
      {error && <p className="error-text small">{error}</p>}
      <div className="row-actions">
        <button className="btn primary small" type="submit">
          Сохранить
        </button>
        <button className="btn small" type="button" onClick={onDone}>
          Отмена
        </button>
        <button className="btn small danger" type="button" onClick={() => void act('remove', { id: b.id })}>
          Удалить
        </button>
      </div>
    </form>
  );
}

function BookmarksPanel({ data }: { data: BookmarksPopupData }) {
  const items = data.bookmarks.items;
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | undefined>(data.editId);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!data.editId) search.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  const list = q ? items.filter((b) => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q)) : items;
  const drop = (index: number) => {
    if (dragId) {
      const from = items.findIndex((b) => b.id === dragId);
      void act('move', { id: dragId, to: from < index ? index - 1 : index });
    }
    setDragId(null);
    setDropAt(null);
  };

  return (
    <>
      <div className="bmp-head">
        <h3>Закладки</h3>
        {items.length > 0 && (
          <label className="s-search bmp-search">
            <I.Search size={14} />
            <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по закладкам" aria-label="Поиск по закладкам" spellCheck={false} />
          </label>
        )}
      </div>
      <div className="bmp-list" onDragLeave={() => setDropAt(null)}>
        {!items.length && <p className="bmp-empty">Закладок пока нет. Нажмите ☆ в адресной строке или Ctrl/⌘+D.</p>}
        {items.length > 0 && !list.length && <p className="bmp-empty">Ничего не найдено.</p>}
        {list.map((b) =>
          editing === b.id ? (
            <BookmarkEditor key={b.id} b={b} onDone={() => setEditing(undefined)} />
          ) : (
            <div
              key={b.id}
              className={`bmp-row ${dropAt === items.indexOf(b) ? 'drop-before' : ''} ${dragId === b.id ? 'dragging' : ''}`}
              draggable={!q}
              onDragStart={(e) => {
                setDragId(b.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const i = items.indexOf(b);
                setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dropAt !== null) drop(dropAt);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropAt(null);
              }}
              onClick={(e) => void act('open', { id: b.id, how: openModeFor(e) })}
              onAuxClick={(e) => e.button === 1 && void act('open', { id: b.id, how: 'background' })}
              onContextMenu={(e) => {
                e.preventDefault();
                void act('context', { id: b.id });
              }}
              title={`${b.title}\n${b.url}`}
            >
              <SiteIcon url={b.url} icon={b.icon} size={16} />
              <span className="bmp-text">
                <span className="bmp-title">{b.title}</span>
                <span className="s-desc">{hostOf(b.url)}</span>
              </span>
              <span className="bmp-actions">
                <button
                  className="icon-btn"
                  aria-label={`Изменить «${b.title}»`}
                  title="Изменить"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(b.id);
                  }}
                >
                  <I.Edit size={14} />
                </button>
                <button
                  className="icon-btn"
                  aria-label={`Удалить «${b.title}»`}
                  title="Удалить"
                  onClick={(e) => {
                    e.stopPropagation();
                    void act('remove', { id: b.id });
                  }}
                >
                  <I.Trash size={14} />
                </button>
              </span>
            </div>
          ),
        )}
        {dragId && (
          <div
            className={`bmp-drop-end ${dropAt === items.length ? 'drop-before' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDropAt(items.length);
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop(items.length);
            }}
          />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- the page

function PopupApp() {
  const [show, setShow] = useState<PopupShow | null>(null);
  const [seq, setSeq] = useState(0);
  useEffect(
    () =>
      window.popup.onShow((s) => {
        setShow(s);
        setSeq((n) => n + 1);
      }),
    [],
  );
  useEffect(() => window.popup.onData((d) => setShow((s) => (s && s.kind === d.kind ? ({ ...s, ...d } as PopupShow) : s))), []);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) window.popup.close();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  if (!show) return null;
  return (
    <>
      <div className="menu-backdrop" onMouseDown={() => window.popup.close()} />
      {show.kind === 'menu' && <MenuPanel key={seq} show={show} />}
      {show.kind === 'connection' && (
        <Anchored key={seq} show={show} className="connection-panel">
          <ConnectionPanel data={show.data} />
        </Anchored>
      )}
      {show.kind === 'bookmarks' && (
        <Anchored key={seq} show={show} className="bookmarks-panel">
          <BookmarksPanel data={show.data} />
        </Anchored>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<PopupApp />);
