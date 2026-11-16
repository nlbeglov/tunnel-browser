import { describe, expect, it } from 'vitest';
import { cleanUserAgent, gateAllows, isLocalHost, isProxyFailureResponse, isTunnelTroubleError } from '../src/main/guard';
import { inputToUrl } from '../src/main/url';
import { parseTitle, parseUserinfo } from '../src/main/subscription';

describe('isLocalHost', () => {
  it.each([
    'localhost',
    'LOCALHOST.',
    'app.localhost',
    '127.0.0.1',
    '127.8.8.8',
    '[::1]',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fd00::1',
  ])('%s is local', (h) => expect(isLocalHost(h)).toBe(true));

  it.each(['example.com', '8.8.8.8', '172.32.0.1', '2001:4860:4860::8888', 'localhost.example.com'])('%s is public', (h) =>
    expect(isLocalHost(h)).toBe(false),
  );
});

describe('gateAllows', () => {
  it('blocks every network request while the tunnel is down', () => {
    for (const u of ['https://example.com/', 'http://example.com/', 'wss://example.com/ws']) expect(gateAllows(u, false)).toBe(false);
  });

  it('lets non-network URLs through regardless', () => {
    for (const u of ['data:text/plain,hi', 'blob:https://example.com/abc', 'about:blank']) expect(gateAllows(u, false)).toBe(true);
  });

  it('with the tunnel up, allows the web but never local addresses or other schemes', () => {
    expect(gateAllows('https://example.com/', true)).toBe(true);
    expect(gateAllows('ws://example.com/', true)).toBe(true);
    expect(gateAllows('http://127.0.0.1:8080/', true)).toBe(false);
    expect(gateAllows('http://2130706433/', true)).toBe(false); // = 127.0.0.1
    expect(gateAllows('http://0x7f.1/', true)).toBe(false); // = 127.0.0.1
    expect(gateAllows('http://[::1]/', true)).toBe(false);
    expect(gateAllows('http://router.localhost/', true)).toBe(false);
    expect(gateAllows('file:///etc/passwd', true)).toBe(false);
    expect(gateAllows('chrome://settings', true)).toBe(false);
    expect(gateAllows('ftp://example.com/', true)).toBe(false);
    expect(gateAllows('not a url', true)).toBe(false);
  });
});

describe('inputToUrl', () => {
  it('turns hosts into https URLs', () => {
    expect(inputToUrl('example.com')).toBe('https://example.com/');
    expect(inputToUrl('  ya.ru/search?q=1 ')).toBe('https://ya.ru/search?q=1');
    expect(inputToUrl('http://plain.example.com')).toBe('http://plain.example.com/');
  });

  it('searches everything else, including script-looking input', () => {
    expect(inputToUrl('как дела')).toMatch(/^https:\/\/duckduckgo\.com\/\?q=/);
    expect(inputToUrl('javascript:alert(1)')).toMatch(/^https:\/\/duckduckgo\.com\/\?q=javascript/);
  });

  it('refuses non-web schemes', () => {
    expect(() => inputToUrl('file:///C:/Windows')).toThrow();
    expect(() => inputToUrl('chrome://settings')).toThrow();
  });
});

describe('signs of a dead tunnel in page traffic', () => {
  it.each(['net::ERR_CONNECTION_CLOSED', 'net::ERR_EMPTY_RESPONSE', 'net::ERR_TUNNEL_CONNECTION_FAILED', 'net::ERR_TIMED_OUT'])(
    '%s counts',
    (e) => expect(isTunnelTroubleError(e)).toBe(true),
  );

  // Our own block, a cancelled load and a broken page are not the tunnel's fault.
  it.each(['net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_ABORTED', 'net::ERR_CERT_DATE_INVALID', 'net::ERR_FILE_NOT_FOUND'])(
    '%s does not count',
    (e) => expect(isTunnelTroubleError(e)).toBe(false),
  );

  it("Xray's empty 503 counts, a site's own 503 does not", () => {
    // Exactly what Xray's HTTP inbound sends when it cannot reach the server.
    expect(isProxyFailureResponse(503, { Connection: ['close'], 'Proxy-Connection': ['close'], 'Content-Length': ['0'] })).toBe(true);
    expect(isProxyFailureResponse(503, { date: ['Mon, 16 Nov 2026 10:21:42 GMT'], server: ['nginx'] })).toBe(false);
    expect(isProxyFailureResponse(200, {})).toBe(false);
    expect(isProxyFailureResponse(502, {})).toBe(false);
  });
});

describe('misc', () => {
  it('cleans the user agent', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) tunnel-browser/0.1.0 Chrome/142.0.7444.59 Electron/45.3.2 Safari/537.36';
    expect(cleanUserAgent(ua)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36');
  });

  it('parses subscription headers', () => {
    expect(parseUserinfo('upload=10; download=20; total=1000; expire=1767225600')).toEqual({ upload: 10, download: 20, total: 1000, expire: 1767225600 });
    expect(parseTitle(`base64:${Buffer.from('Мой VPN').toString('base64')}`)).toBe('Мой VPN');
    expect(parseTitle('My%20VPN')).toBe('My VPN');
  });
});
