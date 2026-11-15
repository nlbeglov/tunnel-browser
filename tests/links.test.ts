import { describe, expect, it } from 'vitest';
import { extractLinks, parseLink, parseMany } from '../src/main/links';
import { BAD_LINKS, LINKS, REALITY_PBK, UUID } from './fixtures';

describe('parseLink', () => {
  it('VLESS + Reality + Vision', () => {
    const p = parseLink(LINKS.vlessReality);
    expect(p).toMatchObject({
      protocol: 'vless',
      name: 'Нидерланды',
      address: 'nl1.example.com',
      port: 443,
      uuid: UUID,
      flow: 'xtls-rprx-vision',
      transport: { type: 'tcp' },
      security: { type: 'reality', sni: 'www.microsoft.com', publicKey: REALITY_PBK, shortId: '6ba85179e30d4fc2', spiderX: '/', fingerprint: 'chrome' },
    });
  });

  it('VLESS + WebSocket + TLS', () => {
    const p = parseLink(LINKS.vlessWsTls);
    expect(p.transport).toEqual({ type: 'ws', path: '/ws?ed=2048', host: 'cdn.example.com' });
    expect(p.security).toMatchObject({ type: 'tls', sni: 'cdn.example.com', alpn: ['http/1.1'] });
    expect(p.name).toBe('WS TLS');
  });

  it('VLESS + XHTTP with extra JSON', () => {
    const p = parseLink(LINKS.vlessXhttp);
    expect(p.transport).toMatchObject({ type: 'xhttp', path: '/xh', mode: 'auto', extra: { xPaddingBytes: '100-1000' } });
    expect(p.security.fingerprint).toBe('firefox');
  });

  it('VLESS + gRPC multi', () => {
    const p = parseLink(LINKS.vlessGrpc);
    expect(p.transport).toMatchObject({ type: 'grpc', serviceName: 'grpcsvc', mode: 'multi' });
  });

  it('IPv6 address in brackets', () => {
    const p = parseLink(LINKS.vlessIpv6);
    expect(p.address).toBe('2001:db8::1');
    expect(p.port).toBe(8443);
    expect(p.transport.type).toBe('httpupgrade');
  });

  it('VMess base64 JSON; SNI falls back to host', () => {
    const p = parseLink(LINKS.vmessWsTls);
    expect(p).toMatchObject({
      protocol: 'vmess',
      name: 'VMess WS',
      address: '203.0.113.7',
      port: 8443,
      cipher: 'auto',
      transport: { type: 'ws', path: '/vm', host: 'vm.example.com' },
      security: { type: 'tls', sni: 'vm.example.com' },
    });
  });

  it('Trojan defaults to TLS and decodes the password', () => {
    const p = parseLink(LINKS.trojan);
    expect(p).toMatchObject({ protocol: 'trojan', password: 'p@ss:word', security: { type: 'tls', sni: 't.example.com' } });
  });

  it('Shadowsocks: SIP002, legacy and 2022 formats', () => {
    expect(parseLink(LINKS.ssSip002)).toMatchObject({ method: 'chacha20-ietf-poly1305', password: 'secret', address: '198.51.100.5', port: 8388 });
    expect(parseLink(LINKS.ssLegacy)).toMatchObject({ method: 'aes-256-gcm', password: 'pw', address: '198.51.100.9', port: 1234, name: 'Legacy' });
    expect(parseLink(LINKS.ss2022)).toMatchObject({ method: '2022-blake3-aes-128-gcm', password: 'YctPZ6U7xPPcU+gp3u+QAA==' });
  });

  it('refuses links that would weaken security or cannot work', () => {
    expect(() => parseLink(BAD_LINKS.insecure)).toThrow(/allowInsecure/);
    expect(() => parseLink(BAD_LINKS.hysteria)).toThrow(/не поддерживается/);
    expect(() => parseLink(BAD_LINKS.ssPlugin)).toThrow(/плагины/);
    expect(() => parseLink(BAD_LINKS.noPbk)).toThrow(/pbk/);
    expect(() => parseLink(BAD_LINKS.badPort)).toThrow(/порт|повреждена/);
    expect(() => parseLink(BAD_LINKS.plaintext)).toThrow(/открытым текстом/);
    expect(() => parseLink(BAD_LINKS.garbage)).toThrow();
  });
});

describe('subscriptions', () => {
  const all = Object.values(LINKS);

  it('reads plain text and base64 bodies alike', () => {
    expect(extractLinks(all.join('\n'))).toHaveLength(all.length);
    expect(extractLinks(Buffer.from(all.join('\r\n')).toString('base64'))).toHaveLength(all.length);
    expect(extractLinks(Buffer.from(all.join('\n')).toString('base64url').replace(/=+$/, ''))).toHaveLength(all.length);
  });

  it('keeps good servers and reports bad ones', () => {
    const r = parseMany([LINKS.trojan, BAD_LINKS.hysteria, '# comment', LINKS.ssSip002].join('\n'));
    expect(r.profiles.map((p) => p.protocol)).toEqual(['trojan', 'shadowsocks']);
    expect(r.errors).toHaveLength(1);
  });

  it('says so when there is nothing to import', () => {
    expect(parseMany('hello').errors[0]).toMatch(/не найдено/);
  });
});
