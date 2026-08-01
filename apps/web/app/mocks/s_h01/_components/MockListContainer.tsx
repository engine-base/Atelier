/**
 * S-H01 モック一覧ピッカー — design-audit v2 (到達不能是正)
 *
 * /mocks に ?mock= 無しで来たとき、現在プロジェクトのモックを GET /mocks で
 * 一覧し、画面ごとの最新バージョンへのリンクカードを出す (以前は案内文のみで
 * どのモックにも到達できなかった)。プロジェクト未選択時は /projects へ誘導する。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import type { ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { Loading } from "../../../../components/Loading";
import { useProjectId } from "../../../../lib/useProjectId";

interface ApiMock {
  id: string;
  screen_name: string;
  version: number;
  updated_at?: string;
}

/** ISO → "YYYY-MM-DD HH:mm" (鉄則: 生 ISO を画面に出さない)。 */
function dateLabel(iso: string | undefined): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "";
}

export interface MockListContainerProps {
  readonly client?: ApiClient;
}

export function MockListContainer({ client: injected }: MockListContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const projectId = useProjectId();

  const mocks = useQuery({
    queryKey: ["mocks", projectId],
    enabled: Boolean(projectId),
    queryFn: async () => {
      const res = await client.get("/mocks", {
        params: { query: { project_id: projectId ?? undefined, limit: 200 } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiMock[]) : [];
    },
    retry: false,
  });

  if (!projectId) {
    return (
      <p className="rounded-lg border border-dashed border-border py-2xl text-center text-body-md text-on-surface-variant">
        プロジェクトを選択するとモック一覧を表示します。{" "}
        <Link href="/projects" className="font-semibold text-primary underline">
          プロジェクト一覧へ
        </Link>
      </p>
    );
  }
  if (mocks.isLoading) return <Loading className="py-md" />;
  if (mocks.error) {
    return (
      <p
        role="alert"
        className="rounded-md border-l-[3px] border-error bg-error/10 px-md py-sm text-body-md text-error"
      >
        モック一覧の取得に失敗しました。
      </p>
    );
  }

  // 画面名ごとに最新バージョンのみを出す (バージョンチェーンは詳細側で辿れる)。
  const latestByScreen = new Map<string, ApiMock>();
  for (const m of mocks.data ?? []) {
    const cur = latestByScreen.get(m.screen_name);
    if (!cur || m.version > cur.version) latestByScreen.set(m.screen_name, m);
  }
  const rows = [...latestByScreen.values()].sort((a, b) =>
    a.screen_name.localeCompare(b.screen_name, "ja"),
  );

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border py-2xl text-center text-body-md text-on-surface-variant">
        このプロジェクトにモックはまだありません。
      </p>
    );
  }

  return (
    <section aria-label="モック一覧">
      <h1 className="mb-md text-headline-md font-bold tracking-tight text-on-surface">
        モック
      </h1>
      <ul
        role="list"
        className="grid grid-cols-1 gap-sm sm:grid-cols-2 lg:grid-cols-3"
      >
        {rows.map((m) => (
          <li key={m.id}>
            <Link
              href={`/mocks?mock=${m.id}`}
              className="block rounded-lg border border-border bg-surface p-md transition-colors hover:border-primary hover:bg-primary-container/30"
            >
              <span className="block text-body-md font-semibold text-on-surface">
                {m.screen_name}
              </span>
              <span className="mt-1 block text-body-sm tabular-nums text-on-surface-variant">
                v{m.version} · {dateLabel(m.updated_at)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
