// End-to-end self-test of the kill-switch inside real Electron. Compiled in only with
// `node scripts/build.mjs --smoke` (see scripts/smoke.mjs); never part of a release build.

import { BrowserWindow, app, netLog, type WebContents } from 'electron';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE_LANGUAGES, SITE_LOCALE, exitTimezone } from './identity';
import { parseMany } from './links';
import { dnsLookups } from './netlog';
import type { BrowserData } from './browserData';
import type { Store } from './store';
import type { Tabs } from './tabs';
import type { Tunnel } from './tunnel';
import type { TunnelSession } from './tunnelSession';

interface Ctx {
  win: BrowserWindow;
  gate: TunnelSession;
  tunnel: Tunnel;
  tabs: Tabs;
  store: Store;
  browser: BrowserData;
  /** the window profile under test (its own bookmarks) */
  profileId: string;
}

interface LoadResult {
  ok: boolean;
  code?: number;
}

function waitLoad(wc: WebContents, timeoutMs = 25000): Promise<LoadResult> {
  return new Promise((resolve) => {
    let failed: number | undefined;
    const onFail = (_e: unknown, code: number, _d: string, _u: string, main: boolean) => {
      if (main && code !== -3) failed = code;
    };
    const finish = () => {
      clearTimeout(t);
      wc.off('did-fail-load', onFail);
      wc.off('did-stop-loading', finish);
      resolve(failed === undefined ? { ok: true } : { ok: false, code: failed });
    };
    const t = setTimeout(() => {
      wc.off('did-fail-load', onFail);
      wc.off('did-stop-loading', finish);
      resolve({ ok: false, code: 0 });
    }, timeoutMs);
    wc.on('did-fail-load', onFail);
    wc.on('did-stop-loading', finish);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ICE_PROBE = `(async () => {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const c = [];
  pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) c.push(e.candidate.candidate); };
  pc.createDataChannel('probe');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 5000));
  pc.close();
  return c;
})()`;

const udpCandidates = (list: string[]) => list.filter((c) => (c.split(' ')[2] ?? '').toLowerCase() === 'udp');

/** What a VPN-detecting script reads; run in pages, frames and workers. */
const READ_IDENTITY = `({
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  languages: (self.navigator.languages || []).join(','),
  speech: typeof self.speechSynthesis,
  sharedWorker: typeof self.SharedWorker,
})`;
/** The same, read in a dedicated worker the page starts. */
const WORKER_IDENTITY = `new Promise((resolve, reject) => {
  const code = 'postMessage(' + ${JSON.stringify(READ_IDENTITY)} + ')';
  const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  w.onmessage = (e) => resolve(e.data);
  w.onerror = (e) => reject(new Error('worker: ' + e.message));
  setTimeout(() => reject(new Error('worker: timeout')), 5000);
})`;

export async function runSmoke(ctx: Ctx): Promise<void> {
  const outDir = process.env.TB_SMOKE_OUT ?? app.getPath('temp');
  // Every DNS lookup Chromium makes on this computer ends up in the net log.
  const netlogPath = join(outDir, 'netlog.json');
  await netLog.startLogging(netlogPath, { captureMode: 'default' });
  const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  };

  // Anything that reaches this server from the browser is a leak to localhost.
  let canaryHits = 0;
  const canary = http.createServer((_q, s) => {
    canaryHits++;
    s.end('canary');
  });
  await new Promise<void>((r) => canary.listen(0, '127.0.0.1', r));
  const canaryPort = (canary.address() as { port: number }).port;

  try {
    const tabId = ctx.tabs.state().activeId!;
    let wc: WebContents | null = null;
    ctx.tabs.withTab(tabId, (w) => (wc = w));
    const page = wc as unknown as WebContents;

    // --- 1. before connecting
    await sleep(800);
    writeFileSync(join(outDir, 'ui-locked.png'), (await ctx.win.webContents.capturePage()).toPNG());
    check('при запуске браузер заблокирован', ctx.tunnel.locked && !ctx.gate.isOpen);
    const rp0 = await ctx.gate.ses.resolveProxy('https://example.com/');
    check('без туннеля прокси указывает в «чёрную дыру», а не DIRECT', /^PROXY 127\.0\.0\.1:\d+$/.test(rp0.trim()), rp0);
    let threw = false;
    try {
      ctx.tabs.navigate(tabId, 'https://example.com');
    } catch {
      threw = true;
    }
    check('открыть сайт без туннеля нельзя (интерфейс)', threw);
    const direct = page.loadURL('https://example.com/').catch(() => {});
    const r0 = await waitLoad(page);
    await direct;
    check('открыть сайт без туннеля нельзя (сеть)', !r0.ok, `код ${r0.code}`);

    // --- 1b. a tab restored from the last session waits for the tunnel
    const TRACE = 'https://www.cloudflare.com/cdn-cgi/trace';
    ctx.tabs.restore([{ url: TRACE, title: 'Восстановленная вкладка' }], 0);
    const restoredId = ctx.tabs.state().activeId!;
    const restoredInfo = ctx.tabs.state().tabs.find((t) => t.id === restoredId);
    let restoredLoaded = false;
    ctx.tabs.withTab(restoredId, () => (restoredLoaded = true)); // only possible once it has loaded
    check('восстановленная вкладка ждёт туннель и не грузится', restoredInfo?.url === TRACE && !restoredLoaded, restoredInfo?.title);

    // --- 2. connect
    const { profiles, errors } = parseMany(process.env.TB_SMOKE_LINK ?? '');
    check('тестовая ссылка разобрана', profiles.length === 1, errors.join('; '));
    ctx.store.addProfiles(profiles);
    await ctx.tunnel.connect(profiles[0]);
    const st = ctx.tunnel.state;
    check('туннель подключён и проверен', st.status === 'connected', st.message ?? JSON.stringify(st.exit));
    const rp1 = await ctx.gate.ses.resolveProxy('https://example.com/');
    check('с туннелем браузер ходит только через локальный вход Xray', /^PROXY 127\.0\.0\.1:\d+$/.test(rp1.trim()) && rp1 !== rp0, rp1);

    let restoredText = '';
    for (let i = 0; i < 100 && !restoredText.includes('ip='); i++) {
      await sleep(200);
      let wcR: WebContents | null = null;
      ctx.tabs.withTab(restoredId, (w) => (wcR = w));
      const w = wcR as WebContents | null;
      if (w && !w.isLoading() && w.getURL().startsWith(TRACE)) restoredText = await w.executeJavaScript('document.body.innerText');
    }
    check('после подключения восстановленная вкладка открылась через туннель', restoredText.includes('ip='));
    ctx.tabs.close(restoredId);
    ctx.tabs.activate(tabId);

    // --- 3. a real page through the tunnel
    ctx.tabs.navigate(tabId, 'https://www.cloudflare.com/cdn-cgi/trace');
    const r1 = await waitLoad(page);
    const text: string = r1.ok ? await page.executeJavaScript('document.body.innerText') : '';
    check('страница открылась через туннель', /ip=/.test(text), r1.ok ? text.split('\n').filter((l) => /^(ip|loc|http)=/.test(l)).join(' ') : `код ${r1.code}`);
    await sleep(500);
    writeFileSync(join(outDir, 'tab.png'), (await page.capturePage()).toPNG());
    writeFileSync(join(outDir, 'ui.png'), (await ctx.win.webContents.capturePage()).toPNG());
    const flagFont: number = await ctx.win.webContents.executeJavaScript(
      `document.fonts.load('16px "Twemoji Country Flags"', '\u{1F1E9}\u{1F1EA}').then((f) => f.length)`,
    );
    check('шрифт с флагами загружен (флаги на Windows)', flagFont > 0, `найдено начертаний: ${flagFont}`);

    // --- 3a. what a VPN-detecting site reads: the exit's time zone and a neutral language,
    // in the page, in a dedicated worker and in a frame of another site (its own process)
    const exit = ctx.tunnel.state.exit;
    const wantTz = exitTimezone(exit?.country, exit?.colo);
    type Identity = { tz: string; locale: string; languages: string; speech: string; sharedWorker: string };
    const same = (r: Identity | null) =>
      !!r && r.tz === wantTz && r.locale === SITE_LOCALE && r.languages === SITE_LANGUAGES && r.speech === 'undefined' && r.sharedWorker === 'undefined';
    const inPage: Identity = await page.executeJavaScript(READ_IDENTITY);
    check('страница видит часовой пояс страны сервера и нейтральный язык', same(inPage), `${JSON.stringify(inPage)}; ожидали ${wantTz} (${exit?.country}/${exit?.colo})`);
    const inWorker: Identity | null = await page.executeJavaScript(WORKER_IDENTITY).catch((e: Error) => ({ error: e.message }) as never);
    check('то же видит воркер страницы', same(inWorker), JSON.stringify(inWorker));
    await page.executeJavaScript(`new Promise((r) => { const f = document.createElement('iframe'); f.onload = r; f.src = 'https://example.com/'; document.body.appendChild(f); setTimeout(r, 8000); })`);
    const frame = page.mainFrame.frames.find((f) => f.url.startsWith('https://example.com'));
    const inFrame = frame ? ((await frame.executeJavaScript(READ_IDENTITY).catch(() => null)) as Identity | null) : null;
    check('то же видит фрейм другого сайта (отдельный процесс)', same(inFrame), frame ? JSON.stringify(inFrame) : 'фрейм не загрузился');
    check('часовой пояс показан в интерфейсе', exit?.timezone === wantTz, exit?.timezone);

    // --- 3b. bookmarks
    const pid = ctx.profileId;
    const bm = ctx.browser.addBookmark(pid, TRACE, 'Cloudflare trace');
    const again = ctx.browser.addBookmark(pid, `${TRACE}#x`, 'дубль');
    ctx.browser.addBookmark(pid, 'https://example.com/', 'Example');
    check(
      'закладка добавлена, повторная не дублируется',
      ctx.browser.bookmarksState(pid).items.length === 2 && again.id === bm.id && ctx.browser.byUrl(pid, TRACE)?.id === bm.id,
    );
    let badRejected = false;
    try {
      ctx.browser.addBookmark(pid, 'file:///etc/passwd', 'x');
    } catch {
      badRejected = true;
    }
    check('в закладки нельзя добавить не-веб адрес', badRejected);
    await sleep(600);
    writeFileSync(join(outDir, 'ui-bookmarks.png'), (await ctx.win.webContents.capturePage()).toPNG());
    const snap = ctx.tabs.sessionSnapshot();
    check('открытые вкладки попадают в сохраняемую сессию', snap.tabs.some((t) => t.url.startsWith(TRACE)), `${snap.tabs.length} шт.`);

    // --- 4. localhost and LAN are unreachable from pages
    const fetchResult: string = await page.executeJavaScript(
      `fetch('http://127.0.0.1:${canaryPort}/', { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')`,
    );
    const lanResult: string = await page.executeJavaScript(
      `fetch('http://192.168.0.1/', { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')`,
    );
    await sleep(300);
    check('страница не может достучаться до localhost', fetchResult === 'blocked' && canaryHits === 0, `${fetchResult}, обращений: ${canaryHits}`);
    check('страница не может достучаться до локальной сети', lanResult === 'blocked', lanResult);

    // --- 5. WebRTC must not produce UDP candidates (they would bypass the proxy)
    const control = new BrowserWindow({ show: false, webPreferences: { partition: 'smoke-control', sandbox: true } });
    await control.loadURL('about:blank');
    const controlCands: string[] = await control.webContents.executeJavaScript(ICE_PROBE);
    control.destroy();
    const tunnelCands: string[] = await page.executeJavaScript(ICE_PROBE);
    check(
      'WebRTC не даёт UDP мимо туннеля',
      udpCandidates(tunnelCands).length === 0,
      `в туннеле UDP-кандидатов: ${udpCandidates(tunnelCands).length}; для сравнения без защиты: ${udpCandidates(controlCands).length}`,
    );

    // --- 6. the core dies: everything locks
    const child = (ctx.tunnel as unknown as { xray: { child: { kill(s: string): void } | null } }).xray.child;
    child?.kill('SIGKILL');
    const until = Date.now() + 5000;
    while (ctx.tunnel.state.status !== 'error' && Date.now() < until) await sleep(50);
    await sleep(300);
    check('при падении ядра браузер сразу блокируется', ctx.tunnel.locked && !ctx.gate.isOpen, ctx.tunnel.state.message);
    await sleep(300);
    writeFileSync(join(outDir, 'ui-crashed.png'), (await ctx.win.webContents.capturePage()).toPNG());
    const rp2 = await ctx.gate.ses.resolveProxy('https://example.com/');
    check('после падения прокси снова в «чёрной дыре»', rp2.trim() === rp0.trim(), rp2);
    const after = page.loadURL('https://www.cloudflare.com/cdn-cgi/trace').catch(() => {});
    const r2 = await waitLoad(page);
    await after;
    check('после падения ядра страницы не грузятся', !r2.ok, `код ${r2.code}`);

    // --- 7. layer 1 alone: pretend the gate has a bug and lets requests through
    (ctx.gate as unknown as { open: boolean }).open = true;
    const bypass = page.loadURL('https://www.cloudflare.com/cdn-cgi/trace').catch(() => {});
    const r3 = await waitLoad(page);
    await bypass;
    const leaked: string = r3.ok ? await page.executeJavaScript('document.body.innerText') : '';
    (ctx.gate as unknown as { open: boolean }).open = false;
    check('даже без проверки запросов трафик не уходит напрямую', !/ip=/.test(leaked), r3.ok ? 'страница загрузилась!' : `код ${r3.code}`);
  } catch (e) {
    check('самопроверка завершилась без исключений', false, e instanceof Error ? e.stack : String(e));
  } finally {
    canary.close();
    // --- 8. DNS: names of visited sites are resolved by the VPN server, never here
    try {
      await netLog.stopLogging();
      const looked = dnsLookups(JSON.parse(readFileSync(netlogPath, 'utf8')));
      check('браузер не делает DNS-запросов на этом компьютере (нет утечки DNS)', looked.length === 0, looked.slice(0, 10).join(', ') || 'ни одного');
    } catch (e) {
      check('журнал сети прочитан', false, e instanceof Error ? e.message : String(e));
    }
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
    await ctx.tunnel.disconnect().catch(() => {});
    app.exit(results.every((r) => r.ok) ? 0 : 1);
  }
}
