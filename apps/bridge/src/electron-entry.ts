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
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
