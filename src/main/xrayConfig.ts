// Builds the Xray JSON config for the browser tunnel. Pure module, covered by unit tests.

import type { ServerProfile } from '../shared/types';

export interface InboundParams {
  port: number;
  user: string;
  pass: string;
}

/**
 * Destinations the tunnel must never carry: the user's own machine and LAN, and the
 * VPN server's loopback/private network. A page in the tunnel browser should not be
 * able to reach any of these.
 */
export const BLOCKED_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '224.0.0.0/4',
  '255.255.255.255/32',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
];

type Json = Record<string, unknown>;

function streamSettings(p: ServerProfile): Json {
  const t = p.transport;
  const s: Json = { network: t.type === 'tcp' ? 'raw' : t.type, security: p.security.type };

  switch (t.type) {
    case 'tcp':
      if (t.headerType === 'http') {
        s.rawSettings = {
          header: {
            type: 'http',
            request: {
              path: [t.path || '/'],
              headers: t.host ? { Host: t.host.split(',').map((h) => h.trim()) } : {},
            },
          },
        };
      }
      break;
    case 'ws':
      s.wsSettings = { path: t.path || '/', ...(t.host ? { host: t.host } : {}) };
      break;
    case 'httpupgrade':
      s.httpupgradeSettings = { path: t.path || '/', ...(t.host ? { host: t.host } : {}) };
      break;
    case 'grpc':
      s.grpcSettings = {
        serviceName: t.serviceName ?? '',
        multiMode: t.mode === 'multi',
        ...(t.authority ? { authority: t.authority } : {}),
      };
      break;
    case 'xhttp':
      s.xhttpSettings = {
        path: t.path || '/',
        ...(t.host ? { host: t.host } : {}),
        mode: t.mode || 'auto',
        ...(t.extra ? { extra: t.extra } : {}),
      };
      break;
    case 'kcp':
      s.kcpSettings = {
        ...(t.headerType ? { header: { type: t.headerType } } : {}),
        ...(t.seed ? { seed: t.seed } : {}),
      };
      break;
  }

  const sec = p.security;
  if (sec.type === 'tls') {
    s.tlsSettings = {
      serverName: sec.sni || p.address,
      fingerprint: sec.fingerprint || 'chrome',
      ...(sec.alpn ? { alpn: sec.alpn } : {}),
      ...(sec.pinnedPeerCertSha256 ? { pinnedPeerCertSha256: sec.pinnedPeerCertSha256 } : {}),
      ...(sec.verifyPeerCertByName ? { verifyPeerCertByName: sec.verifyPeerCertByName } : {}),
    };
  } else if (sec.type === 'reality') {
    s.realitySettings = {
      serverName: sec.sni || '',
      fingerprint: sec.fingerprint || 'chrome',
      password: sec.publicKey,
      shortId: sec.shortId || '',
      spiderX: sec.spiderX || '',
      ...(sec.mldsa65Verify ? { mldsa65Verify: sec.mldsa65Verify } : {}),
    };
  }
  return s;
}

export function buildOutbound(p: ServerProfile): Json {
  let settings: Json;
  switch (p.protocol) {
    case 'vless':
      settings = {
        vnext: [
          {
            address: p.address,
            port: p.port,
            users: [{ id: p.uuid, encryption: p.encryption || 'none', ...(p.flow ? { flow: p.flow } : {}) }],
          },
        ],
      };
      break;
    case 'vmess':
      settings = {
        vnext: [{ address: p.address, port: p.port, users: [{ id: p.uuid, security: p.cipher || 'auto' }] }],
      };
      break;
    case 'trojan':
      settings = { servers: [{ address: p.address, port: p.port, password: p.password }] };
      break;
    case 'shadowsocks':
      settings = { servers: [{ address: p.address, port: p.port, method: p.method, password: p.password }] };
      break;
  }
  return { tag: 'proxy', protocol: p.protocol, settings, streamSettings: streamSettings(p) };
}

/**
 * Full config: one authenticated HTTP inbound on loopback, the server outbound, and a
 * blackhole for private destinations. Logs never contain visited hosts (access log off).
 */
export function buildXrayConfig(p: ServerProfile, inbound: InboundParams): Json {
  return {
    log: { loglevel: 'warning', access: 'none', dnsLog: false },
    inbounds: [
      {
        tag: 'browser-in',
        listen: '127.0.0.1',
        port: inbound.port,
        protocol: 'http',
        settings: {
          accounts: [{ user: inbound.user, pass: inbound.pass }],
          allowTransparent: false,
        },
      },
    ],
    outbounds: [buildOutbound(p), { tag: 'block', protocol: 'blackhole' }],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', ip: BLOCKED_CIDRS, outboundTag: 'block' },
        { type: 'field', domain: ['full:localhost', 'domain:localhost'], outboundTag: 'block' },
        { type: 'field', inboundTag: ['browser-in'], outboundTag: 'proxy' },
      ],
    },
  };
}
