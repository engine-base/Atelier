/**
 * S-E01 Claude 接続状態チップ + 詳細パネル (GAP-119)
 *
 * GET /chat/connection-status の実測値のみで構成する (誠実設計):
 *   - 実行モード (relay / agent_sdk / api / fake / unconfigured)
 *   - Bridge presence (90 秒鮮度) — relay モードの生死
 *   - 本人の直近 relay 実行 (chat_relay_jobs — RLS 本人のみ)
 *   - 本人プラン枠 (5 時間 / 7 日) — claude CLI が rate_limit_event で
 *     報告した実値のみ。未観測の値はバー自体を出さない (推測で埋めない)。
 *
 * relay 未接続時は接続フロー (Bridge 起動手順 + コマンドコピー) を表示する。
 */

"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Plug, RefreshCw, X } from "lucide-react";

import * as api from "../../../../lib/auth/connector";
import { cn } from "../../../../lib/cn";

export interface ConnectionWorker {
  readonly host_label: string;
  readonly version: string;
  readonly last_seen_at: string;
}

export interface ConnectionLastJob {
  readonly status: string;
  readonly error: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

export interface ConnectionPlan {
  readonly status: "allowed" | "allowed_warning" | "rejected";
  readonly five_hour_utilization: number | null;
  readonly five_hour_resets_at: string | null;
  readonly seven_day_utilization: number | null;
  readonly seven_day_resets_at: string | null;
  readonly observed_at: string;
}

export interface ConnectionStatus {
  readonly mode: "relay" | "agent_sdk" | "api" | "fake" | "unconfigured";
  readonly bridge_online: boolean;
  readonly workers: readonly ConnectionWorker[];
  readonly last_job: ConnectionLastJob | null;
  readonly plan: ConnectionPlan | null;
}

const MODE_LABEL: Record<ConnectionStatus["mode"], string> = {
  relay: "自分の Claude プランで実行",
  agent_sdk: "オーナーの Claude プランで実行",
  api: "API キーで実行 (従量課金)",
  fake: "開発用ダミー応答",
  unconfigured: "LLM 未接続",
};

const MODE_DETAIL: Record<ConnectionStatus["mode"], string> = {
  relay:
    "チャットの実行はあなたの PC の Bridge に中継され、その PC の Claude ログイン (= あなたの月額プラン) で実行されます。プロンプトも実行もあなたの PC 内で完結します。",
  agent_sdk:
    "このインスタンスのオーナーの Claude サブスクリプションで実行されます (セルフホスト個人インスタンス専用モード)。",
  api: "サーバーに設定された API キーで実行されます (Anthropic API 従量課金)。",
  fake: "開発環境のダミー応答です。実際の LLM は呼ばれていません。",
  unconfigured: "LLM の実行手段が設定されていません。チャットは送信できません。",
};

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** プラン枠 1 window のバー。utilization が無い window は呼び出し側で出さない。 */
function PlanBar({
  label,
  utilization,
  resetsAt,
}: {
  readonly label: string;
  readonly utilization: number;
  readonly resetsAt: string | null;
}) {
  const pct = Math.round(utilization * 100);
  const width = Math.min(pct, 100);
  const tone =
    pct >= 90 ? "bg-error" : pct >= 70 ? "bg-secondary" : "bg-primary";
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11.5px]">
        <span className="font-semibold text-on-surface">{label}</span>
        <span className="tabular-nums text-on-surface-variant">
          {pct}% 使用
          {resetsAt ? ` · ${fmtDateTime(resetsAt)} リセット` : ""}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label}の使用率`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-1 h-[6px] overflow-hidden rounded-full bg-surface-variant"
      >
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

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
function ConnectFlow() {
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
          Atelier Bridge アプリをインストール (
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
        <li>この表示が「Bridge 接続中」になれば完了</li>
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

const JOB_STATUS_LABEL: Record<string, string> = {
  queued: "実行待ち",
  running: "実行中",
  done: "成功",
  error: "失敗",
  expired: "タイムアウト",
};

export function ConnectionStatusChip() {
  const [open, setOpen] = React.useState(false);
  const query = useQuery({
    queryKey: ["chat-connection-status"],
    queryFn: async () =>
      (await api.getJson<ConnectionStatus>("/chat/connection-status")).data,
    refetchInterval: 30_000,
    retry: false,
  });
  const status = query.data;

  // チップの状態: relay は presence で生死を出す。他モードはモードのみ
  const chipLabel = !status
    ? "接続状態"
    : status.mode === "relay"
      ? status.bridge_online
        ? "自分のプランで実行"
        : "Bridge 未接続"
      : MODE_LABEL[status.mode];
  const tone = !status
    ? "bg-on-surface-variant"
    : status.mode === "relay"
      ? status.bridge_online
        ? "bg-tertiary"
        : "bg-error"
      : status.mode === "unconfigured"
        ? "bg-error"
        : "bg-tertiary";

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label="Claude 接続状態を確認"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void query.refetch();
        }}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-white px-2.5 text-[11.5px] font-semibold text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface"
      >
        <span aria-hidden="true" className={cn("h-[7px] w-[7px] rounded-full", tone)} />
        <Plug size={12} aria-hidden="true" className="sm:hidden" />
        <span className="hidden sm:inline">{chipLabel}</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Claude 接続状態"
          className="absolute right-0 top-[calc(100%+6px)] z-30 w-[340px] rounded-lg border border-border bg-white p-4 shadow-xl"
        >
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-bold text-on-surface">Claude 接続状態</p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="接続状態を再確認"
                onClick={() => void query.refetch()}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-variant"
              >
                <RefreshCw size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="接続状態パネルを閉じる"
                onClick={() => setOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-variant"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          </div>

          {query.isLoading ? (
            <p className="mt-3 text-[12px] text-on-surface-variant">確認中…</p>
          ) : !status ? (
            <p className="mt-3 text-[12px] text-error">
              接続状態を取得できませんでした。
            </p>
          ) : (
            <div className="mt-3 space-y-3">
              {/* 実行モード */}
              <div>
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn("h-[8px] w-[8px] rounded-full", tone)}
                  />
                  <span className="text-[12.5px] font-bold text-on-surface">
                    {MODE_LABEL[status.mode]}
                  </span>
                </div>
                <p className="mt-1 text-[11.5px] leading-[1.6] text-on-surface-variant">
                  {MODE_DETAIL[status.mode]}
                </p>
              </div>

              {/* Bridge presence (relay のみ) */}
              {status.mode === "relay" ? (
                status.bridge_online ? (
                  <div className="rounded-md border border-border p-2.5">
                    <p className="text-[11.5px] font-bold text-on-surface">
                      Bridge 接続中
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {status.workers.map((w) => (
                        <li
                          key={`${w.host_label}-${w.last_seen_at}`}
                          className="text-[11px] text-on-surface-variant"
                        >
                          {w.host_label} · v{w.version} · 最終応答{" "}
                          {fmtDateTime(w.last_seen_at)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <ConnectFlow />
                )
              ) : null}

              {/* プラン枠 — 観測値があるときのみ (推測で出さない) */}
              {status.plan ? (
                <div className="rounded-md border border-border p-2.5">
                  <p className="text-[11.5px] font-bold text-on-surface">
                    プラン枠の使用状況
                  </p>
                  <div className="mt-2 space-y-2.5">
                    {status.plan.five_hour_utilization !== null ? (
                      <PlanBar
                        label="5 時間枠"
                        utilization={status.plan.five_hour_utilization}
                        resetsAt={status.plan.five_hour_resets_at}
                      />
                    ) : null}
                    {status.plan.seven_day_utilization !== null ? (
                      <PlanBar
                        label="7 日間枠"
                        utilization={status.plan.seven_day_utilization}
                        resetsAt={status.plan.seven_day_resets_at}
                      />
                    ) : null}
                    {status.plan.five_hour_utilization === null &&
                    status.plan.seven_day_utilization === null ? (
                      <p className="text-[11px] text-on-surface-variant">
                        使用率の内訳は未観測です (状態:{" "}
                        {status.plan.status === "rejected"
                          ? "上限到達"
                          : status.plan.status === "allowed_warning"
                            ? "上限接近"
                            : "利用可"}
                        )。
                      </p>
                    ) : null}
                  </div>
                  <p className="mt-2 text-[10.5px] leading-[1.5] text-on-surface-variant">
                    {fmtDateTime(status.plan.observed_at)}
                    のチャット実行時点の観測値です (Claude が実行時に報告した実値のみを表示します)。
                  </p>
                </div>
              ) : status.mode === "relay" ? (
                <p className="text-[11px] leading-[1.6] text-on-surface-variant">
                  プラン枠はまだ計測がありません。チャットを実行すると、Claude
                  が報告した時点の使用率がここに表示されます。
                </p>
              ) : null}

              {/* 直近実行 (relay) */}
              {status.last_job ? (
                <p className="text-[11px] text-on-surface-variant">
                  直近の実行: {JOB_STATUS_LABEL[status.last_job.status] ?? status.last_job.status}
                  {" · "}
                  {fmtDateTime(status.last_job.created_at)}
                  {status.last_job.error ? ` · ${status.last_job.error}` : ""}
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
