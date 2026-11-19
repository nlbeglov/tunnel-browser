// The settings page, laid out like Chrome's: sections on the left, rows in cards on the
// right, search on top. It is a tab of its own in the strip, "Настройки", with no address:
// while it is in front, the page of the selected tab is only hidden (App.tsx). Rows marked
// "только «…»" belong to this window's profile; the rest is shared by all windows.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { BrowserSettings, ProfilesState, ReleaseEntry, TunnelState, UpdateState, WindowProfileInfo, WindowProfilesState } from '../shared/types';
import { api, errText, useBridge, type Run } from './bridge';
import { flag, ipText, profileLine, usageLine } from './format';
import * as I from './icons';
import { Card, Query, Row, Scope, Switch, useMatch } from './settingsKit';
import { ProfileBadge, ProfilesSection } from './windows';

export type SettingsSection = 'connection' | 'profiles' | 'privacy' | 'appearance' | 'about';

const SECTIONS: Array<{ id: SettingsSection; title: string; icon: ReactNode }> = [
  { id: 'connection', title: 'Подключение', icon: <I.Shield size={18} /> },
  { id: 'profiles', title: 'Окна и профили', icon: <I.Windows size={18} /> },
  { id: 'privacy', title: 'Конфиденциальность и защита', icon: <I.Lock size={18} /> },
  { id: 'appearance', title: 'Внешний вид и запуск', icon: <I.Layout size={18} /> },
  { id: 'about', title: 'О Tunnel Browser', icon: <I.Info size={18} /> },
];

interface Props {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  tunnel: TunnelState;
  servers: ProfilesState;
  windows: WindowProfilesState;
  update: UpdateState;
  run: Run;
}

export function SettingsView(props: Props) {
  const { section, onSection } = props;
  const [query, setQuery] = useState('');
  const [nothing, setNothing] = useState(false);
  const main = useRef<HTMLDivElement>(null);
  const me = props.windows.profiles.find((p) => p.current);
  const q = query.trim().toLowerCase();

  // Braces matter: scrollTo() returns a promise in current Chromium, and an effect may only
  // return its cleanup.
  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [section]);
  // Search hides rows; say so when none is left.
  useLayoutEffect(() => {
    setNothing(!!q && !main.current?.querySelector('.s-row:not([hidden])'));
  });

  const shown = q ? SECTIONS : SECTIONS.filter((s) => s.id === section);
  return (
    <div className={`settings ${q ? 'searching' : ''}`}>
      <nav className="s-nav" aria-label="Разделы настроек">
        <div className="s-nav-head">
          <h1>Настройки</h1>
          {me && <ProfileBadge p={me} />}
        </div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`s-nav-item ${!q && s.id === section ? 'active' : ''}`}
            aria-current={!q && s.id === section ? 'page' : undefined}
            title={s.title}
            onClick={() => {
              setQuery('');
              onSection(s.id);
            }}
          >
            {s.icon}
            <span>{s.title}</span>
          </button>
        ))}
      </nav>
      <div className="s-main" ref={main}>
        <div className="s-top">
          <label className="s-search">
            <I.Search size={16} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск настроек" aria-label="Поиск настроек" spellCheck={false} />
          </label>
        </div>
        <Query.Provider value={q}>
          {shown.map((s) => (
            <div className="s-section" key={s.id}>
              <h2>{s.title}</h2>
              {s.id === 'connection' && <ConnectionSection {...props} me={me} />}
              {s.id === 'profiles' && <ProfilesSection state={props.windows} servers={props.servers} run={props.run} />}
              {s.id === 'privacy' && <PrivacySection me={me} run={props.run} />}
              {s.id === 'appearance' && <AppearanceSection run={props.run} />}
              {s.id === 'about' && <AboutSection update={props.update} run={props.run} />}
            </div>
          ))}
        </Query.Provider>
        {nothing && <p className="s-empty">Нет настроек, где встречается «{query.trim()}».</p>}
      </div>
    </div>
  );
}

/** The ping and a button to measure it again (also on the start page). */
export function Ping({ tunnel, run }: { tunnel: TunnelState; run: Run }) {
  const [busy, setBusy] = useState(false);
  const ms = tunnel.exit?.latencyMs;
  return (
    <span className="ping">
      <span title="Время ответа через VPN: от вас до сервера, оттуда до сайта и обратно">{ms ? `${ms} мс` : '—'}</span>
      <button
        className={`icon-btn ping-btn ${busy ? 'busy' : ''}`}
        aria-label="Измерить пинг заново"
        title="Измерить пинг заново"
        disabled={busy || tunnel.status !== 'connected'}
        onClick={() => {
          setBusy(true);
          void run(() => api.tunnel.measure()).finally(() => setBusy(false));
        }}
      >
        <I.Reload size={12} />
      </button>
    </span>
  );
}

