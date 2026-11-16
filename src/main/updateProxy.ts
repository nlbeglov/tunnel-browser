// Direct route for app updates only.
//
// Chromium is started with every DNS lookup disabled (index.ts: host-resolver-rules), because
// behind a proxy it still looked up the names of visited sites through this computer's DNS.
// Pages do not need it: their names are resolved by the VPN server. Updates go straight to
// GitHub (electron-updater uses Chromium's network), so its session is pointed at this tiny
// HTTPS proxy, which resolves through the system and connects directly, to GitHub hosts only.
// No Electron imports: unit-tested.

import http from 'node:http';
import net from 'node:net';

/** Hosts the updater talks to: the release feed and the files' download redirect. */
export function isUpdateHost(target: string): boolean {
  const m = /^([a-z0-9.-]+):(\d+)$/i.exec(target.trim());
  if (!m || m[2] !== '443') return false;
  const host = m[1].toLowerCase();
  return host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com');
}

export function startUpdateProxy(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(405).end();
    });
    srv.on('connect', (req, client, head) => {
      client.on('error', () => {});
      const target = req.url ?? '';
      if (!isUpdateHost(target)) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const [host, port] = target.split(':');
      const up = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (head.length) up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
      up.on('error', () => client.destroy());
      client.on('close', () => up.destroy());
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      if (a && typeof a === 'object') resolve({ port: a.port, close: () => srv.close() });
      else reject(new Error('update proxy failed'));
    });
  });
}
