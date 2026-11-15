// Sample share links in the formats real providers hand out. Keys and IDs are throwaway.

const b64 = (s: string) => Buffer.from(s).toString('base64');
const b64url = (s: string) => Buffer.from(s).toString('base64url');

export const UUID = 'f6db1b3a-7350-4ed6-829b-d32f7fb9a2b6';
export const REALITY_PBK = '8Fi3wuEvD-VuVMpN6X35d_AdazuORjU0X6R9Im48MAA';

export const LINKS = {
  vlessReality:
    `vless://${UUID}@nl1.example.com:443?encryption=none&flow=xtls-rprx-vision&security=reality` +
    `&sni=www.microsoft.com&fp=chrome&pbk=${REALITY_PBK}&sid=6ba85179e30d4fc2&spx=%2F&type=tcp&headerType=none` +
    '#%D0%9D%D0%B8%D0%B4%D0%B5%D1%80%D0%BB%D0%B0%D0%BD%D0%B4%D1%8B',
  vlessWsTls:
    `vless://${UUID}@cdn.example.com:443?encryption=none&security=tls&sni=cdn.example.com&alpn=http%2F1.1` +
    '&type=ws&host=cdn.example.com&path=%2Fws%3Fed%3D2048#WS%20TLS',
  vlessXhttp:
    `vless://${UUID}@x.example.com:443?encryption=none&security=reality&sni=x.example.com&fp=firefox` +
    `&pbk=${REALITY_PBK}&sid=ab&type=xhttp&path=%2Fxh&mode=auto` +
    `&extra=${encodeURIComponent(JSON.stringify({ xPaddingBytes: '100-1000' }))}#XHTTP`,
  vlessGrpc:
    `vless://${UUID}@g.example.com:443?encryption=none&security=tls&sni=g.example.com&type=grpc` +
    '&serviceName=grpcsvc&mode=multi#gRPC',
  vlessIpv6: `vless://${UUID}@[2001:db8::1]:8443?encryption=none&security=tls&sni=v6.example.com&type=httpupgrade&path=%2Fup#v6`,
  vmessWsTls:
    'vmess://' +
    b64(
      JSON.stringify({
        v: '2',
        ps: 'VMess WS',
        add: '203.0.113.7',
        port: '8443',
        id: UUID,
        aid: '0',
        scy: 'auto',
        net: 'ws',
        type: 'none',
        host: 'vm.example.com',
        path: '/vm',
        tls: 'tls',
        sni: '',
      }),
    ),
  trojan: 'trojan://p%40ss%3Aword@t.example.com:443?sni=t.example.com&type=tcp#Trojan',
  ssSip002: `ss://${b64url('chacha20-ietf-poly1305:secret')}@198.51.100.5:8388#SS`,
  ssLegacy: `ss://${b64('aes-256-gcm:pw@198.51.100.9:1234')}#Legacy`,
  ss2022: 'ss://2022-blake3-aes-128-gcm:YctPZ6U7xPPcU%2Bgp3u%2BQAA%3D%3D@198.51.100.1:443#SS2022',
};

export const BAD_LINKS = {
  insecure: `vless://${UUID}@a.example.com:443?security=tls&allowInsecure=1&type=tcp#bad`,
  hysteria: 'hysteria2://pass@h.example.com:443#hy2',
  ssPlugin: `ss://${b64url('aes-128-gcm:x')}@1.2.3.4:443?plugin=obfs-local%3Bobfs%3Dhttp#plugin`,
  noPbk: `vless://${UUID}@a.example.com:443?security=reality&sni=a.example.com&type=tcp#nopbk`,
  badPort: `vless://${UUID}@a.example.com:99999?security=tls&type=tcp#port`,
  plaintext: `vless://${UUID}@203.0.113.1:80?encryption=none&security=none&type=tcp#open`,
  garbage: 'https://example.com/not-a-server',
};