function ConnectionSection(props: Props & { me: WindowProfileInfo | undefined }) {
  const { tunnel, servers, run, me } = props;
  const selected = servers.profiles.find((p) => p.id === servers.selectedId);
  const up = tunnel.status === 'connected' || tunnel.status === 'degraded';
  const connecting = tunnel.status === 'connecting';
  const statusText = {
    connected: 'Подключено',
    degraded: 'Сервер не отвечает',
    connecting: 'Подключаемся…',
    error: 'Ошибка',
    disconnected: 'Не подключено',
  }[tunnel.status];

  return (
    <>
      <Card title="Этот профиль" scope={<Scope me={me} />}>
        <Row
          title={selected ? selected.name : me?.serverMissing ? `Сервера «${me.serverName}» больше нет` : 'Сервер не выбран'}
          desc={
            selected
              ? `${profileLine(selected)}. ${statusText}`
              : me?.serverMissing
                ? 'Провайдер убрал его из подписки или он был удалён. Выберите другой сервер ниже.'
                : 'Выберите сервер в списке ниже: через него будет работать это окно.'
          }
          search="сервер подключение подключить отключить"
        >
          {up || connecting ? (
            <button className="btn" onClick={() => run(() => api.tunnel.disconnect())}>
              {connecting ? 'Отмена' : 'Отключить'}
            </button>
          ) : (
            <button className="btn primary" disabled={!selected} onClick={() => run(() => api.tunnel.connect())}>
              Подключить
            </button>
          )}
        </Row>
        {tunnel.status === 'error' && tunnel.message && <Row title="Не удалось подключиться" desc={tunnel.message} />}
        {up && tunnel.exit && (
          <Row
            title="Адрес для сайтов"
            desc={
              tunnel.exit.ipError
                ? `${ipText(tunnel.exit.ip)}. Туннель работает, но сервисы, по которым узнаётся IP, не ответили: ${tunnel.exit.ipError}`
                : `${flag(tunnel.exit.country)} ${tunnel.exit.ip}`
            }
            search="ip адрес пинг задержка"
          >
            <Ping tunnel={tunnel} run={run} />
          </Row>
        )}
        {up && tunnel.exit?.timezone && (
          <Row
            title="Часовой пояс и язык для сайтов"
            desc={`${tunnel.exit.timezone}, английский (США). Так сайты не отличат вас от жителя страны сервера.`}
            search="часовой пояс язык"
          />
        )}
      </Card>
      <ServerList servers={servers} tunnel={tunnel} run={run} />
      <AddServers />
    </>
  );
}

function ServerList({ servers, tunnel, run }: { servers: ProfilesState; tunnel: TunnelState; run: Run }) {
  const groups: Array<{ id: string | null; title: string }> = [
    { id: null, title: 'Мои серверы' },
    ...servers.subscriptions.map((s) => ({ id: s.id, title: s.title })),
  ];
  return (
    <Card title="Серверы" className="servers-card">
      <p className="s-note">
        Общий список для всех окон. Выбранный сервер отмечен; нажмите на другой, чтобы перевести на него это окно (приложение
        переспросит), двойной щелчок — подключиться.
      </p>
      {servers.profiles.length === 0 && <Row title="Серверов пока нет" desc="Вставьте ссылку от вашего VPN-провайдера ниже." search="сервер" />}
      {groups.map((g) => {
        const list = servers.profiles.filter((p) => (p.subscriptionId ?? null) === g.id);
        const sub = g.id ? servers.subscriptions.find((s) => s.id === g.id) : undefined;
        if (!sub && !list.length) return null;
        return (
          <div className="server-group" key={g.id ?? 'own'}>
            <div className="server-group-head">
              <div className="s-text">
                <div className="s-title">{g.title}</div>
                {sub && <div className="s-desc">{usageLine(sub)}</div>}
                {sub?.lastError && <div className="s-desc error-text">{sub.lastError}</div>}
              </div>
              {sub && (
                <div className="s-control">
                  <button className="icon-btn" aria-label={`Обновить подписку «${sub.title}»`} title="Обновить подписку" onClick={() => run(() => api.profiles.refreshSubscription(sub.id))}>
                    <I.Reload size={14} />
                  </button>
                  <button className="icon-btn" aria-label={`Удалить подписку «${sub.title}»`} title="Удалить подписку" onClick={() => run(() => api.profiles.removeSubscription(sub.id))}>
                    <I.Trash size={14} />
                  </button>
                </div>
              )}
            </div>
            {list.map((p) => (
              <ServerRow key={p.id} p={p} picked={p.id === servers.selectedId} live={tunnel.profileId === p.id && tunnel.status !== 'disconnected' ? tunnel.status : undefined} run={run} />
            ))}
          </div>
        );
      })}
    </Card>
  );
}

