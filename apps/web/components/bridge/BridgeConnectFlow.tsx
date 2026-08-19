/**
 * Bridge 接続フロー (共通) — GAP-122 で作った手順を GAP-168 で共通化。
 *
 * 経営者指摘 (2026-08-19):
 *   「以前の実装で、もし接続できていない場合は接続させるフローが出てくる状態に
 *    更新しているはずだけど、なんで出てない？ バグじゃないか？」
 *
 * そのとおりで、接続フローは**チャット画面の中にしか無い**実装漏れでした。
 * Bridge (本人の PC) が要る操作は他にもあります — デザインテンプレの生成、
 * モックの改訂、成果物ファイルの AI 編集。どこで詰まっても同じ導線が出るように
 * ここへ切り出し、各画面から使います。
 */

"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";

import * as api from "../../lib/auth/connector";

/** GAP-122: ダウンロード先 (Mac/Win/Linux — スマホ非対応)。 */
const BRIDGE_RELEASES_URL = "https://github.com/engine-base/Atelier/releases";

/**
 * relay 未接続時の接続フロー (GAP-122 ワンクリック接続):
 *   1. アプリをインストール (Mac / Windows / Linux)
 *   2. 「接続トークンを発行」→「アプリで接続」(atelier-bridge:// でアプリ起動 +
 *      接続先とトークンが自動設定される)
 *   3. パネルが「Bridge 接続中」になれば完了
 * raw トークンは発行応答で 1 度だけ表示する (サーバーは hash のみ保存)。
 */
export function BridgeConnectFlow() {
  const [issued, setIssued] = React.useState<{ token: string } | null>(null);
  const [issuing, setIssuing] = React.useState(false);
  const [issueError, setIssueError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const issue = () => {
    setIssuing(true);
    setIssueError(null);
    api
      .sendJson<{ token: string }>("POST", "/bridge-tokens", { label: "Bridge" })
      .then((res) => {
        if (!res?.token) throw new Error("empty response");
        setIssued({ token: res.token });
      })
      .catch(() => setIssueError("トークンを発行できませんでした。"))
      .finally(() => setIssuing(false));
  };

  const connectUrl = issued
    ? `atelier-bridge://connect?api=${encodeURIComponent(api.API_BASE)}&token=${encodeURIComponent(issued.token)}`
    : null;
  const command = issued
    ? `ATELIER_API_URL=${api.API_BASE} ATELIER_BRIDGE_TOKEN=${issued.token} node dist/headless.js --loop`
    : null;
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="rounded-md border border-border bg-surface-variant/50 p-3">
      <p className="text-[12px] font-bold text-on-surface">接続の手順</p>
      <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11.5px] leading-[1.6] text-on-surface-variant">
        <li>
          接続アプリ (Atelier Bridge) をインストール (
          <a
            href={BRIDGE_RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-primary underline underline-offset-2"
          >
            ダウンロード — Mac / Windows / Linux
          </a>
          )
        </li>
        <li>下の「接続トークンを発行」→「アプリで接続」を押す</li>
        <li>この表示が「接続中」になれば完了</li>
      </ol>

      {issued === null ? (
        <button
          type="button"
          onClick={issue}
          disabled={issuing}
          className="mt-2 inline-flex h-8 items-center rounded-md bg-primary px-3 text-[12px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
        >
          {issuing ? "発行中…" : "接続トークンを発行"}
        </button>
      ) : (
        <div className="mt-2 space-y-2">
          {connectUrl ? (
            <a
              href={connectUrl}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[12px] font-semibold text-on-primary hover:bg-primary-hover"
            >
              アプリで接続
            </a>
          ) : null}
          <p className="text-[10.5px] leading-[1.5] text-on-surface-variant">
            アプリが開かない場合は、下のコマンドをターミナルに貼り付けても接続できます
            (トークンはこの画面でのみ表示されます — 再表示はできません)。
          </p>
          {command ? (
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-sm bg-white px-2 py-1 font-mono text-[10.5px] text-on-surface">
                {command}
              </code>
              <button
                type="button"
                onClick={() => copy(command)}
                aria-label="起動コマンドをコピー"
                className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border bg-white px-2 py-1 text-[11px] font-semibold text-on-surface hover:bg-surface-variant"
              >
                {copied ? (
                  <Check size={11} aria-hidden="true" />
                ) : (
                  <Copy size={11} aria-hidden="true" />
                )}
                {copied ? "コピー済み" : "コピー"}
              </button>
            </div>
          ) : null}
        </div>
      )}
      {issueError ? (
        <p role="alert" className="mt-1.5 text-[11px] font-semibold text-error">
          {issueError}
        </p>
      ) : null}
      <p className="mt-1.5 text-[10.5px] leading-[1.5] text-on-surface-variant">
        トークンはあなた専用です (チャット接続のみに有効・いつでも失効可能)。あなたの
        Claude 認証情報がこの PC の外へ送られることはありません。
      </p>
    </div>
  );
}
