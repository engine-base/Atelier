/**
 * S-H01 モック一覧ピッカー — design-audit v2 (到達不能是正)
 *
 * /mocks に ?mock= 無しで来たとき、現在プロジェクトのモックを GET /mocks で
 * 一覧し、画面ごとの最新バージョンへのリンクカードを出す (以前は案内文のみで
 * どのモックにも到達できなかった)。プロジェクト未選択時は /projects へ誘導する。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { useSelectedPhase } from "../../../../lib/currentPhase";
import { Loading } from "../../../../components/Loading";
import { useProjectId } from "../../../../lib/useProjectId";
import { MockCanvas } from "./MockCanvas";

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

function generateErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return "AI 実行経路が使えません (Bridge がオフラインの可能性)。Bridge を起動して再試行してください。";
  }
  return "モックの生成に失敗しました。時間をおいて再試行してください。";
}

export function MockListContainer({ client: injected }: MockListContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const projectId = useProjectId();
  const router = useRouter();
  const queryClient = useQueryClient();
  // GAP-138: 一覧/キャンバスの切替 + 新規モック作成フォーム
  const [view, setView] = useState<"list" | "canvas">("list");
  const [createOpen, setCreateOpen] = useState(false);
  const [screenName, setScreenName] = useState("");
  const [instruction, setInstruction] = useState("");
  // GAP-143: デザインノート (DESIGN.md 相当) — ワンダの全生成・改訂に自動注入
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);

  const designNote = useQuery({
    queryKey: ["design-note", projectId],
    enabled: Boolean(projectId) && noteOpen,
    queryFn: async () => {
      const res = await client.get("/projects/{project_id}/design-note", {
        params: { path: { project_id: projectId ?? "" } },
      });
      return (res as { data?: { note?: string } }).data?.note ?? "";
    },
    retry: false,
  });
  const saveNote = useMutation({
    retry: false,
    mutationFn: async (note: string) => {
      await client.put("/projects/{project_id}/design-note", {
        params: { path: { project_id: projectId ?? "" } },
        body: { note },
      });
      return note;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["design-note", projectId] });
      setNoteOpen(false);
      setNoteDraft(null);
    },
  });

  const generate = useMutation({
    // Bridge オフライン (503) は自動再試行しても直らない — 即時に誠実表示する
    retry: false,
    mutationFn: async () => {
      const res = await client.post("/mocks/generate", {
        body: {
          project_id: projectId ?? "",
          instruction: instruction.trim(),
          ...(screenName.trim() !== "" ? { screen_name: screenName.trim() } : {}),
        },
      });
      return (res as { data?: { id?: string } }).data ?? null;
    },
    onSuccess: (created) => {
      setCreateOpen(false);
      setScreenName("");
      setInstruction("");
      void queryClient.invalidateQueries({ queryKey: ["mocks"] });
      if (created?.id) router.push(`/mocks?mock=${created.id}`);
    },
  });

  // GAP-157: フェーズはヘッダーのスイッチャーで全体切替 — 一覧はそれに追従し、
  // 確定フェーズ選択時はそのスナップショットだけを表示する
  const selectedPhaseId = useSelectedPhase(projectId ?? null);
  const phasesQuery = useQuery({
    queryKey: ["delivery-phases", projectId],
    enabled: Boolean(projectId),
    queryFn: async () => {
      const res = await client.get("/projects/{project_id}/delivery-phases", {
        params: { path: { project_id: projectId ?? "" } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d)
        ? (d as {
            id: string;
            name: string;
            status: string;
            mock_count: number;
          }[])
        : [];
    },
    retry: false,
  });
  const phases = phasesQuery.data ?? [];
  const viewingFrozen = phases.find(
    (p) => p.id === selectedPhaseId && p.status === "frozen",
  );
  const phaseFilter = viewingFrozen?.id ?? "";

  const mocks = useQuery({
    queryKey: ["mocks", projectId, phaseFilter],
    enabled: Boolean(projectId),
    queryFn: async () => {
      const res = await client.get("/mocks", {
        params: {
          query: {
            project_id: projectId ?? undefined,
            ...(phaseFilter !== ""
              ? { delivery_phase_id: phaseFilter }
              : {}),
            limit: 200,
          },
        },
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

  return (
    <section aria-label="モック一覧">
      <div className="mb-md flex flex-wrap items-center gap-2">
        <h1 className="text-headline-md font-bold tracking-tight text-on-surface">
          モック
        </h1>
        {/* GAP-157: 確定フェーズ閲覧中の明示 (切替はヘッダーのフェーズスイッチャー) */}
        {viewingFrozen ? (
          <span className="ml-2 inline-flex items-center rounded-full bg-surface-variant px-2.5 py-1 text-[11.5px] font-semibold text-on-surface-variant">
            {viewingFrozen.name} ✓確定 のスナップショットを表示中
          </span>
        ) : null}
        {/* GAP-165: 修正できないのではなく、修正すると現在フェーズの新版になる */}
        {viewingFrozen ? (
          <span className="ml-2 text-[11px] text-on-surface-variant">
            修正はできます（新しい版は現在のフェーズの作業になります）
          </span>
        ) : null}
        {/* GAP-138: 一覧/キャンバス切替 (キャンバス = 全画面を俯瞰 + その場で編集) */}
        <div role="group" aria-label="表示切替" className="ml-auto flex rounded-md border border-border">
          <button
            type="button"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
            className={`px-3 py-1 text-body-sm ${view === "list" ? "bg-primary text-on-primary" : "text-on-surface-variant hover:bg-surface-variant"} rounded-l-[5px]`}
          >
            一覧
          </button>
          <button
            type="button"
            aria-pressed={view === "canvas"}
            onClick={() => setView("canvas")}
            className={`px-3 py-1 text-body-sm ${view === "canvas" ? "bg-primary text-on-primary" : "text-on-surface-variant hover:bg-surface-variant"} rounded-r-[5px]`}
          >
            キャンバス
          </button>
        </div>
        <button
          type="button"
          onClick={() => setNoteOpen((v) => !v)}
          aria-expanded={noteOpen}
          className="rounded-md border border-border px-3 py-1.5 text-body-sm font-semibold text-on-surface hover:border-primary hover:text-primary"
        >
          デザインノート
        </button>
        <button
          type="button"
          onClick={() => setCreateOpen((v) => !v)}
          aria-expanded={createOpen}
          className="rounded-md bg-primary px-3 py-1.5 text-body-sm font-semibold text-on-primary hover:opacity-90"
        >
          新規モック
        </button>
      </div>

      {/* GAP-143: デザインノート (Open Design の DESIGN.md 相当) */}
      {noteOpen ? (
        <form
          aria-label="デザインノート"
          className="mb-md rounded-lg border border-border bg-surface p-md"
          onSubmit={(e) => {
            e.preventDefault();
            if (!saveNote.isPending)
              saveNote.mutate(noteDraft ?? designNote.data ?? "");
          }}
        >
          <p className="mb-1 text-body-sm font-semibold text-on-surface">
            このプロジェクトのデザインノート
          </p>
          <p className="mb-2 text-[11.5px] text-on-surface-variant">
            ワンダの全生成・改訂に自動で反映されます。修正指示から学んだ決定
            (色・フォント・トーン等) も自動で追記されていきます。
          </p>
          <textarea
            value={noteDraft ?? designNote.data ?? ""}
            onChange={(e) => setNoteDraft(e.target.value)}
            rows={6}
            maxLength={2000}
            disabled={designNote.isLoading}
            placeholder={
              "例:\n- メインカラー #1e3a5f / アクセント #f59e0b\n- フォントは Noto Sans JP、余白ゆったり\n- トーンは信頼感のある B2B"
            }
            aria-label="デザインノート本文"
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12.5px] text-on-surface"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="submit"
              disabled={saveNote.isPending || designNote.isLoading}
              className="rounded-md bg-primary px-4 py-1.5 text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50"
            >
              {saveNote.isPending ? "保存中…" : "保存"}
            </button>
            {designNote.error ? (
              <span role="alert" className="text-body-sm text-error">
                ノートの取得に失敗しました。
              </span>
            ) : null}
            {saveNote.error ? (
              <span role="alert" className="text-body-sm text-error">
                保存に失敗しました。
              </span>
            ) : null}
          </div>
        </form>
      ) : null}

      {/* GAP-138: 新規モック = ワンダ (AI デザイナー) による生成 (Open Design パターン) */}
      {createOpen ? (
        <form
          aria-label="新規モック作成"
          className="mb-md rounded-lg border border-border bg-surface p-md"
          onSubmit={(e) => {
            e.preventDefault();
            if (instruction.trim() !== "" && !generate.isPending) generate.mutate();
          }}
        >
          <div className="grid gap-sm sm:grid-cols-[240px_1fr]">
            <label className="text-body-sm text-on-surface-variant">
              画面名 (省略可)
              <input
                value={screenName}
                onChange={(e) => setScreenName(e.target.value)}
                maxLength={80}
                placeholder="例: LP トップ"
                className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-body-md text-on-surface"
              />
            </label>
            <label className="text-body-sm text-on-surface-variant">
              ワンダへの作成指示
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={3}
                maxLength={4000}
                placeholder="例: タスク管理 SaaS の LP。ヒーロー + 3 つの特徴 + 料金表 + CTA"
                className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-body-md text-on-surface"
              />
            </label>
          </div>
          <div className="mt-sm flex items-center gap-2">
            <button
              type="submit"
              disabled={generate.isPending || instruction.trim() === ""}
              className="rounded-md bg-primary px-4 py-1.5 text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50"
            >
              {generate.isPending ? "ワンダが作成中…" : "生成する"}
            </button>
            <span className="text-body-sm text-on-surface-variant">
              あなたの Claude プラン (Bridge) で生成されます
            </span>
            {generate.error ? (
              <span role="alert" className="text-body-sm text-error">
                {generateErrorMessage(generate.error)}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-2xl text-center text-body-md text-on-surface-variant">
          このプロジェクトにモックはまだありません。「新規モック」からワンダに作成を依頼できます。
        </p>
      ) : view === "canvas" ? (
        <MockCanvas mocks={rows} client={client} />
      ) : (
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
      )}
    </section>
  );
}
