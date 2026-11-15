import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { Bookmark, BookmarksState, OpenMode, TabInfo } from '../shared/types';
import { LetterIcon, api, type Run } from './bridge';
import { hostOf } from './format';
import * as I from './icons';

/** Chrome's rules: plain click opens here, Ctrl/Cmd or middle click opens a background tab,
 * with Shift a foreground tab. */
export function openModeFor(e: MouseEvent): OpenMode {
  const withMod = e.ctrlKey || e.metaKey || e.button === 1;
  if (withMod) return e.shiftKey ? 'new-tab' : 'background';
  return e.shiftKey ? 'new-tab' : 'current';
}

export function BookmarkStar({ tab, bookmarks, locked, run }: { tab: TabInfo | null; bookmarks: BookmarksState; locked: boolean; run: Run }) {
  const url = tab?.url ?? '';
  const can = !locked && /^https?:\/\//.test(url);
  const existing = can ? bookmarks.items.find((b) => sameUrl(b.url, url)) : undefined;
  return (
    <button
      type="button"
      className={`icon-btn star ${existing ? 'on' : ''}`}
      disabled={!can}
      aria-label={existing ? 'Удалить из закладок' : 'Добавить в закладки'}
      title={existing ? 'Удалить из закладок' : 'Добавить в закладки (Ctrl/⌘+D)'}
      onClick={() => run(() => (existing ? api.bookmarks.remove(existing.id) : api.bookmarks.add(url, tab?.title ?? url)))}
    >
      <I.Star size={15} filled={!!existing} />
    </button>
  );
}

function sameUrl(a: string, b: string): boolean {
  const n = (x: string) => {
    try {
      const u = new URL(x);
      u.hash = '';
      return u.toString().replace(/\/$/, '');
    } catch {
      return x;
    }
  };
  return n(a) === n(b);
}

/** The bar under the toolbar. Bookmarks that do not fit go into a native "»" menu, which,
 * unlike an HTML dropdown, is drawn above the web page. */
export function BookmarksBar({ bookmarks, run }: { bookmarks: BookmarksState; run: Run }) {
  const bar = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<string[]>([]);

  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const measure = () => {
      const limit = el.getBoundingClientRect().right - 36;
      const out: string[] = [];
      el.querySelectorAll<HTMLElement>('[data-bm]').forEach((chip) => {
        if (chip.getBoundingClientRect().right > limit) out.push(chip.dataset.bm!);
      });
      setHidden((prev) => (prev.join() === out.join() ? prev : out));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [bookmarks.items]);

  if (!bookmarks.items.length) {
    return (
      <div className="bookmarks-bar empty">
        Чтобы добавить сайт в закладки, нажмите <I.Star size={12} /> в адресной строке или Ctrl/⌘+D
      </div>
    );
  }
  return (
    <div className="bookmarks-bar" ref={bar}>
      <div className="bm-chips">
        {bookmarks.items.map((b) => (
          <button
            key={b.id}
            data-bm={b.id}
            className={`bm-chip ${hidden.includes(b.id) ? 'clipped' : ''}`}
            title={`${b.title}\n${b.url}`}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onClick={(e) => run(() => api.bookmarks.open(b.id, openModeFor(e)))}
            onAuxClick={(e) => e.button === 1 && run(() => api.bookmarks.open(b.id, openModeFor(e)))}
            onContextMenu={(e) => {
              e.preventDefault();
              void api.bookmarks.contextMenu(b.id);
            }}
          >
            <LetterIcon url={b.url} size={14} />
            <span>{b.title}</span>
          </button>
        ))}
      </div>
      {hidden.length > 0 && (
        <button className="icon-btn bm-more" title="Остальные закладки" onClick={() => api.bookmarks.overflowMenu(hidden)}>
          »
        </button>
      )}
    </div>
  );
}

