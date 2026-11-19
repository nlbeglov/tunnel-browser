import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { BookmarksState, OpenMode, TabInfo } from '../shared/types';
import { SiteIcon, api, type Run } from './bridge';
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
    // Shown once: until it is closed or the first bookmark is added (App.tsx decides).
    return (
      <div className="bookmarks-bar empty">
        <span>
          Закладки появятся здесь: нажмите <I.Star size={12} /> в адресной строке или Ctrl/⌘+D
        </span>
        <button className="icon-btn bm-hint-close" aria-label="Больше не показывать подсказку" title="Больше не показывать" onClick={() => void api.app.setSettings({ bookmarksHint: false })}>
          <I.Close size={12} />
        </button>
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
            <SiteIcon url={b.url} icon={b.icon} size={14} />
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
          <SiteIcon url={b.url} icon={b.icon} size={32} />
          <span>{b.title}</span>
        </button>
      ))}
    </div>
  );
}
