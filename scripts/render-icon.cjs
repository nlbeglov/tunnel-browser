// Renders build/icon.svg to build/icon.png (1024x1024, transparent) using Electron itself.
//   npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const { readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, '..', 'build', 'icon.svg')).toString('base64');
  const html = `<html><body style="margin:0;background:transparent"><img width="1024" height="1024" src="data:image/svg+xml;base64,${svg}"></body></html>`;
  const page = join(tmpdir(), `tb-icon-${process.pid}.html`);
  writeFileSync(page, html);

  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  let ready = false;
  win.webContents.on('paint', (_e, _dirty, image) => {
    if (!ready) return;
    ready = false;
    writeFileSync(join(__dirname, '..', 'build', 'icon.png'), image.resize({ width: 1024, height: 1024 }).toPNG());
    console.log('build/icon.png', image.getSize());
    rmSync(page, { force: true });
    app.quit();
  });
  await win.loadFile(page);
  await win.webContents.executeJavaScript('document.images[0].decode()');
  setTimeout(() => {
    ready = true;
    win.webContents.invalidate();
  }, 300);
});