function ServerRow(props: { p: ProfilesState['profiles'][number]; picked: boolean; live?: TunnelState['status']; run: Run }) {
  const { p, picked, live, run } = props;
  const visible = useMatch(p.name, profileLine(p), p.address);
  return (
    <div className={`s-row server-row ${picked ? 'picked' : ''}`} hidden={!visible} onDoubleClick={() => run(() => api.tunnel.connect(p.id))}>
      <button className="server-pick" role="radio" aria-checked={picked} onClick={() => run(() => api.profiles.select(p.id))}>
        <span className="radio" aria-hidden="true" />
        <span className="s-text">
          <span className="s-title">{p.name}</span>
          <span className="s-desc">{profileLine(p)}</span>
        </span>
      </button>
      {live && <span className={`dot ${live}`} title="Это окно подключено через этот сервер" />}
      {!p.subscriptionId && (
        <button className="icon-btn" aria-label={`Удалить сервер «${p.name}»`} title="Удалить" onClick={() => run(() => api.profiles.remove(p.id))}>
          <I.Trash size={14} />
        </button>
      )}
    </div>
  );
}

function AddServers() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const visible = useMatch('Добавить сервер или подписку', 'ссылка vless vmess trojan ss подписка');
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
  return (
    <Card title="Добавить сервер или подписку">
      <div className="s-row add-row" hidden={!visible}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ссылка vless://, vmess://, trojan://, ss:// или ссылка на подписку https://… Можно несколько, по одной на строку."
          aria-label="Ссылки на серверы или подписку"
          rows={3}
          spellCheck={false}
        />
        <div className="add-actions">
          {result && <pre className="result">{result}</pre>}
          <button className="btn primary" disabled={busy || !text.trim()} onClick={add}>
            {busy ? 'Добавляем…' : 'Добавить'}
          </button>
        </div>
      </div>
    </Card>
  );
}

function useSettings(): [BrowserSettings | null, (patch: Partial<BrowserSettings>) => void] {
  const s = useBridge<BrowserSettings | null>(null, api.app.settings, api.app.onSettingsChange);
  return [s, (patch) => void api.app.setSettings(patch)];
}

function PrivacySection({ me, run }: { me: WindowProfileInfo | undefined; run: Run }) {
  const [settings, set] = useSettings();
  const [cleared, setCleared] = useState(false);
  return (
    <>
      <Card title="Куки и данные сайтов">
        {settings && (
          <Row
            title="Спрашивать, если сменился IP"
            desc="Сайты, где вы вошли, могут связать новый IP со старым по куки. Перед тем как сайты увидят новый адрес, приложение предложит очистить их данные."
            search="куки ip смена сервера предупреждение"
          >
            <Switch label="Спрашивать, если сменился IP" checked={settings.warnOnServerSwitch} onChange={(v) => set({ warnOnServerSwitch: v })} />
          </Row>
        )}
        <Row
          title={
            <>
              Данные сайтов
              <Scope me={me} />
            </>
          }
          desc="Куки, кэш и сохранённые входы на сайты в этом окне. Другие профили и серверы не затрагиваются; открытые вкладки загрузятся заново."
          search="данные сайтов куки кэш очистить входы"
        >
          <button
            className="btn"
            disabled={cleared}
            onClick={() =>
              run(async () => {
                await api.app.clearBrowsingData();
                setCleared(true);
              })
            }
          >
            {cleared ? 'Очищено' : 'Очистить'}
          </button>
        </Row>
      </Card>
      <Card title="Как работает защита">
        <Row title="Единственный путь в интернет — через VPN" desc="Локальный вход Xray с одноразовым паролем. Прямого выхода нет; пока туннель не подтверждён, всё блокируется." />
        <Row title="Нет утечки DNS" desc="Имена сайтов разрешает VPN-сервер: браузер не делает DNS-запросов через вашего провайдера." />
        <Row title="Часовой пояс и язык как в стране сервера" desc="Сайты видят часовой пояс страны сервера и английский язык. Страница, для которой это не включилось, не может ничего отправить." />
        <Row title="WebRTC, геолокация, камера и микрофон" desc="WebRTC не шлёт UDP мимо туннеля; доступ к местоположению, камере, микрофону и устройствам запрещён." />
        <Row title="Локальная сеть недоступна" desc="Этот компьютер и устройства вашей сети (localhost, 192.168.x.x и т. п.) из браузера не открываются." />
      </Card>
    </>
  );
}

