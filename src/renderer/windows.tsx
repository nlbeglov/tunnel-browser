// Window profiles in the UI: the profile's colour on the window (tab strip, its badge, the
// window buttons, the taskbar icon) and the panel that opens, creates and edits profiles.

import { useEffect, useLayoutEffect, useState } from 'react';
import type { ProfilesState, TunnelState, WindowProfileInfo, WindowProfilesState } from '../shared/types';
import { api, type Run } from './bridge';
import { Card, useMatch } from './settingsKit';
import { flag, ipText } from './format';
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

/**
 * A profile as the tab strip shows it: its colour, the flag of its exit (the live one, or the
 * one sites saw last) and its name. This is the only picture a profile has.
 */
export function ProfileBadge({ p }: { p: WindowProfileInfo }) {
  return (
    <span className={`profile-chip static ink-${inkOn(p.color)}`} ref={(el) => el?.style.setProperty('--profile', p.color)}>
      {p.exit?.country ? <span className="chip-flag">{flag(p.exit.country)}</span> : <span className="chip-dot" aria-hidden="true" />}
      <span className="chip-name">{p.name}</span>
    </span>
  );
}

function Swatches(props: { colors: string[]; value: string; onPick: (c: string) => void; label: string }) {
  return (
    <fieldset className="swatches">
      <legend className="s-desc">{props.label}</legend>
      <div className="swatch-row">
        {props.colors.map((c) => (
          <label key={c} className={`swatch ${props.value === c ? 'picked' : ''}`} ref={(el) => el?.style.setProperty('--c', c)} title={c}>
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
  const visible = useMatch(p.name, p.serverName, p.exit?.ip);
  const where = p.serverMissing
    ? `Сервера «${p.serverName}» больше нет в подписках`
    : p.serverName
      ? `${p.serverName}${p.exit ? `, ${p.exit.live ? 'сейчас' : 'в прошлый раз'} ${ipText(p.exit.ip)}` : ''}`
      : 'Сервер ещё не выбран';

  return (
    <div className="s-row profile-row" hidden={!visible}>
      <div className="profile-main">
        <ProfileBadge p={p} />
        <div className="s-text">
          <div className="s-desc">{where}</div>
        </div>
        {p.current ? (
          <span className="s-desc">Это окно</span>
        ) : p.open ? (
          <button className="btn small" onClick={() => run(() => api.windows.open(p.id))}>
            Перейти к окну
          </button>
        ) : (
          <button className="btn small primary" onClick={() => run(() => api.windows.open(p.id))}>
            Открыть окно
          </button>
        )}
        <button className="icon-btn" aria-label={`Изменить профиль «${p.name}»`} aria-expanded={editing} onClick={() => setEditing(!editing)}>
          <I.Edit size={14} />
        </button>
      </div>
      {editing && (
        <div className="profile-edit">
          <label className="field">
            <span className="s-desc">Название</span>
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <Swatches label={`Цвет окна «${p.name}»`} colors={[p.color, ...state.freeColors]} value={color} onPick={setColor} />
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
          {p.open && !p.current && <p className="s-desc">Чтобы удалить профиль, сначала закройте его окно.</p>}
        </div>
      )}
    </div>
  );
}

/** Settings › Windows and profiles (also Ctrl/Cmd+N and the badge in the tab strip). */
export function ProfilesSection(props: { state: WindowProfilesState; servers: ProfilesState; run: Run }) {
  const { state, servers, run } = props;
  const [name, setName] = useState('');
  const [color, setColor] = useState(state.freeColors[0] ?? '');
  const [serverId, setServerId] = useState(servers.selectedId ?? servers.profiles[0]?.id ?? '');
  useEffect(() => {
    if (!state.freeColors.includes(color)) setColor(state.freeColors[0] ?? '');
  }, [state.freeColors.join()]);
  const newVisible = useMatch('Новый профиль', 'новое окно', 'создать');

  return (
    <>
      <Card title="Окна">
        <p className="s-note">
          У каждого профиля своё окно, свой сервер и IP, свои куки, входы, закладки и часовой пояс. Сайты не видят, что это
          один человек.
        </p>
        {state.profiles.map((p) => (
          <ProfileRow key={p.id} p={p} state={state} run={run} />
        ))}
      </Card>
      <Card title="Новый профиль">
        <div className="s-row new-profile" hidden={!newVisible}>
          {state.freeColors.length === 0 ? (
            <p className="s-desc">Все цвета заняты: чтобы окна не путались, у каждого профиля свой цвет.</p>
          ) : (
            <>
              <div className="new-profile-fields">
                <label className="field">
                  <span className="s-desc">Название</span>
                  <input value={name} maxLength={40} placeholder="Например, Работа" onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="field">
                  <span className="s-desc">Сервер</span>
                  <select value={serverId} onChange={(e) => setServerId(e.target.value)}>
                    {servers.profiles.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Swatches label="Цвет окна" colors={state.freeColors} value={color} onPick={setColor} />
              <div className="new-profile-actions">
                <span className="s-desc">Занятые цвета не предлагаются: два окна одного цвета перепутать проще всего.</span>
                <button
                  className="btn primary"
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
              </div>
            </>
          )}
        </div>
      </Card>
    </>
  );
}
