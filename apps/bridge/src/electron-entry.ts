/**
 * Atelier Bridge — Electron エントリポイント (T-I-11/12 補強)。
 *
 * 雛形だった本ファイルを実体化:
 *   - electron app を起動して BrowserWindow に dispatcher 状況を描画
 *   - Vibeyard fork を取り込む前でも、配布パイプライン (electron-builder ->
 *     AppImage / .deb / .dmg / .msi) を実走確認できる最小実装。
 *   - 完成形では Vibeyard fork (xterm.js + node-pty) を取り込み、本ウィンドウを
 *     terminal multiplexer に差し替える (T-F-28 以降)。
 *
 * 本ファイルは Electron 環境専用。createBridge ライブラリ API は src/main.ts に残す
 * (vitest からの import が壊れないように分離)。
 */

import { app, BrowserWindow } from 'electron';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  PROTOCOL_SCHEME,
  configFilePath,
  findConnectUrlInArgv,
  parseConnectUrl,
  saveConnectConfig,
} from './deep-link.js';
import { runHeadless } from './headless.js';
import { createBridge } from './main.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createWindow(): BrowserWindow {
  const bridge = createBridge();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Atelier Bridge',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 配布物に同梱する index.html (Vibeyard 取り込み前の placeholder UI)
  const indexHtml = path.join(__dirname, '..', 'renderer', 'index.html');
  void win.loadFile(indexHtml, {
    query: { capacity: String(bridge.capacity) },
  });

  return win;
}

/* ------------------------------------------------------------------ */
/* GAP-122: ワンクリック接続 (atelier-bridge:// ディープリンク)          */
/* ------------------------------------------------------------------ */

/** 接続 URL を受けたら設定を保存して再起動する (新しい設定でループが立ち上がる)。 */
function handleConnectUrl(raw: string): void {
  const parsed = parseConnectUrl(raw);
  if (parsed === null) {
    console.error('[bridge] 不正な接続 URL を無視しました');
    return;
  }
  saveConnectConfig(configFilePath(homedir()), parsed);
  console.log('[bridge] 接続設定を保存しました。再起動します');
  app.relaunch();
  app.exit(0);
}

/** チャット中継 + presence のループを起動する (設定 or env が無ければ何もしない)。 */
let loopStarted = false;
function ensureBridgeLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  void runHeadless({ env: process.env, argv: ['--loop'] }).then((code) => {
    loopStarted = false;
    if (code !== 0) console.error(`[bridge] loop exited with code ${code}`);
  });
}

app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);

// 二重起動はディープリンクの受け口に集約 (Windows/Linux は argv で届く)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = findConnectUrlInArgv(argv);
    if (url) handleConnectUrl(url);
  });
  // macOS はディープリンクが open-url で届く
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleConnectUrl(url);
  });

  void app.whenReady().then(() => {
    // 初回起動が connect URL 付きだった場合 (Windows/Linux)
    const url = findConnectUrlInArgv(process.argv);
    if (url) {
      handleConnectUrl(url);
      return;
    }
    createWindow();
    ensureBridgeLoop();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
