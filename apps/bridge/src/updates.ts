/**
 * GAP-135: Bridge の更新チェック (再インストールを「気づける」化する)。
 *
 * Atelier API の公開エンドポイント GET /public/bridge-latest から最新版情報を
 * 取得し、自分のバージョンと比較する。新しい版があればオンボーディング UI に
 * バナーを出し、ワンクリックで OS に合った installer のダウンロードへ誘導する。
 *
 * 方針 (誠実設計):
 *   - サイレント自動更新 (electron-updater) は各 OS の署名済みビルド +
 *     更新サーバーが前提。署名インフラ整備前に「自動更新済み」を装わない。
 *     チェック + 通知 + ワンクリック DL までを確実に動くものとして実装する。
 *   - フィードが無い/壊れている場合は「更新なし」に倒す (起動を妨げない)。
 */

export const BRIDGE_VERSION = '0.1.0';

export interface BridgeLatestFeed {
  readonly version: string;
  /** OS キー (mac / win / linux) → ダウンロード URL。 */
  readonly downloadUrls: Readonly<Partial<Record<'mac' | 'win' | 'linux', string>>>;
}

export interface UpdateCheckResult {
  readonly updateAvailable: boolean;
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  /** この OS 用のダウンロード URL (無ければ null — バナーは案内文のみ)。 */
  readonly downloadUrl: string | null;
}

/** 'x.y.z' 同士を数値比較する。解釈できない版は「新しくない」扱い。 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const a = parse(candidate);
  const b = parse(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

/** platform → フィードの OS キー。 */
export function osKey(platform: NodeJS.Platform): 'mac' | 'win' | 'linux' {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return 'linux';
}

/** フィード JSON を検証して型に落とす (欠損/型崩れは null)。 */
export function parseLatestFeed(raw: unknown): BridgeLatestFeed | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = (raw as { data?: unknown }).data ?? raw;
  if (typeof data !== 'object' || data === null) return null;
  const rec = data as Record<string, unknown>;
  if (typeof rec.version !== 'string' || rec.version === '') return null;
  const urls: Partial<Record<'mac' | 'win' | 'linux', string>> = {};
  const rawUrls = rec.download_urls ?? rec.downloadUrls;
  if (typeof rawUrls === 'object' && rawUrls !== null) {
    for (const key of ['mac', 'win', 'linux'] as const) {
      const v = (rawUrls as Record<string, unknown>)[key];
      if (typeof v === 'string' && v !== '') urls[key] = v;
    }
  }
  return { version: rec.version, downloadUrls: urls };
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * 更新チェック本体。失敗はすべて「更新なし」に倒す (UI を邪魔しない)。
 */
export async function checkForUpdate(
  apiUrl: string,
  opts: {
    readonly fetchLike?: FetchLike;
    readonly currentVersion?: string;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<UpdateCheckResult> {
  const current = opts.currentVersion ?? BRIDGE_VERSION;
  const noUpdate: UpdateCheckResult = {
    updateAvailable: false,
    currentVersion: current,
    latestVersion: null,
    downloadUrl: null,
  };
  const fetchLike = opts.fetchLike ?? (fetch as unknown as FetchLike);
  const base = apiUrl.replace(/\/+$/, '');
  try {
    const res = await fetchLike(`${base}/public/bridge-latest`);
    if (!res.ok) return noUpdate;
    const feed = parseLatestFeed(await res.json());
    if (feed === null) return noUpdate;
    const platform = opts.platform ?? process.platform;
    return {
      updateAvailable: isNewerVersion(feed.version, current),
      currentVersion: current,
      latestVersion: feed.version,
      downloadUrl: feed.downloadUrls[osKey(platform)] ?? null,
    };
  } catch {
    return noUpdate;
  }
}
