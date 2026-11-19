import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { BookmarksState, BrowserSettings, ProfilesState, TabInfo, TabsState, TunnelState, UpdateState, WindowProfileInfo, WindowProfilesState } from '../shared/types';
import { BookmarkStar, BookmarkTiles, BookmarksBar } from './bookmarks';
import { SiteIcon, api, errText, useBridge, type Run } from './bridge';
import { siteTime, useNow } from './clock';
import { flag, ipText } from './format';
import { Markdown } from './markdown';
import * as I from './icons';
import { Ping } from './connectionCard';
import { SettingsView, type SettingsSection } from './settings';
import { ProfileChip, useProfileChrome } from './windows';

const isMac = api.app.platform === 'darwin';

/**
 * The panel under the IP or the bookmarks button (drawn over the page by main/popup.ts):
 * right-aligned under its button.
 */
function openPanelUnder(kind: 'connection' | 'bookmarks', editId?: string) {
  const button = document.querySelector(kind === 'connection' ? '.toolbar .pill' : '.toolbar [aria-label="Закладки"]');
  if (!button) return;
  const r = button.getBoundingClientRect();
  void api.app.panel(kind, r.right, r.bottom + 4, editId);
}

/** A place in the tab strip: a tab's id, or the settings tab. */
type StripKey = number | 'settings';

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
  // `after`: the tab it stands after in the strip (null: first). New tabs open next to the
  // active one, so a plain position would drift.
  const [settings, setSettings] = useState<{ section: SettingsSection; active: boolean; after: number | null } | null>(null);
  const [lastSection, setLastSection] = useState<SettingsSection>('connection');
  const [toast, setToast] = useState<string | null>(null);
  const [fullScreen, setFullScreen] = useState(false);

  // Same rule as the main process: pages are shown only while the tunnel answers.
  const locked = tunnel.status !== 'connected';
  const active = tabs.tabs.find((t) => t.id === tabs.activeId) ?? null;

  const lastRef = useRef(lastSection);
  const activeRef = useRef(tabs.activeId);
  activeRef.current = tabs.activeId;
  const openSettings = useCallback((s: SettingsSection) => {
    // A new settings tab opens next to the active tab, like any new tab.
    setSettings((st) => ({ section: s, active: true, after: st ? st.after : activeRef.current }));
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
  // The strip: the tabs, with the settings tab after its neighbour. Its neighbour closed: it
  // keeps its place (the tab before it becomes the neighbour).
  const settingsAt = useRef(0);
  const strip: StripKey[] = tabs.tabs.map((t) => t.id);
  if (settings) {
    let at = settings.after === null ? 0 : strip.indexOf(settings.after) + 1;
    if (settings.after !== null && at === 0) at = Math.min(settingsAt.current, strip.length);
    settingsAt.current = at;
    strip.splice(at, 0, 'settings');
  }
  useEffect(() => {
    if (!settings || settings.after === null || tabs.tabs.some((t) => t.id === settings.after)) return;
    const at = strip.indexOf('settings');
    const before = at > 0 ? strip[at - 1] : null;
    setSettings({ ...settings, after: typeof before === 'number' ? before : null });
  });
  /** A tab or the settings tab was dragged: `order` is the strip as it is now. */
  const reorder = (order: StripKey[], moved: StripKey) => {
    const real = order.filter((k): k is number => k !== 'settings');
    if (moved !== 'settings') void api.tabs.move(moved, real.indexOf(moved));
    const at = order.indexOf('settings');
    if (at >= 0) setSettings((st) => st && { ...st, after: at > 0 ? (order[at - 1] as number) : null });
  };

  // A query or a bookmark from the settings tab: into an empty tab (the one under the settings
  // first), and the settings tab stays; with no empty tab, the settings tab becomes the page.
  const latest = useRef({ tabs, settings, strip });
  latest.current = { tabs, settings, strip };
  const navigateFromSettings = useCallback(
    async (input: string) => {
      const { tabs: t, settings: st } = latest.current;
      const under = t.tabs.find((x) => x.id === t.activeId);
      const empty = under && !under.url ? under : [...t.tabs].reverse().find((x) => !x.url);
      if (empty) {
        await api.tabs.navigate(empty.id, input);
        leaveSettings();
        await api.tabs.activate(empty.id);
        return;
      }
      const after = st?.after ?? null;
      closeSettings();
      const id = await api.tabs.create(input);
      const order = (await api.tabs.get()).tabs.map((x) => x.id).filter((x) => x !== id);
      await api.tabs.move(id, after === null ? 0 : order.indexOf(after) + 1);
    },
    [leaveSettings, closeSettings],
  );
  useEffect(() => api.tabs.onSettingsNavigate((url) => void navigateFromSettings(url).catch((e) => setToast(errText(e)))), [navigateFromSettings]);

  // Ctrl/Cmd+W and Ctrl+Tab from the menu, while the settings tab is open.
  useEffect(
    () =>
      api.tabs.onSettingsTabCommand((cmd) => {
        if (cmd === 'close') return closeSettings();
        const { tabs: t, settings: st, strip: order } = latest.current;
        if (!st) return;
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
        if (p === 'bookmarks') openPanelUnder('bookmarks', id);
        else openSettings(p === 'servers' ? 'connection' : p === 'profiles' ? 'profiles' : lastRef.current);
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
        strip={strip}
        onReorder={reorder}
        settings={settings && { active: settings.active, onSelect: () => openSettings(settings.section), onClose: closeSettings }}
        chip={<ProfileChip me={me} tunnel={tunnel} onClick={() => toggleSettings('profiles')} />}
      />
      <Toolbar
        tab={settings?.active ? null : active}
        locked={locked}
        tunnel={tunnel}
        bookmarks={bookmarks}
        settingsActive={!!settings?.active}
        onSettingsQuery={(q) => run(() => navigateFromSettings(q))}
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
  /** the tabs and the settings tab, in strip order */
  strip: StripKey[];
  onReorder: (order: StripKey[], moved: StripKey) => void;
  onToast: (s: string) => void;
  onTab: () => void;
  settings: { active: boolean; onSelect: () => void; onClose: () => void } | null;
  chip: ReactNode;
}) {
  const { tabs, strip, onReorder, onToast, onTab, settings, chip } = props;
  const [dragKey, setDragKey] = useState<StripKey | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const byId = new Map(tabs.tabs.map((t) => [t.id, t]));
  const drop = () => {
    if (dragKey !== null && dropAt !== null) {
      const from = strip.indexOf(dragKey);
      const order = strip.filter((k) => k !== dragKey);
      order.splice(from < dropAt ? dropAt - 1 : dropAt, 0, dragKey);
      if (order.join() !== strip.join()) onReorder(order, dragKey);
    }
    setDragKey(null);
    setDropAt(null);
  };
  /** What every tab in the strip does for dragging, the settings tab included. */
  const dragProps = (key: StripKey, i: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      setDragKey(key);
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (dragKey === null) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      drop();
    },
    onDragEnd: () => {
      setDragKey(null);
      setDropAt(null);
    },
  });
  const dropClass = (i: number) => `${dropAt === i ? 'drop-before' : ''} ${dropAt === i + 1 && i === strip.length - 1 ? 'drop-after' : ''}`;

  return (
    <div className="tabstrip">
      {chip}
      {strip.map((key, i) => {
        if (key === 'settings') {
          if (!settings) return null;
          return (
            <div
              key="settings"
              className={`tab settings-tab ${settings.active ? 'active' : ''} ${dropClass(i)}`}
              title="Настройки"
              {...dragProps(key, i)}
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
          );
        }
        const t = byId.get(key);
        if (!t) return null;
        return (
          <div
            key={t.id}
            className={`tab ${t.id === tabs.activeId && !settings?.active ? 'active' : ''} ${dropClass(i)}`}
            {...dragProps(key, i)}
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
            <button className="icon-btn tab-close" aria-label="Закрыть вкладку" onMouseDown={(e) => e.stopPropagation()} onClick={() => void api.tabs.close(t.id)}>
              <I.Close size={12} />
            </button>
          </div>
        );
      })}
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
  /** an address typed while the settings tab is in front */
  onSettingsQuery: (input: string) => void;
  run: Run;
  updateReady: boolean;
}) {
  const { tab, locked, tunnel, bookmarks, settingsActive, onSettingsQuery, run, updateReady } = props;
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
    if (settingsActive) onSettingsQuery(value);
    else if (tab) void run(() => api.tabs.navigate(tab.id, value));
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
      <button className="icon-btn" onClick={() => openPanelUnder('bookmarks')} aria-label="Закладки" title="Закладки (Ctrl/⌘+Alt+B)">
        <I.Bookmarks />
      </button>
      <StatusPill tunnel={tunnel} onClick={() => openPanelUnder('connection')} />
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
          {showNotes && update.notes && <Markdown text={update.notes} className="notes" />}
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
    <div className="start-note" title={`Время для сайтов (${zone}): так они не отличат вас от жителя страны сервера.`}>
      <I.Clock size={14} />
      <span>Для сайтов: {siteTime(zone, now)}</span>
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
              <Ping tunnel={tunnel} onMeasure={() => run(() => api.tunnel.measure())} />
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
