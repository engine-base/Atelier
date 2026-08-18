/**
 * GAP-135: renderer へ露出する最小 API (contextIsolation + sandbox 前提)。
 *
 * renderer は Node にアクセスできない。診断 (doctor) と更新チェックは
 * main プロセスで実行し、ここは invoke の橋渡しだけを行う。
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('atelierBridge', {
  /** 環境診断 + バージョン + 更新チェックの現在値を返す。 */
  getStatus: (): Promise<unknown> => ipcRenderer.invoke('bridge:status'),
  /** 既定ブラウザで URL を開く (http/https のみ main 側で検証)。 */
  openExternal: (url: string): Promise<unknown> => ipcRenderer.invoke('bridge:open-external', url),
});
