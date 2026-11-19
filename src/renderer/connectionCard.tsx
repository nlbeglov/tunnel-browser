// "Этот профиль": the window's server, its state, the address sites see with the ping, and the
// time and language they get. The same card is in Settings › Connection and in the panel under
// the IP in the toolbar (popup.tsx), so it takes its actions as callbacks.

import { useState, type ReactNode } from 'react';
import type { ServerProfile, TunnelState, WindowProfileInfo } from '../shared/types';
import { siteTime, useNow } from './clock';
import { flag, ipText, profileLine } from './format';
import * as I from './icons';
import { Card, Row } from './settingsKit';

export interface ConnectionActions {
  connect(): unknown;
  disconnect(): unknown;
  measure(): Promise<unknown>;
}

const STATUS: Record<TunnelState['status'], string> = {
  connected: 'Подключено',
  degraded: 'Сервер не отвечает',
  connecting: 'Подключаемся…',
  error: 'Ошибка',
  disconnected: 'Не подключено',
};

/** The ping and a button to measure it again. */
export function Ping({ tunnel, onMeasure }: { tunnel: TunnelState; onMeasure: () => Promise<unknown> }) {
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
          void Promise.resolve(onMeasure()).finally(() => setBusy(false));
        }}
      >
        <I.Reload size={12} />
      </button>
    </span>
  );
}

function ZoneRow({ zone }: { zone: string }) {
  const now = useNow();
  return (
    <Row
      title="Время и язык для сайтов"
      desc={`${siteTime(zone, now, true)}, английский (США)`}
      hint="Так сайты не отличат вас от жителя страны сервера: часы и язык браузера совпадают с его страной."
      search="часовой пояс время язык"
    />
  );
}

export function ConnectionCard(props: {
  tunnel: TunnelState;
  server: ServerProfile | undefined;
  me: Pick<WindowProfileInfo, 'serverName' | 'serverMissing'> | undefined;
  actions: ConnectionActions;
  scope?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const { tunnel, server, me, actions } = props;
  const up = tunnel.status === 'connected' || tunnel.status === 'degraded';
  const connecting = tunnel.status === 'connecting';
  return (
    <Card title="Этот профиль" scope={props.scope} className={props.className}>
      <Row
        title={server ? server.name : me?.serverMissing ? `Сервера «${me.serverName}» больше нет` : 'Сервер не выбран'}
        desc={
          server
            ? `${profileLine(server)}. ${STATUS[tunnel.status]}`
            : me?.serverMissing
              ? 'Провайдер убрал его из подписки или он был удалён.'
              : 'Выберите сервер, через который будет работать это окно.'
        }
        search="сервер подключение подключить отключить"
      >
        {up || connecting ? (
          <button className="btn" onClick={() => actions.disconnect()}>
            {connecting ? 'Отмена' : 'Отключить'}
          </button>
        ) : (
          <button className="btn primary" disabled={!server} onClick={() => actions.connect()}>
            Подключить
          </button>
        )}
      </Row>
      {tunnel.status === 'error' && tunnel.message && <Row title="Не удалось подключиться" desc={tunnel.message} />}
      {up && tunnel.exit && (
        <Row
          title="Адрес для сайтов"
          desc={tunnel.exit.ipError ? ipText(tunnel.exit.ip) : `${flag(tunnel.exit.country)} ${tunnel.exit.ip}`}
          hint={
            tunnel.exit.ipError
              ? `Туннель работает, но сервисы, по которым узнаётся IP, не ответили: ${tunnel.exit.ipError}`
              : 'Под этим адресом вас видят сайты. Справа — пинг: время ответа через VPN.'
          }
          search="ip адрес пинг задержка"
        >
          <Ping tunnel={tunnel} onMeasure={actions.measure} />
        </Row>
      )}
      {up && tunnel.exit?.timezone && <ZoneRow zone={tunnel.exit.timezone} />}
      {props.children}
    </Card>
  );
}
