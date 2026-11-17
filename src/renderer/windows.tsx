// Window profiles in the UI: the profile's colour on the window (tab strip, its badge, the
// window buttons, the taskbar icon) and the panel that opens, creates and edits profiles.

import { useEffect, useLayoutEffect, useState } from 'react';
import type { ProfilesState, TunnelState, WindowProfileInfo, WindowProfilesState } from '../shared/types';
import { api, type Run } from './bridge';
import { flag } from './format';
import * as I from './icons';

const isMac = api.app.platform === 'darwin';

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(c: number[]): string {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** `a` over `b` at `t`: the tinted tab strip. */
function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((v, i) => v * t + y[i] * (1 - t)));
}

/** Text on the profile colour: dark on light colours, white on dark ones. */
export function inkOn(hex: string): 'dark' | 'light' {
  const lin = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2] > 0.3 ? 'dark' : 'light';
}

/**
 * The window wears its profile: tab strip tinted with the profile colour (variables on the
 * root), the window buttons drawn over the strip in the same colours (Windows), the
 * profile's colour and exit flag over the taskbar icon (Windows).
 */
export function useProfileChrome(me: WindowProfileInfo | undefined, tunnel: TunnelState) {
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    const bg = css.getPropertyValue('--bg').trim() || (dark ? '#15171c' : '#eef0f4');
    const text = css.getPropertyValue('--text').trim() || (dark ? '#e8eaee' : '#1b1e24');
    const strip = me ? mix(me.color, bg, dark ? 0.3 : 0.24) : bg;
    root.style.setProperty('--strip', strip);
    if (me) root.style.setProperty('--profile', me.color);
    if (!isMac) api.app.setTitleBarColors({ color: strip, symbolColor: text });
  }, [me?.color, dark]);

  const country = tunnel.status === 'connected' || tunnel.status === 'degraded' ? tunnel.exit?.country : undefined;
  useEffect(() => {
    if (isMac || !me) return;
    let live = true;
    void taskbarBadge(me.color, country).then((png) => {
      if (live) api.app.setTaskbarBadge(png, country ? `${me.name}, ${country}` : me.name);
    });
    return () => {
      live = false;
    };
  }, [me?.color, me?.name, country]);
}

