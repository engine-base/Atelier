/**
 * S-G01 成果物ピッカー (GAP-302 / 通し J46-19)
 *
 * ?output= が無いときに、現在の案件の成果物 (stage 毎の最新版) を一覧して選べるようにする。
 * 0 件なら「まだ成果物がありません」と案内する (空を黙って出さない)。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import type { ApiClient } from "@atelier/api-client";

import { Loading } from "../../../../components/Loading";
import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { useProjectId } from "../../../../lib/useProjectId";

export const STAGE_LABEL: Readonly<Record<string, string>> = {
  proposal: "提案書",
  estimate: "見積書",
  hearing: "ヒアリングサマリー",
  requirements: "要件定義書",
  architecture: "アーキテクチャ設計",
  design: "デザイン",
  breakdown: "機能分解",
  tasks: "タスク一覧",
  implementation: "実装進捗レポート",
  verification: "検証レポート",
  delivery: "納品書",
  contract: "契約書",
  nda: "NDA",
  invoice: "請求書",
};

interface OutputRow {
  readonly id: string;
  readonly stage: string;
  readonly version: number;
  readonly summary?: string | null;
  readonly updated_at?: string;
  readonly created_at?: string;
}

export interface OutputPickerProps {
  readonly client?: ApiClient;
  readonly projectId?: string | null;
}

export function OutputPicker({ client: injected, projectId: injectedProject }: OutputPickerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const currentProject = useProjectId();
  const projectId = injectedProject !== undefined ? injectedProject : currentProject;

  const query = useQuery({
    queryKey: ["outputs", "picker", projectId],
    queryFn: async () => {
      const res = await client.get("/outputs", {
        params: { query: { project_id: projectId as string } },
      });
      return ((res as { data?: OutputRow[] }).data ?? []) as OutputRow[];
    },
    enabled: Boolean(projectId),
    retry: false,
  });

  if (!projectId) {
    return (
      <p className="text-body-md text-on-surface-variant">
        案件を選ぶと、その案件の成果物をここに一覧します。
      </p>
    );
  }
  if (query.isPending) return <Loading message="成果物を読み込み中" />;
  if (query.isError) {
    return (
      <p role="alert" className="text-body-md text-error">
        成果物の一覧を取得できませんでした。時間をおいてもう一度お試しください。
      </p>
    );
  }
  // stage 毎の最新版だけ
  const latest = new Map<string, OutputRow>();
  for (const o of query.data) {
    const cur = latest.get(o.stage);
    if (!cur || o.version > cur.version) latest.set(o.stage, o);
  }
  const rows = [...latest.values()].sort((a, b) =>
    (b.updated_at ?? b.created_at ?? "").localeCompare(a.updated_at ?? a.created_at ?? ""),
  );
  if (rows.length === 0) {
    return (
      <p className="text-body-md text-on-surface-variant">
        この案件にはまだ成果物がありません。工程を進めるかチャットで作成すると、ここに並びます。
      </p>
    );
  }
  return (
    <section aria-label="成果物を選ぶ">
      <h2 className="mb-3 text-base font-bold text-on-surface">成果物を選ぶ</h2>
      <ul className="divide-y divide-border rounded-lg border border-border bg-white">
        {rows.map((o) => (
          <li key={o.id}>
            <Link
              href={`/outputs?output=${o.id}`}
              className="flex items-center gap-3 px-4 py-3 hover:bg-surface-variant"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-on-surface">
                  {STAGE_LABEL[o.stage] ?? o.stage}
                </span>
                <span className="block truncate text-[11.5px] text-on-surface-variant">
                  v{o.version}
                  {o.summary ? ` · ${o.summary}` : ""}
                </span>
              </span>
              <span className="text-[12px] font-semibold text-primary">開く</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
