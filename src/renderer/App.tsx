import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type {
  BridgeApi,
  ProfilesState,
  ReleaseEntry,
  TabInfo,
  TabsState,
  TunnelState,
  UpdateState,
} from '../shared/types';
import { flag, hostOf, profileLine, usageLine } from './format';
import * as I from './icons';

declare global {
  interface Window {
    api: BridgeApi;
  }
}
const api = window.api;

function useBridge<T>(initial: T, get: () => Promise<T>, onChange: (cb: (v: T) => void) => () => void): T {
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

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

type Panel = null | 'servers' | 'settings';

export function App() {
  const tunnel = useBridge<TunnelState>({ status: 'disconnected' }, api.tunnel.get, api.tunnel.onChange);
  const tabs = useBridge<TabsState>({ tabs: [], activeId: null }, api.tabs.get, api.tabs.onChange);
  const profiles = useBridge<ProfilesState>({ profiles: [], subscriptions: [] }, api.profiles.get, api.profiles.onChange);
  const update = useBridge<UpdateState>({ status: 'idle', currentVersion: '' }, api.updates.get, api.updates.onChange);
  const [panel, setPanel] = useState<Panel>(null);
  const [toast, setToast] = useState<string | null>(null);

  const locked = tunnel.status !== 'connected' && tunnel.status !== 'degraded';
  const active = tabs.tabs.find((t) => t.id === tabs.activeId) ?? null;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      setToast(errText(e));
    }
  }, []);

  return (
    <div className="app">
      <TabStrip tabs={tabs} onToast={setToast} />
      <Toolbar
        tab={active}
        locked={locked}
        tunnel={tunnel}
        panel={panel}
        setPanel={setPanel}
        run={run}
        updateReady={update.status === 'available'}
      />
      <UpdateBanner update={update} run={run} />
      {tunnel.status === 'degraded' && (
        <div className="banner warn">
          <I.Warn />
          <span>{tunnel.message} Страницы не загрузятся, пока связь не восстановится; мимо туннеля трафик не идёт.</span>
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
        <Content tab={active} tunnel={tunnel} locked={locked} profiles={profiles} run={run} openServers={() => setPanel('servers')} />
        {panel === 'servers' && <ServersPanel profiles={profiles} tunnel={tunnel} run={run} onClose={() => setPanel(null)} />}
        {panel === 'settings' && <SettingsPanel update={update} run={run} onClose={() => setPanel(null)} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tabs

function Favicon({ tab }: { tab: TabInfo }) {
  if (tab.loading) return <span className="spinner" />;
  const host = hostOf(tab.url);
  const letter = (host[0] ?? '•').toUpperCase();
  let hue = 0;
  for (const ch of host) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="favicon" ref={(el) => el?.style.setProperty('--hue', String(hue))}>
      {letter}
    </span>
  );
}

function TabStrip({ tabs, onToast }: { tabs: TabsState; onToast: (s: string) => void }) {
  return (
    <div className="tabstrip">
      {tabs.tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === tabs.activeId ? 'active' : ''}`}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              void api.tabs.close(t.id);
            } else if (e.button === 0) void api.tabs.activate(t.id);
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
      <button className="icon-btn new-tab" aria-label="Новая вкладка" onClick={() => api.tabs.create().catch((e) => onToast(errText(e)))}>
        <I.Plus />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- toolbar

function StatusPill({ tunnel, onClick }: { tunnel: TunnelState; onClick: () => void }) {
  const s = tunnel.status;
  const label =
    s === 'connected' || s === 'degraded'
      ? `${flag(tunnel.exit?.country)} ${tunnel.exit?.ip ?? ''}`.trim() || tunnel.profileName
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
  panel: Panel;
  setPanel: (p: Panel) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  updateReady: boolean;
}) {
  const { tab, locked, tunnel, panel, setPanel, run, updateReady } = props;
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
    if (!tab || !value.trim()) return;
    setEditing(false);
    input.current?.blur();
    void run(() => api.tabs.navigate(tab.id, value));
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
        <span className={`address-icon ${secure ? 'secure' : ''}`}>{locked || secure ? <I.Lock size={14} /> : <I.Search size={14} />}</span>
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
      </form>
      <StatusPill tunnel={tunnel} onClick={() => setPanel(panel === 'servers' ? null : 'servers')} />
      <button
        className={`icon-btn ${updateReady ? 'badge' : ''}`}
        onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
        aria-label="Настройки"
      >
        <I.Menu />
      </button>
    </div>
  );
}

function UpdateBanner({ update, run }: { update: UpdateState; run: (fn: () => Promise<unknown>) => Promise<void> }) {
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
  profiles: ProfilesState;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  openServers: () => void;
}) {
  const { tab, tunnel, locked, profiles, run, openServers } = props;
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

  let inner = null;
  if (locked) inner = <LockScreen tunnel={tunnel} profiles={profiles} run={run} openServers={openServers} />;
  else if (tab && !tab.url) inner = <StartPage tab={tab} tunnel={tunnel} run={run} />;
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
  profiles: ProfilesState;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  openServers: () => void;
}) {
  const { tunnel, profiles, run, openServers } = props;
  const selected = profiles.profiles.find((p) => p.id === profiles.selectedId);
  const connecting = tunnel.status === 'connecting';
  return (
    <div className="center">
      <div className="card lock">
        <div className={`lock-icon ${connecting ? 'pulse' : ''}`}>{connecting ? <I.Shield size={40} /> : <I.ShieldOff size={40} />}</div>
        {connecting ? (
          <>
            <h2>Подключаемся к «{tunnel.profileName}»</h2>
            <p>Проверяем, что трафик действительно идёт через сервер. Браузер откроется только после этого.</p>
          </>
        ) : (
          <>
            <h2>Браузер заблокирован</h2>
            <p>Сайты открываются только через туннель. Пока он не подключён, у браузера нет доступа в интернет.</p>
          </>
        )}
        {tunnel.status === 'error' && tunnel.message && <p className="error-text">{tunnel.message}</p>}
        {!connecting &&
          (selected ? (
            <div className="lock-actions">
              <button className="btn primary big" onClick={() => run(() => api.tunnel.connect(selected.id))}>
                Подключить
              </button>
              <button className="btn ghost" onClick={openServers}>
                {selected.name} · сменить
              </button>
            </div>
          ) : (
            <button className="btn primary big" onClick={openServers}>
              Добавить сервер
            </button>
          ))}
        {connecting && (
          <button className="btn ghost" onClick={() => run(() => api.tunnel.disconnect())}>
            Отмена
          </button>
        )}
      </div>
    </div>
  );
}

function StartPage({ tab, tunnel, run }: { tab: TabInfo; tunnel: TunnelState; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [q, setQ] = useState('');
  return (
    <div className="center">
      <div className="start">
        <div className="start-badge">
          <I.Shield size={18} />
          <span>
            Защищено туннелем{tunnel.exit ? ` · ${flag(tunnel.exit.country)} ${tunnel.exit.ip} · ${tunnel.exit.latencyMs} мс` : ''}
          </span>
        </div>
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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- servers

function ServersPanel(props: {
  profiles: ProfilesState;
  tunnel: TunnelState;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const { profiles, tunnel, run, onClose } = props;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const isUp = tunnel.status === 'connected' || tunnel.status === 'degraded';

  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setResult(null);
    try {
      const r = /^https?:\/\//i.test(t) && !t.includes('\n') ? await api.profiles.addSubscription(t) : await api.profiles.importText(t);
      setText('');
      const errs = r.errors.length ? `\nНе добавлено: ${r.errors.length}\n${r.errors.slice(0, 5).join('\n')}` : '';
      setResult(`Добавлено серверов: ${r.added}${errs}`);
    } catch (e) {
      setResult(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const groups: Array<{ id: string | null; title: string }> = [
    { id: null, title: 'Мои серверы' },
    ...profiles.subscriptions.map((s) => ({ id: s.id, title: s.title })),
  ];

  return (
    <aside className="panel">
      <header>
        <h3>Серверы</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <I.Close />
        </button>
      </header>
      <div className="panel-body">
        <div className="add-box">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Вставьте ссылку vless://, vmess://, trojan://, ss:// или ссылку на подписку https://…"
            rows={3}
            spellCheck={false}
          />
          <button className="btn primary" disabled={busy || !text.trim()} onClick={add}>
            {busy ? 'Загружаем…' : 'Добавить'}
          </button>
          {result && <pre className="result">{result}</pre>}
        </div>

        {groups.map((g) => {
          const list = profiles.profiles.filter((p) => (p.subscriptionId ?? null) === g.id);
          const sub = g.id ? profiles.subscriptions.find((s) => s.id === g.id) : undefined;
          if (!sub && !list.length) return null;
          return (
            <section key={g.id ?? 'own'} className="group">
              <div className="group-head">
                <div>
                  <div className="group-title">{g.title}</div>
                  {sub && <div className="muted small">{usageLine(sub)}</div>}
                  {sub?.lastError && <div className="error-text small">{sub.lastError}</div>}
                </div>
                {sub && (
                  <div className="row-actions">
                    <button className="icon-btn" title="Обновить подписку" onClick={() => run(() => api.profiles.refreshSubscription(sub.id))}>
                      <I.Reload size={14} />
                    </button>
                    <button className="icon-btn" title="Удалить подписку" onClick={() => run(() => api.profiles.removeSubscription(sub.id))}>
                      <I.Trash size={14} />
                    </button>
                  </div>
                )}
              </div>
              {list.map((p) => {
                const current = tunnel.profileId === p.id && tunnel.status !== 'disconnected';
                return (
                  <div
                    key={p.id}
                    className={`server ${p.id === profiles.selectedId ? 'selected' : ''}`}
                    onClick={() => run(() => api.profiles.select(p.id))}
                    onDoubleClick={() => run(() => api.tunnel.connect(p.id))}
                  >
                    <span className={`dot ${current ? tunnel.status : ''}`} />
                    <div className="server-text">
                      <div className="server-name">{p.name}</div>
                      <div className="muted small">{profileLine(p)}</div>
                    </div>
                    {!p.subscriptionId && (
                      <button
                        className="icon-btn row-del"
                        title="Удалить"
                        onClick={(e) => {
                          e.stopPropagation();
                          void run(() => api.profiles.remove(p.id));
                        }}
                      >
                        <I.Trash size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </section>
          );
        })}
        {!profiles.profiles.length && <p className="muted">Серверов пока нет. Вставьте ссылку от вашего VPN-провайдера.</p>}
      </div>
      <footer>
        {isUp || tunnel.status === 'connecting' ? (
          <button className="btn danger wide" onClick={() => run(() => api.tunnel.disconnect())}>
            Отключить
          </button>
        ) : (
          <button className="btn primary wide" disabled={!profiles.selectedId} onClick={() => run(() => api.tunnel.connect(profiles.selectedId))}>
            Подключить
          </button>
        )}
        {isUp && tunnel.profileId !== profiles.selectedId && profiles.selectedId && (
          <button className="btn wide" onClick={() => run(() => api.tunnel.connect(profiles.selectedId))}>
            Переключиться на выбранный
          </button>
        )}
      </footer>
    </aside>
  );
}

// ---------------------------------------------------------------- settings

function SettingsPanel({ update, run, onClose }: { update: UpdateState; run: (fn: () => Promise<unknown>) => Promise<void>; onClose: () => void }) {
  const [info, setInfo] = useState<{ version: string; platform: string; xrayVersion: string; repo: string } | null>(null);
  const [history, setHistory] = useState<ReleaseEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    void api.app.info().then(setInfo);
    api.updates
      .history()
      .then(setHistory)
      .catch((e) => setHistoryError(errText(e)));
  }, []);

  const statusText: Record<UpdateState['status'], string> = {
    idle: 'Ещё не проверяли',
    checking: 'Проверяем…',
    available: `Доступна версия ${update.version}`,
    'not-available': 'У вас последняя версия',
    downloading: `Скачиваем… ${update.percent ?? 0}%`,
    installing: 'Устанавливаем…',
    error: update.message ?? 'Ошибка',
    disabled: update.message ?? 'Недоступно',
  };

  return (
    <aside className="panel">
      <header>
        <h3>Настройки</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <I.Close />
        </button>
      </header>
      <div className="panel-body">
        <section className="group">
          <div className="group-title">Обновления</div>
          <p>
            Версия <b>{info?.version ?? update.currentVersion}</b> · ядро Xray {info?.xrayVersion ?? '…'}
          </p>
          <p className="muted small">{statusText[update.status]}</p>
          <div className="row-actions">
            {update.status === 'available' || (update.status === 'error' && update.version) ? (
              <button className="btn primary" onClick={() => run(() => api.updates.install())}>
                Обновить до {update.version}
              </button>
            ) : (
              <button className="btn" disabled={update.status === 'disabled' || update.status === 'checking'} onClick={() => run(() => api.updates.check())}>
                Проверить обновления
              </button>
            )}
          </div>
        </section>

        <section className="group">
          <div className="group-title">История версий</div>
          {historyError && <p className="error-text small">{historyError}</p>}
          {!info?.repo && <p className="muted small">Репозиторий GitHub не задан в этой сборке.</p>}
          {history?.length === 0 && info?.repo && <p className="muted small">Релизов пока нет.</p>}
          {history?.map((r) => (
            <details key={r.version} className="release">
              <summary>
                <b>{r.version}</b>
                <span className="muted small">{r.date ? new Date(r.date).toLocaleDateString('ru-RU') : ''}</span>
                {r.version === info?.version && <span className="tag">текущая</span>}
              </summary>
              <pre className="notes">{r.notes || 'Без описания'}</pre>
            </details>
          ))}
        </section>

        <section className="group">
          <div className="group-title">Данные браузера</div>
          <p className="muted small">Куки, кэш и сохранённые входы на сайты. Серверы не удаляются.</p>
          <button
            className="btn"
            onClick={() =>
              run(async () => {
                await api.app.clearBrowsingData();
                setCleared(true);
              })
            }
          >
            {cleared ? 'Очищено' : 'Очистить данные сайтов'}
          </button>
        </section>

        <section className="group">
          <div className="group-title">Как работает защита</div>
          <ul className="muted small explain">
            <li>Единственный сетевой маршрут браузера — локальный вход Xray с одноразовым паролем. Прямого выхода в интернет нет.</li>
            <li>Каждый запрос проверяется: пока туннель не подтверждён настоящим запросом через сервер, всё блокируется.</li>
            <li>Если ядро падает или вы отключаетесь, браузер блокируется до любых других действий.</li>
            <li>WebRTC не может слать UDP мимо туннеля; геолокация, камера, микрофон и устройства запрещены.</li>
            <li>Локальная сеть и этот компьютер (localhost, 192.168.x.x и т. п.) из браузера недоступны.</li>
          </ul>
        </section>
        {info && <p className="muted small">{info.platform}{info.repo ? ` · github.com/${info.repo}` : ''}</p>}
        <p className="muted small">Ядро Xray — MPL-2.0. Флаги стран — Twemoji, CC-BY 4.0.</p>
      </div>
    </aside>
  );
}