export function BookmarksPanel(props: { bookmarks: BookmarksState; editId?: string; run: Run; onClose: () => void }) {
  const { bookmarks, run, onClose } = props;
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | undefined>(props.editId);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  useEffect(() => setEditing(props.editId), [props.editId]);

  const q = query.trim().toLowerCase();
  const list = q ? bookmarks.items.filter((b) => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q)) : bookmarks.items;

  const drop = (index: number) => {
    if (dragId) {
      const from = bookmarks.items.findIndex((b) => b.id === dragId);
      void run(() => api.bookmarks.move(dragId, from < index ? index - 1 : index));
    }
    setDragId(null);
    setDropAt(null);
  };

  return (
    <aside className="panel">
      <header>
        <h3>Закладки</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <I.Close />
        </button>
      </header>
      <div className="panel-body">
        <div className="search-box">
          <I.Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по закладкам" spellCheck={false} />
        </div>
        {!bookmarks.items.length && <p className="muted">Закладок пока нет. Откройте сайт и нажмите звёздочку в адресной строке.</p>}
        {bookmarks.items.length > 0 && !list.length && <p className="muted">Ничего не найдено.</p>}
        <div className="bm-list" onDragLeave={() => setDropAt(null)}>
          {list.map((b) =>
            editing === b.id ? (
              <BookmarkEditor key={b.id} bookmark={b} run={run} onDone={() => setEditing(undefined)} />
            ) : (
              <div
                key={b.id}
                className={`bm-row ${dropAt === bookmarks.items.indexOf(b) ? 'drop-before' : ''} ${dragId === b.id ? 'dragging' : ''}`}
                draggable={!q}
                onDragStart={(e) => {
                  setDragId(b.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  const i = bookmarks.items.indexOf(b);
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
                onClick={(e) => run(() => api.bookmarks.open(b.id, openModeFor(e)))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void api.bookmarks.contextMenu(b.id);
                }}
              >
                <LetterIcon url={b.url} size={18} />
                <div className="bm-text">
                  <div className="bm-title">{b.title}</div>
                  <div className="muted small">{hostOf(b.url)}</div>
                </div>
                <div className="row-actions">
                  <button
                    className="icon-btn"
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
                    title="Удалить"
                    onClick={(e) => {
                      e.stopPropagation();
                      void run(() => api.bookmarks.remove(b.id));
                    }}
                  >
                    <I.Trash size={14} />
                  </button>
                </div>
              </div>
            ),
          )}
          {dragId && (
            <div
              className={`bm-drop-end ${dropAt === bookmarks.items.length ? 'drop-before' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDropAt(bookmarks.items.length);
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(bookmarks.items.length);
              }}
            />
          )}
        </div>
        {bookmarks.items.length > 1 && !q && <p className="muted small">Порядок меняется перетаскиванием.</p>}
      </div>
    </aside>
  );
}

function BookmarkEditor({ bookmark, run, onDone }: { bookmark: Bookmark; run: Run; onDone: () => void }) {
  const [title, setTitle] = useState(bookmark.title);
  const [url, setUrl] = useState(bookmark.url);
  return (
    <form
      className="bm-edit"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api.bookmarks.update(bookmark.id, { title, url });
          onDone();
        });
      }}
    >
      <label>
        Название
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} spellCheck={false} />
      </label>
      <label>
        Адрес
        <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
      </label>
      <div className="row-actions">
        <button className="btn primary small" type="submit">
          Сохранить
        </button>
        <button className="btn small" type="button" onClick={onDone}>
          Отмена
        </button>
        <button className="btn small danger" type="button" onClick={() => run(() => api.bookmarks.remove(bookmark.id))}>
          Удалить
        </button>
      </div>
    </form>
  );
}

/** Speed-dial tiles on the start page. */
export function BookmarkTiles({ bookmarks, run }: { bookmarks: BookmarksState; run: Run }) {
  const items = bookmarks.items.slice(0, 8);
  if (!items.length) return null;
  return (
    <div className="tiles">
      {items.map((b) => (
        <button
          key={b.id}
          className="tile"
          title={b.url}
          onClick={(e) => run(() => api.bookmarks.open(b.id, openModeFor(e)))}
          onAuxClick={(e) => e.button === 1 && run(() => api.bookmarks.open(b.id, 'background'))}
          onContextMenu={(e) => {
            e.preventDefault();
            void api.bookmarks.contextMenu(b.id);
          }}
        >
          <LetterIcon url={b.url} size={32} />
          <span>{b.title}</span>
        </button>
      ))}
    </div>
  );
}
