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

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { hasConnection, installLinuxAutostart } from './auto-launch.js';
import {
  PROTOCOL_SCHEME,
  configFilePath,
  findConnectUrlInArgv,
  loadConnectConfig,
  parseConnectUrl,
  saveConnectConfig,
} from './deep-link.js';
import { runDoctor } from './doctor.js';
import { needsOriginChangeApproval } from './security.js';
import { runHeadless, shutdownBridgeLoop } from './headless.js';
import { createBridge } from './main.js';
import { BRIDGE_VERSION, checkForUpdate } from './updates.js';

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
      preload: path.join(__dirname, 'preload.js'), // GAP-135: オンボーディング UI 用 IPC
    },
  });

  // GAP-135: 初回オンボーディング + 常駐状態を表示する UI
  const indexHtml = path.join(__dirname, '..', 'renderer', 'index.html');
  void win.loadFile(indexHtml, {
    query: { capacity: String(bridge.capacity) },
  });

  return win;
}

/* ------------------------------------------------------------------ */
/* GAP-135: オンボーディング UI の IPC (診断 + 更新チェック + 外部リンク) */
/* ------------------------------------------------------------------ */

function registerIpcHandlers(): void {
  ipcMain.handle('bridge:status', async () => {
    const report = await runDoctor();
    // 更新チェックは接続先 API が分かるときだけ (失敗しても更新なし扱い)
    const apiUrl =
      process.env.ATELIER_API_URL ??
      loadConnectConfig(configFilePath(homedir()))?.apiUrl ??
      null;
    const update =
      apiUrl !== null
        ? await checkForUpdate(apiUrl)
        : {
            updateAvailable: false,
            currentVersion: BRIDGE_VERSION,
            latestVersion: null,
            downloadUrl: null,
          };
    return { version: BRIDGE_VERSION, report, update };
  });
  ipcMain.handle('bridge:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string') return false;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    await shell.openExternal(url);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* GAP-122: ワンクリック接続 (atelier-bridge:// ディープリンク)          */
/* ------------------------------------------------------------------ */

/**
 * 接続 URL を受けたら設定を保存して再起動する (新しい設定でループが立ち上がる)。
 *
 * GAP-199: これまでは **どんな http(s) URL でも無条件に保存**していた。
 * 悪意のあるページに `atelier-bridge://connect?api=...` を開かせるだけで
 * 指示元を差し替えられる状態だったので、次の 2 段で塞ぐ:
 *   ① parseConnectUrl が許可した接続先しか通さない
 *   ② 既に接続済みで**接続先が変わる**ときは、本人の確認を必ず取る
 */
function handleConnectUrl(raw: string): void {
  const parsed = parseConnectUrl(raw, process.env);
  if (parsed === null) {
    console.error('[bridge] 許可されていない接続先、または不正な接続 URL を無視しました');
    return;
  }
  const current = loadConnectConfig(configFilePath(homedir()));
  if (needsOriginChangeApproval(current?.apiUrl ?? null, parsed.apiUrl)) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['接続先を変更する', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      title: 'Atelier Bridge — 接続先の変更',
      message: 'このパソコンへの指示元を変更しようとしています',
      detail:
        `今の接続先: ${current?.apiUrl ?? '(なし)'}\n` +
        `新しい接続先: ${parsed.apiUrl}\n\n` +
        '心当たりが無い場合はキャンセルしてください。' +
        '接続先を変えると、そのサーバーからの指示でこのパソコンの Claude が動きます。',
    });
    if (choice !== 0) {
      console.error('[bridge] 接続先の変更をキャンセルしました');
      return;
    }
  }
  saveConnectConfig(configFilePath(homedir()), parsed);
  console.log('[bridge] 接続設定を保存しました。再起動します');
  ensureAutoLaunch(); // 接続が成立したのでログイン時自動起動も同時に登録
  app.relaunch();
  app.exit(0);
}

/* ------------------------------------------------------------------ */
/* GAP-126: ログイン時自動起動 (OS 再起動後も自動で接続に戻る)           */
/* ------------------------------------------------------------------ */

function ensureAutoLaunch(): void {
  // dev 実行 (未パッケージ) では electron バイナリを OS に誤登録しない
  if (!app.isPackaged) return;
  // 未接続のまま常駐させない — 接続済みのときだけ登録
  if (!hasConnection(process.env, configFilePath(homedir()))) return;
  try {
    if (process.platform === 'linux') {
      // AppImage は実行のたびにマウント先が変わるため APPIMAGE 実体を登録する
      installLinuxAutostart(homedir(), process.env.APPIMAGE ?? process.execPath);
    } else {
      app.setLoginItemSettings({ openAtLogin: true });
    }
    console.log('[bridge] ログイン時自動起動を登録しました');
  } catch (err: unknown) {
    // 自動起動の登録失敗は接続自体を止めない (手動起動 + 再接続フローで回復可能)
    console.error('[bridge] 自動起動の登録に失敗:', err);
  }
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
    registerIpcHandlers();
    createWindow();
    ensureBridgeLoop();
    ensureAutoLaunch();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// GAP-243: アプリを閉じるときは presence を落としてから終了する。
// 黙って終わると最長 90 秒は画面が「接続中」のままで、その間の送信は
// 誰にも拾われない。1 回目の quit を止めて伝達 (最長 3 秒) → 改めて quit。
let goodbyeSent = false;
app.on('before-quit', (event) => {
  if (goodbyeSent) return;
  goodbyeSent = true;
  event.preventDefault();
  void shutdownBridgeLoop().finally(() => app.quit());
});
