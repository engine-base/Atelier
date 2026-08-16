/**
 * S-A03 プランセクション — GAP-021 (モックの「プラン」タブの実体)
 *
 * 誠実設計 (CLAUDE.md):
 *   - GET /billing/plan の実値のみ表示 (行なし = free)。
 *   - stripe_configured=false なら「決済連携が未設定です」を明示し、
 *     アップグレードボタンは出さない (死にボタン・偽の課金成功を置かない)。
 *   - アップグレード → POST /billing/checkout → Stripe Checkout (返却 url) へ遷移。
 *   - ?session_id= 付きで戻ったら GET /billing/checkout/{session_id} で照会し、
 *     paid = 成功 / それ以外 = 未完了をそのまま表示する。
 */

"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { cn } from "../../../../lib/cn";
import { formatDate } from "../../../../lib/i18n";

const CARD = "rounded-lg border border-border bg-white p-5";
const SECTION_TITLE = "text-base font-bold tracking-tight text-on-surface";
const BTN_PRIMARY =
  "inline-flex w-fit items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-label-lg font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50";
const BADGE =
  "inline-flex items-center rounded-sm px-2 py-0.5 text-[10.5px] font-semibold";

interface BillingPlan {
  readonly plan?: "free" | "pro";
  readonly status?: string;
  readonly current_period_end?: string | null;
  readonly stripe_configured?: boolean;
}

interface CheckoutStatus {
  readonly payment_status?: string;
  readonly plan?: "free" | "pro";
}

export interface PlanSectionProps {
  readonly workspaceId: string;
  readonly client: ApiClient;
  /** Stripe checkout から戻った時の ?session_id= (page が渡す)。 */
  readonly checkoutSessionId?: string | null;
  /** テスト用: window.location 遷移の差し替え。 */
  readonly onNavigate?: (url: string) => void;
}

const PLAN_LABEL: Record<"free" | "pro", string> = {
  free: "Free プラン",
  pro: "Atelier Pro",
};

export function PlanSection({
  workspaceId,
  client,
  checkoutSessionId,
  onNavigate,
}: PlanSectionProps) {
  const queryClient = useQueryClient();
  const KEY = ["billing-plan", workspaceId] as const;
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutResult, setCheckoutResult] = useState<CheckoutStatus | null>(
    null,
  );
  const [pollError, setPollError] = useState(false);

  const planQuery = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await client.get("/billing/plan", {
        params: { query: { workspace_id: workspaceId } },
      });
      return ((res as { data?: BillingPlan }).data ?? {}) as BillingPlan;
    },
    retry: false,
  });

  // checkout から戻った直後: session を照会して結果を誠実に反映する
  useEffect(() => {
    if (!checkoutSessionId) return;
    let cancelled = false;
    client
      .get("/billing/checkout/{session_id}", {
        params: { path: { session_id: checkoutSessionId } },
      })
      .then((res) => {
        if (cancelled) return;
        setCheckoutResult(
          ((res as { data?: CheckoutStatus }).data ?? {}) as CheckoutStatus,
        );
        void queryClient.invalidateQueries({ queryKey: KEY });
      })
      .catch(() => {
        if (!cancelled) setPollError(true);
      });
    return () => {
      cancelled = true;
    };
    // KEY は workspaceId から導出されるため依存は下記で十分
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutSessionId, workspaceId, client]);

  const upgradeMut = useMutation({
    mutationFn: async () => {
      const res = await client.post("/billing/checkout", {
        body: { workspace_id: workspaceId },
      });
      return ((res as { data?: { url?: string } }).data ?? {}) as {
        url?: string;
      };
    },
    onSuccess: (data) => {
      if (!data.url) {
        setCheckoutError("決済ページの URL を取得できませんでした。");
        return;
      }
      (onNavigate ?? ((url: string) => window.location.assign(url)))(data.url);
    },
    onError: (err) => {
      setCheckoutError(
        err instanceof ApiError && err.status === 503
          ? "決済連携が未設定のためアップグレードできません。"
          : "決済ページの作成に失敗しました。時間をおいて再度お試しください。",
      );
    },
  });

  const plan = planQuery.data;

  return (
    <section id="ws-plan" className={cn(CARD, "md:col-span-2")} aria-label="プラン">
      <h2 className={cn(SECTION_TITLE, "mb-4")}>プラン</h2>

      {/* checkout 戻りの照会結果 (成功 / 未完了を誠実表示) */}
      {checkoutSessionId ? (
        pollError ? (
          <p role="alert" className="mb-4 text-body-sm text-error">
            決済結果の確認に失敗しました。ページを再読み込みしてください。
          </p>
        ) : checkoutResult ? (
          checkoutResult.payment_status === "paid" ? (
            <p
              role="status"
              className="mb-4 rounded-md border-l-[3px] border-primary bg-primary-container p-3 text-body-sm text-on-primary-container"
            >
              <strong className="font-bold">決済が完了しました。</strong>{" "}
              このワークスペースは {PLAN_LABEL.pro} になりました。
            </p>
          ) : (
            <p
              role="status"
              className="mb-4 rounded-md border border-border bg-surface p-3 text-body-sm text-on-surface-variant"
            >
              決済はまだ完了していません（状態:{" "}
              {checkoutResult.payment_status ?? "不明"}）。完了している場合は
              反映まで少し時間がかかることがあります。
            </p>
          )
        ) : (
          <p className="mb-4 text-body-sm text-on-surface-variant">
            決済結果を確認中…
          </p>
        )
      ) : null}

      {planQuery.isError ? (
        <p role="alert" className="text-body-sm text-error">
          プラン情報の取得に失敗しました。
        </p>
      ) : planQuery.isLoading || !plan ? (
        <p className="text-body-sm text-on-surface-variant">読み込み中…</p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* 現在プランカード */}
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-base font-bold text-on-surface">
                  {PLAN_LABEL[plan.plan ?? "free"]}
                </span>
                <span
                  className={cn(
                    BADGE,
                    plan.plan === "pro"
                      ? "bg-primary-container text-on-primary-container"
                      : "bg-surface-variant text-on-surface-variant",
                  )}
                >
                  {plan.status ?? "inactive"}
                </span>
              </div>
              <p className="mt-1 text-body-sm text-on-surface-variant">
                {plan.plan === "pro"
                  ? plan.current_period_end
                    ? `現在の請求期間: ${formatDate(plan.current_period_end)} まで`
                    : "月額 ¥5,000 (税込) / ワークスペース"
                  : "無料プラン。Pro にすると全機能が利用できます (月額 ¥5,000)。"}
              </p>
            </div>
          </div>

          {plan.stripe_configured === false ? (
            // 誠実設計: 未設定環境では偽の導線を出さず、状態を明示する
            <p className="rounded-md border border-border bg-surface p-3 text-body-sm text-on-surface-variant">
              決済連携が未設定です。管理者が STRIPE_SECRET_KEY
              を設定するとアップグレードできるようになります。
            </p>
          ) : plan.plan !== "pro" ? (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  setCheckoutError(null);
                  upgradeMut.mutate();
                }}
                disabled={upgradeMut.isPending}
                className={BTN_PRIMARY}
              >
                {upgradeMut.isPending ? "決済ページへ移動中…" : "Pro にアップグレード"}
              </button>
              <p className="text-body-sm text-on-surface-variant">
                Stripe の決済ページに移動します（テストモード）。
              </p>
              {checkoutError ? (
                <p role="alert" className="text-body-sm text-error">
                  {checkoutError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
