import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { BookmarksState, BrowserSettings, ProfilesState, TabInfo, TabsState, TunnelState, UpdateState, WindowProfileInfo, WindowProfilesState } from '../shared/types';
import { BookmarkStar, BookmarkTiles, BookmarksBar, BookmarksPanel } from './bookmarks';
import { SiteIcon, api, errText, useBridge, type Run } from './bridge';
import { timeIn, useNow, zoneLabel } from './clock';
import { flag, ipText } from './format';
import * as I from './icons';
import { Ping, SettingsView, type SettingsSection } from './settings';
import { ProfileChip, useProfileChrome } from './windows';

const isMac = api.app.platform === 'darwin';

export function App() {
  const tunnel = useBridge<TunnelState>({ status: 'disconnected' }, api.tunnel.get, api.tunnel.onChange);
  const tabs = useBridge<TabsState>({ tabs: [], activeId: null, canReopen: false }, api.tabs.get, api.tabs.onChange);
  const profiles = useBridge<ProfilesState>({ profiles: [], subscriptions: [] }, api.profiles.get, api.profiles.onChange);
  const update = useBridge<UpdateState>({ status: 'idle', currentVersion: '' }, api.updates.get, api.updates.onChange);
  const bookmarks = useBridge<BookmarksState>({ items: [], showBar: true }, api.bookmarks.get, api.bookmarks.onChange);
  const windows = useBridge<WindowProfilesState>({ profiles: [], freeColors: [], current: '' }, api.windows.get, api.windows.onChange);
  const prefs = useBridge<BrowserSettings | null>(null, api.app.settings, api.app.onSettingsChange);
  const me = windows.profiles.find((p) => p.current);
  // Settings are a tab of their own in the strip (no page, no address). While it is the
  // active tab, the page of the selected tab is hidden behind it, not unloaded.
  const [settings, setSettings] = useState<{ section: SettingsSection; active: boolean } | null>(null);
  const [lastSection, setLastSection] = useState<SettingsSection>('connection');
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [editBookmark, setEditBookmark] = useState<string | undefined>();
  const [toast, setToast] = useState<string | null>(null);
  const [fullScreen, setFullScreen] = useState(false);

  // Same rule as the main process: pages are shown only while the tunnel answers.
  const locked = tunnel.status !== 'connected';
  const active = tabs.tabs.find((t) => t.id === tabs.activeId) ?? null;

  const lastRef = useRef(lastSection);
  const openSettings = useCallback((s: SettingsSection) => {
    setSettings({ section: s, active: true });
    setLastSection(s);
    lastRef.current = s;
  }, []);
  /** Another tab comes to the front; the settings tab stays in the strip. */
  const leaveSettings = useCallback(() => setSettings((st) => (st?.active ? { ...st, active: false } : st)), []);
  const closeSettings = useCallback(() => setSettings(null), []);
  /** The ⋮ button, the pill, the profile badge: show that section, or go back to the page. */
  const toggleSettings = (s?: SettingsSection) =>
    settings?.active && (!s || settings.section === s) ? leaveSettings() : openSettings(s ?? settings?.section ?? lastSection);

  const settingsTab = settings ? (settings.active ? 'active' : 'open') : 'closed';
  useEffect(() => {
    api.tabs.setSettingsTab(settingsTab);
  }, [settingsTab]);
  // Another tab, or a new one, came to the front.
  useEffect(leaveSettings, [tabs.activeId]);
  // Ctrl/Cmd+W and Ctrl+Tab from the menu, while the settings tab is open.
  const latest = useRef({ tabs, settings });
  latest.current = { tabs, settings };
  useEffect(
    () =>
      api.tabs.onSettingsTabCommand((cmd) => {
        if (cmd === 'close') return closeSettings();
        const { tabs: t, settings: st } = latest.current;
        if (!st) return;
        const order: Array<number | 'settings'> = [...t.tabs.map((x) => x.id), 'settings'];
        const at = order.indexOf(st.active ? 'settings' : (t.activeId ?? 'settings'));
        const next = order[(at + (cmd === 'next' ? 1 : -1) + order.length) % order.length];
        if (next === 'settings') setSettings({ ...st, active: true });
        else {
          leaveSettings();
          void api.tabs.activate(next);
        }
      }),
    [],
  );
  useEffect(() => {
    if (!toast || toast.length > 120) return; // long messages (storage problems) stay until closed
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(
    () =>
      api.app.onOpenPanel((p, id) => {
        if (p === 'bookmarks') {
          setBookmarksOpen(true);
          setEditBookmark(id);
        } else openSettings(p === 'servers' ? 'connection' : p === 'profiles' ? 'profiles' : lastRef.current);
      }),
    [],
  );
  useEffect(() => api.app.onFullScreen(setFullScreen), []);
  useProfileChrome(me, tunnel);
  useEffect(() => api.app.onError(setToast), []);

  const run = useCallback<Run>(async (fn) => {
    try {
      await fn();
    } catch (e) {
      setToast(errText(e));
    }
  }, []);

  return (
    <div className={`app ${isMac ? 'mac' : 'wco'} ${fullScreen ? 'fullscreen' : ''}`}>
      <TabStrip
        tabs={tabs}
        onToast={setToast}
        onTab={leaveSettings}
        settings={settings && { active: settings.active, onSelect: () => openSettings(settings.section), onClose: closeSettings }}
        chip={<ProfileChip me={me} tunnel={tunnel} onClick={() => toggleSettings('profiles')} />}
      />
      <Toolbar
        tab={settings?.active ? null : active}
        locked={locked}
        tunnel={tunnel}
        bookmarks={bookmarks}
        settingsActive={!!settings?.active}
        toggleSettings={toggleSettings}
        toggleBookmarks={() => {
          setEditBookmark(undefined);
          setBookmarksOpen(!bookmarksOpen);
        }}
        onNavigate={closeSettings}
        run={run}
        updateReady={update.status === 'available'}
      />
      {bookmarks.showBar && !locked && (bookmarks.items.length > 0 || prefs?.bookmarksHint) && <BookmarksBar bookmarks={bookmarks} run={run} />}
      <UpdateBanner update={update} run={run} />
      {tunnel.status === 'degraded' && (
        <div className="banner warn">
          <I.Warn />
          <span>{tunnel.message} Вкладки скрыты, пока связь не восстановится; мимо туннеля трафик не идёт.</span>
          <button className="btn small" onClick={() => run(() => api.tunnel.connect(tunnel.profileId))}>
            Переподключить
          </button>
        </div>
      )}
      {/* In the page flow, not floating: a floating toast would hide behind the web page view. */}
      {toast && (
        <div className="banner error" role="alert">
          <I.Warn />
          <span>{toast}</span>
          <button className="icon-btn" aria-label="Скрыть" onClick={() => setToast(null)}>
            <I.Close size={14} />
          </button>
        </div>
      )}
      <div className="body">
        <Content tab={active} tunnel={tunnel} locked={locked} me={me} profiles={profiles} bookmarks={bookmarks} run={run} openServers={() => openSettings('connection')}>
          {settings?.active && (
            <SettingsView
              section={settings.section}
              onSection={openSettings}
              tunnel={tunnel}
              servers={profiles}
              windows={windows}
              update={update}
              run={run}
            />
          )}
        </Content>
        {bookmarksOpen && <BookmarksPanel bookmarks={bookmarks} editId={editBookmark} run={run} onClose={() => setBookmarksOpen(false)} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tabs

function Favicon({ tab }: { tab: TabInfo }) {
  if (tab.loading) return <span className="spinner" />;
  if (!tab.url)
    return (
      <span className="tab-blank" aria-hidden="true">
        <I.Shield size={14} />
      </span>
    );
  return <SiteIcon url={tab.url} icon={tab.icon} />;
}

function TabStrip(props: {
  tabs: TabsState;
  onToast: (s: string) => void;
  onTab: () => void;
  settings: { active: boolean; onSelect: () => void; onClose: () => void } | null;
  chip: ReactNode;
}) {
  const { tabs, onToast, onTab, settings, chip } = props;
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const drop = () => {
    if (dragId !== null && dropAt !== null) {
      const from = tabs.tabs.findIndex((t) => t.id === dragId);
      void api.tabs.move(dragId, from < dropAt ? dropAt - 1 : dropAt);
    }
    setDragId(null);
    setDropAt(null);
  };
  return (
    <div className="tabstrip">
      {chip}
      {tabs.tabs.map((t, i) => (
        <div
          key={t.id}
          className={`tab ${t.id === tabs.activeId && !settings?.active ? 'active' : ''} ${dropAt === i ? 'drop-before' : ''} ${dropAt === i + 1 && i === tabs.tabs.length - 1 ? 'drop-after' : ''}`}
          draggable
          onDragStart={(e) => {
            setDragId(t.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => {
            if (dragId === null) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
          }}
          onDrop={(e) => {
            e.preventDefault();
            drop();
          }}
          onDragEnd={() => {
            setDragId(null);
            setDropAt(null);
          }}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              void api.tabs.close(t.id);
            } else if (e.button === 0) {
              onTab();
              void api.tabs.activate(t.id);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            void api.tabs.contextMenu(t.id);
          }}
          title={t.title}
        >
          <Favicon tab={t} />
          <span className="tab-title">{t.title}</span>
          <button
            className="icon-btn tab-close"
            aria-label="Закрыть вкладку"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => void api.tabs.close(t.id)}
          >
            <I.Close size={12} />
          </button>
        </div>
      ))}
      {settings && (
        <div
          className={`tab settings-tab ${settings.active ? 'active' : ''}`}
          title="Настройки"
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              settings.onClose();
            } else if (e.button === 0) settings.onSelect();
          }}
        >
          <span className="tab-blank" aria-hidden="true">
            <I.Gear size={14} />
          </span>
          <span className="tab-title">Настройки</span>
          <button className="icon-btn tab-close" aria-label="Закрыть настройки" onMouseDown={(e) => e.stopPropagation()} onClick={settings.onClose}>
            <I.Close size={12} />
          </button>
        </div>
      )}
      <button className="icon-btn new-tab" aria-label="Новая вкладка" title="Новая вкладка (Ctrl/⌘+T)" onClick={() => api.tabs.create().catch((e) => onToast(errText(e)))}>
        <I.Plus />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- toolbar

function StatusPill({ tunnel, onClick }: { tunnel: TunnelState; onClick: () => void }) {
  const s = tunnel.status;
  const label =
    s === 'connected'
      ? tunnel.exit && tunnel.exit.ip !== '?'
        ? `${flag(tunnel.exit.country)} ${tunnel.exit.ip}`.trim()
        : 'Подключено'
      : s === 'degraded'
        ? 'Туннель недоступен'
        : s === 'connecting'
          ? 'Подключение…'
          : s === 'error'
            ? 'Ошибка'
            : 'Не подключено';
  return (
    <button className={`pill ${s}`} onClick={onClick} title={tunnel.profileName ?? 'Серверы'}>
      <span className="dot" />
      <span className="pill-text">{label}</span>
    </button>
  );
}

function Toolbar(props: {
  tab: TabInfo | null;
  locked: boolean;
  tunnel: TunnelState;
  bookmarks: BookmarksState;
  settingsActive: boolean;
  toggleSettings: (s?: SettingsSection) => void;
  toggleBookmarks: () => void;
  onNavigate: () => void;
  run: Run;
  updateReady: boolean;
}) {
  const { tab, locked, tunnel, bookmarks, settingsActive, toggleSettings, toggleBookmarks, onNavigate, run, updateReady } = props;
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setValue(tab?.url ?? '');
  }, [tab?.url, tab?.id, editing]);
  useEffect(() => api.tabs.onFocusAddressBar(() => input.current?.select()), []);
  useEffect(() => {
    if (tab && !tab.url && !locked) input.current?.focus();
  }, [tab?.id, locked]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setEditing(false);
    input.current?.blur();
    // From the settings tab the site opens in a tab of its own: the page under it stays.
    if (settingsActive) {
      onNavigate();
      void run(() => api.tabs.create(value));
    } else if (tab) void run(() => api.tabs.navigate(tab.id, value));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setEditing(false);
      setValue(tab?.url ?? '');
      input.current?.blur();
    }
  };
  const secure = !locked && tab?.url.startsWith('https://');

  return (
    <div className="toolbar">
      <button className="icon-btn" disabled={!tab?.canGoBack || locked} onClick={() => tab && api.tabs.back(tab.id)} aria-label="Назад">
        <I.Back />
      </button>
      <button className="icon-btn" disabled={!tab?.canGoForward || locked} onClick={() => tab && api.tabs.forward(tab.id)} aria-label="Вперёд">
        <I.Forward />
      </button>
      {tab?.loading ? (
        <button className="icon-btn" onClick={() => api.tabs.stop(tab.id)} aria-label="Остановить">
          <I.Stop />
        </button>
      ) : (
        <button className="icon-btn" disabled={!tab?.url || locked} onClick={() => tab && api.tabs.reload(tab.id)} aria-label="Перезагрузить">
          <I.Reload />
        </button>
      )}
      <form className={`address ${locked ? 'disabled' : ''}`} onSubmit={submit}>
        <span className={`address-icon ${secure ? 'secure' : ''}`}>
          {settingsActive ? <I.Gear size={14} /> : locked || secure ? <I.Lock size={14} /> : <I.Search size={14} />}
        </span>
        <input
          ref={input}
          value={locked ? '' : value}
          disabled={locked}
          placeholder={locked ? 'Браузер заблокирован — подключите туннель' : 'Введите адрес или запрос для поиска'}
          spellCheck={false}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
        />
        <BookmarkStar tab={tab} bookmarks={bookmarks} locked={locked} run={run} />
      </form>
      <button className="icon-btn" onClick={toggleBookmarks} aria-label="Закладки" title="Закладки (Ctrl/⌘+Alt+B)">
        <I.Bookmarks />
      </button>
      <StatusPill tunnel={tunnel} onClick={() => toggleSettings('connection')} />
      <button
        className={`icon-btn ${updateReady ? 'badge' : ''}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          void api.app.mainMenu(r.right, r.bottom + 4);
        }}
        aria-label="Меню"
        aria-haspopup="menu"
        title={updateReady ? 'Меню: есть обновление' : 'Меню'}
      >
        <I.Menu />
      </button>
    </div>
  );
}

function UpdateBanner({ update, run }: { update: UpdateState; run: Run }) {
  const [showNotes, setShowNotes] = useState(false);
  if (update.status === 'available') {
    return (
      <div className="banner info">
        <I.Download />
        <span>
          Доступна новая версия <b>{update.version}</b>.
          {update.notes && (
            <button className="link" onClick={() => setShowNotes(!showNotes)}>
              {showNotes ? 'Скрыть' : 'Что нового'}
            </button>
          )}
          {showNotes && <pre className="notes">{update.notes}</pre>}
        </span>
        <button className="btn small primary" onClick={() => run(() => api.updates.install())}>
          Обновить
        </button>
      </div>
    );
  }
  if (update.status === 'downloading' || update.status === 'installing') {
    return (
      <div className="banner info">
        <I.Download />
        <span>{update.status === 'installing' ? 'Устанавливаем обновление, приложение перезапустится…' : `Скачиваем обновление ${update.version}… ${update.percent ?? 0}%`}</span>
        <div className="progress">
          <div ref={(el) => el?.style.setProperty('width', `${update.percent ?? 0}%`)} />
        </div>
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------- content

function Content(props: {
  tab: TabInfo | null;
  tunnel: TunnelState;
  locked: boolean;
  me: WindowProfileInfo | undefined;
  profiles: ProfilesState;
  bookmarks: BookmarksState;
  run: Run;
  openServers: () => void;
  /** the settings page, when open: it takes the place of the page */
  children?: ReactNode;
}) {
  const { tab, tunnel, locked, me, profiles, bookmarks, run, openServers, children } = props;
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      api.tabs.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
    };
  }, []);

  let inner: ReactNode = null;
  if (children) inner = children;
  else if (locked) inner = <LockScreen tunnel={tunnel} me={me} profiles={profiles} run={run} openServers={openServers} />;
  else if (tab && !tab.url) inner = <StartPage tab={tab} tunnel={tunnel} bookmarks={bookmarks} run={run} />;
  else if (tab?.error)
    inner = (
      <div className="center">
        <div className="card">
          <I.Warn size={28} />
          <h2>Страница не открылась</h2>
          <p>{tab.error}</p>
          <p className="muted small">{tab.url}</p>
          <button className="btn primary" onClick={() => run(() => api.tabs.reload(tab.id))}>
            Повторить
          </button>
        </div>
      </div>
    );

  return (
    <div className="content" ref={ref}>
      {inner}
    </div>
  );
}

function LockScreen(props: {
  tunnel: TunnelState;
  me: WindowProfileInfo | undefined;
  profiles: ProfilesState;
  run: Run;
  openServers: () => void;
}) {
  const { tunnel, me, profiles, run, openServers } = props;
  const selected = profiles.profiles.find((p) => p.id === profiles.selectedId);
  const connecting = tunnel.status === 'connecting';
  if (tunnel.status === 'degraded') {
    return (
      <div className="center">
        <div className="card lock">
          <div className="lock-icon warn">
            <I.ShieldOff size={40} />
          </div>
          <h2>Туннель недоступен</h2>
          <p>
            Сервер «{tunnel.profileName}» перестал отвечать. Как только он снова ответит, вкладки вернутся сами. Можно
            не ждать: переподключиться или выбрать другой сервер.
          </p>
          <div className="lock-actions">
            <button className="btn primary big" onClick={() => run(() => api.tunnel.connect(tunnel.profileId))}>
              Переподключить
            </button>
            <button className="btn ghost" onClick={openServers}>
              Сменить сервер
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (connecting) {
    return (
      <div className="center">
        <div className="card lock">
          <div className="lock-icon pulse">
            <I.Shield size={40} />
          </div>
          <h2>Подключаемся к «{tunnel.profileName}»</h2>
          <p>Проверяем, что трафик действительно идёт через сервер. Браузер откроется только после этого.</p>
          <button className="btn ghost" onClick={() => run(() => api.tunnel.disconnect())}>
            Отмена
          </button>
        </div>
      </div>
    );
  }

  // The profile keeps its server; another one is never picked for it silently.
  let title = 'Браузер заблокирован';
  let text: ReactNode = 'Сайты открываются только через туннель. Пока он не подключён, у браузера нет доступа в интернет.';
  let actions: ReactNode;
  if (selected) {
    actions = (
      <>
        <p className="lock-server">
          Сервер профиля{me ? ` «${me.name}»` : ''}: <b>{selected.name}</b>
        </p>
        <div className="lock-actions">
          <button className="btn primary big" onClick={() => run(() => api.tunnel.connect(selected.id))}>
            Подключить
          </button>
          <button className="btn ghost" onClick={openServers}>
            Сменить сервер
          </button>
        </div>
      </>
    );
  } else if (!profiles.profiles.length) {
    actions = (
      <button className="btn primary big" onClick={openServers}>
        Добавить сервер
      </button>
    );
  } else {
    if (me?.serverMissing) {
      title = `Сервера «${me.serverName}» больше нет`;
      text = `Провайдер убрал его из подписки, или он был удалён. Выберите другой сервер для профиля «${me.name}»: приложение само его не поменяет.`;
    } else {
      title = 'Выберите сервер';
      text = `Профиль${me ? ` «${me.name}»` : ''} ещё не подключался. Выберите, через какой сервер он будет работать; приложение запомнит выбор.`;
    }
    actions = (
      <button className="btn primary big" onClick={openServers}>
        Выбрать сервер
      </button>
    );
  }
  return (
    <div className="center">
      <div className="card lock">
        <div className="lock-icon">
          <I.ShieldOff size={40} />
        </div>
        <h2>{title}</h2>
        <p>{text}</p>
        {tunnel.status === 'error' && tunnel.message && <p className="error-text">{tunnel.message}</p>}
        {actions}
      </div>
    </div>
  );
}

/** What sites see of time and language: the clock of the exit's zone, ticking. */
function SiteClock({ zone }: { zone: string }) {
  const now = useNow();
  return (
    <div className="start-note" title={`Часовой пояс ${zone}. Так сайты не отличат вас от жителя страны сервера по часам и языку.`}>
      <I.Clock size={14} />
      <span>Для сайтов</span>
      <time className="clock" dateTime={now.toISOString()}>
        {timeIn(zone, now)}
      </time>
      <span>{zoneLabel(zone, now)}</span>
      <span className="sep" aria-hidden="true" />
      <span>English (US)</span>
    </div>
  );
}

function StartPage({ tab, tunnel, bookmarks, run }: { tab: TabInfo; tunnel: TunnelState; bookmarks: BookmarksState; run: Run }) {
  const [q, setQ] = useState('');
  return (
    <div className="center">
      <div className="start">
        <div className="start-badge">
          <I.Shield size={18} />
          <span>Защищено туннелем</span>
          {tunnel.exit && (
            <>
              <span className="sep" aria-hidden="true" />
              <span>
                {flag(tunnel.exit.country)} {ipText(tunnel.exit.ip)}
              </span>
              <span className="sep" aria-hidden="true" />
              <Ping tunnel={tunnel} run={run} />
            </>
          )}
        </div>
        {tunnel.exit?.timezone && <SiteClock zone={tunnel.exit.timezone} />}
        <form
          className="start-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) void run(() => api.tabs.navigate(tab.id, q));
          }}
        >
          <I.Search />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск в DuckDuckGo или адрес сайта" spellCheck={false} />
        </form>
        <BookmarkTiles bookmarks={bookmarks} run={run} />
      </div>
    </div>
  );
}