/** 32×32 PNG: the flag in a frame of the profile colour, or a plain dot before connecting. */
async function taskbarBadge(color: string, country?: string): Promise<string> {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d')!;
  const round = (x: number, y: number, w: number, h: number, r: number) => {
    g.beginPath();
    g.roundRect(x, y, w, h, r);
  };
  const emoji = country ? flag(country) : '';
  if (!emoji) {
    g.fillStyle = color;
    g.beginPath();
    g.arc(16, 16, 12, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = '#ffffff';
    g.stroke();
    return c.toDataURL('image/png');
  }
  await document.fonts.load('26px "Twemoji Country Flags"', emoji).catch(() => []);
  round(0, 4, 32, 24, 6);
  g.fillStyle = color;
  g.fill();
  g.save();
  round(3, 7, 26, 18, 3);
  g.clip();
  g.font = '26px "Twemoji Country Flags", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(emoji, 16, 17);
  g.restore();
  return c.toDataURL('image/png');
}

/** The profile's name and exit flag at the start of the tab strip: opens the profiles panel. */
export function ProfileChip({ me, tunnel, onClick }: { me: WindowProfileInfo | undefined; tunnel: TunnelState; onClick: () => void }) {
  if (!me) return null;
  const up = tunnel.status === 'connected' || tunnel.status === 'degraded';
  return (
    <button className={`profile-chip ink-${inkOn(me.color)}`} onClick={onClick} title={`Профиль окна «${me.name}». Другие окна и профили: Ctrl/⌘+N`}>
      {up && tunnel.exit?.country ? <span className="chip-flag">{flag(tunnel.exit.country)}</span> : <span className="chip-dot" aria-hidden="true" />}
      <span className="chip-name">{me.name}</span>
    </button>
  );
}

function Avatar({ p, size = 36 }: { p: { name: string; color: string }; size?: number }) {
  return (
    <span
      className={`avatar ink-${inkOn(p.color)}`}
      aria-hidden="true"
      ref={(el) => {
        el?.style.setProperty('--c', p.color);
        el?.style.setProperty('--size', `${size}px`);
      }}
    >
      {(p.name[0] ?? '•').toUpperCase()}
    </span>
  );
}

function Swatches(props: { colors: string[]; value: string; onPick: (c: string) => void; label: string }) {
  return (
    <fieldset className="swatches">
      <legend className="muted small">{props.label}</legend>
      <div className="swatch-row">
        {props.colors.map((c) => (
          <label
            key={c}
            className={`swatch ${props.value === c ? 'picked' : ''}`}
            ref={(el) => el?.style.setProperty('--c', c)}
            title={c}
          >
            <input type="radio" name={props.label} checked={props.value === c} onChange={() => props.onPick(c)} aria-label={`Цвет ${c}`} />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ProfileRow({ p, state, run }: { p: WindowProfileInfo; state: WindowProfilesState; run: Run }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [color, setColor] = useState(p.color);
  useEffect(() => {
    setName(p.name);
    setColor(p.color);
  }, [p.name, p.color]);

  return (
    <div className={`profile-row ${p.current ? 'current' : ''}`}>
      <div className="profile-main">
        <Avatar p={p} />
        <div className="profile-text">
          <div className="profile-name">
            {p.name}
            {p.current && <span className="tag">это окно</span>}
          </div>
          <div className="muted small">
            {[p.serverName, p.exit ? `${flag(p.exit.country)} ${p.exit.ip}${p.exit.live ? '' : ' (в прошлый раз)'}` : undefined]
              .filter(Boolean)
              .join(' · ') || 'Сервер ещё не выбран'}
          </div>
        </div>
        {!p.current &&
          (p.open ? (
            <button className="btn small" onClick={() => run(() => api.windows.open(p.id))}>
              Перейти к окну
            </button>
          ) : (
            <button className="btn small primary" onClick={() => run(() => api.windows.open(p.id))}>
              Открыть окно
            </button>
          ))}
        <button className="icon-btn" aria-label={`Изменить профиль «${p.name}»`} onClick={() => setEditing(!editing)}>
          <I.Edit size={14} />
        </button>
      </div>
      {editing && (
        <div className="profile-edit">
          <label className="field">
            <span className="muted small">Название</span>
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <Swatches label={`Цвет профиля ${p.id}`} colors={[p.color, ...state.freeColors]} value={color} onPick={setColor} />
          <div className="row-actions">
            <button
              className="btn small primary"
              onClick={() =>
                run(async () => {
                  await api.windows.update(p.id, { name, color });
                  setEditing(false);
                })
              }
            >
              Сохранить
            </button>
            {!p.open && state.profiles.length > 1 && (
              <button className="btn small danger" onClick={() => run(() => api.windows.remove(p.id))}>
                Удалить профиль
              </button>
            )}
          </div>
          {p.open && !p.current && <p className="muted small">Чтобы удалить профиль, сначала закройте его окно.</p>}
        </div>
      )}
    </div>
  );
}

/** Ctrl/Cmd+N or the profile badge: the windows and their profiles. */
export function ProfilesPanel(props: { state: WindowProfilesState; servers: ProfilesState; run: Run; onClose: () => void }) {
  const { state, servers, run, onClose } = props;
  const [name, setName] = useState('');
  const [color, setColor] = useState(state.freeColors[0] ?? '');
  const [serverId, setServerId] = useState(servers.selectedId ?? servers.profiles[0]?.id ?? '');
  useEffect(() => {
    if (!state.freeColors.includes(color)) setColor(state.freeColors[0] ?? '');
  }, [state.freeColors.join()]);

  return (
    <aside className="panel">
      <header>
        <h3>Окна и профили</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <I.Close />
        </button>
      </header>
      <div className="panel-body">
        <p className="muted small">
          У каждого профиля своё окно, свой сервер и IP, свои куки, входы, закладки и часовой пояс. Сайты не видят, что
          это один человек.
        </p>
        <section className="group">
          {state.profiles.map((p) => (
            <ProfileRow key={p.id} p={p} state={state} run={run} />
          ))}
        </section>

        <section className="group new-profile">
          <div className="group-title">Новый профиль</div>
          {state.freeColors.length === 0 ? (
            <p className="muted small">Все цвета заняты: чтобы окна не путались, у каждого профиля свой цвет.</p>
          ) : (
            <>
              <label className="field">
                <span className="muted small">Название</span>
                <input value={name} maxLength={40} placeholder="Например, Работа" onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                <span className="muted small">Сервер</span>
                <select value={serverId} onChange={(e) => setServerId(e.target.value)}>
                  {servers.profiles.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <Swatches label="Цвет окна" colors={state.freeColors} value={color} onPick={setColor} />
              <button
                className="btn primary wide"
                disabled={!name.trim() || !color}
                onClick={() =>
                  run(async () => {
                    await api.windows.create({ name, color, serverId: serverId || undefined });
                    setName('');
                  })
                }
              >
                Создать и открыть окно
              </button>
              <p className="muted small">Цвета, которые уже у других профилей, не предлагаются: два окна одного цвета перепутать проще всего.</p>
            </>
          )}
        </section>
      </div>
    </aside>
  );
}