function AppearanceSection(_: { run: Run }) {
  const [settings, set] = useSettings();
  if (!settings) return null;
  return (
    <Card title="Запуск и вид">
      <Row title="Восстанавливать вкладки при запуске" desc="Страницы загрузятся, когда подключится VPN." search="вкладки запуск сессия">
        <Switch label="Восстанавливать вкладки при запуске" checked={settings.restoreTabs} onChange={(v) => set({ restoreTabs: v })} />
      </Row>
      <Row title="Показывать панель закладок" desc="Под адресной строкой. Ctrl/⌘+Shift+B" search="закладки панель">
        <Switch label="Показывать панель закладок" checked={settings.showBookmarksBar} onChange={(v) => set({ showBookmarksBar: v })} />
      </Row>
    </Card>
  );
}

function AboutSection({ update, run }: { update: UpdateState; run: Run }) {
  const [info, setInfo] = useState<{ version: string; platform: string; xrayVersion: string; repo: string } | null>(null);
  const [history, setHistory] = useState<ReleaseEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  useEffect(() => {
    void api.app.info().then(setInfo);
    api.updates
      .history()
      .then(setHistory)
      .catch((e) => setHistoryError(errText(e)));
  }, []);

  const status: Record<UpdateState['status'], string> = {
    idle: 'Обновления ещё не проверялись',
    checking: 'Проверяем обновления…',
    available: `Доступна версия ${update.version}`,
    'not-available': 'У вас последняя версия',
    downloading: `Скачиваем обновление… ${update.percent ?? 0}%`,
    installing: 'Устанавливаем обновление…',
    error: update.message ?? 'Ошибка',
    disabled: update.message ?? 'Недоступно',
  };
  const canInstall = update.status === 'available' || (update.status === 'error' && !!update.version);

  return (
    <>
      <Card title="Версия">
        <Row title={`Tunnel Browser ${info?.version ?? update.currentVersion}`} desc={status[update.status]} search="версия обновление обновить">
          {canInstall ? (
            <button className="btn primary" onClick={() => run(() => api.updates.install())}>
              Обновить до {update.version}
            </button>
          ) : (
            <button className="btn" disabled={update.status === 'disabled' || update.status === 'checking'} onClick={() => run(() => api.updates.check())}>
              Проверить обновления
            </button>
          )}
        </Row>
        <Row title="Ядро Xray" desc={info?.xrayVersion ?? '…'} search="xray ядро" />
        {info && <Row title="Система" desc={info.platform} />}
      </Card>
      <Card title="История версий">
        {historyError && <Row title="Не удалось загрузить историю" desc={historyError} />}
        {!info?.repo && <Row title="Репозиторий GitHub не задан в этой сборке" />}
        {history?.length === 0 && info?.repo && <Row title="Релизов пока нет" />}
        {history?.map((r) => (
          <ReleaseRow key={r.version} r={r} current={r.version === info?.version} />
        ))}
      </Card>
      <Card title="Лицензии">
        <Row title="Ядро Xray" desc="MPL-2.0" search="лицензия" />
        <Row title="Флаги стран" desc="Twemoji, CC-BY 4.0" search="лицензия" />
      </Card>
    </>
  );
}

function ReleaseRow({ r, current }: { r: ReleaseEntry; current: boolean }) {
  const visible = useMatch(r.version, r.notes);
  return (
    <details className="s-row release" hidden={!visible}>
      <summary>
        <span className="s-title">{r.version}</span>
        {current && <span className="tag">текущая</span>}
        <span className="s-desc">{r.date ? new Date(r.date).toLocaleDateString('ru-RU') : ''}</span>
      </summary>
      <pre className="notes">{r.notes || 'Без описания'}</pre>
    </details>
  );
}
