/**
 * S-T02 スキル管理 — T-UC-42 (F-007 SKILL.md 管理)
 *
 * 運営(admin)が SKILL.md ドキュメント (name / version / content_md / description /
 * is_active / allowed_employee_roles) を CRUD し、AI 社員へ装着する。
 * 実 skills API (/admin/skills) に TanStack Query で配線。
 *
 * admin gate: いずれかの admin API が 403 を返したら AdminDenied を表示する。
 *
 * api client は prop 注入可能 (テスト時に fake を渡せる)。未指定時は
 * createAuthedApiClient() で cookie JWT を載せた本物の client を構築する。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { AdminButton } from "../../_components/AdminButton";
import { Dialog } from "../../../../components/ui/dialog";
import { AdminDenied } from "../../_components/AdminDenied";
import { SkillForm, type SkillFormSubmit } from "./SkillForm";

interface AdminSkill {
  id?: string;
  name?: string;
  version?: string;
  description?: string | null;
  content_md?: string;
  allowed_employee_roles?: string[];
  is_active?: boolean;
}

const SKILLS_KEY = ["admin", "skills"] as const;

export interface SkillManagerProps {
  /** テスト時に fake client を注入。未指定なら cookie JWT 付き本物 client */
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function SkillManager({ client: injected }: SkillManagerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();

  const [dialog, setDialog] = useState<{
    mode: "create" | "edit";
    skill?: AdminSkill;
  } | null>(null);
  const [attachFor, setAttachFor] = useState<AdminSkill | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [query, setQuery] = useState("");

  const list = useQuery({
    queryKey: SKILLS_KEY,
    queryFn: async () => {
      const res = await client.get("/admin/skills", {
        params: { query: { include_inactive: true } },
      });
      return (res as { data?: AdminSkill[] }).data ?? [];
    },
    retry: false,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: SKILLS_KEY });

  const createMut = useMutation({
    mutationFn: (v: SkillFormSubmit) =>
      client.post("/admin/skills", {
        body: {
          name: v.name,
          version: v.version,
          content_md: v.content_md,
          description: v.description,
          allowed_employee_roles: v.allowed_employee_roles,
          is_active: v.is_active,
        },
      }),
    onSuccess: () => {
      setDialog(null);
      void invalidate();
    },
  });

  const updateMut = useMutation({
    mutationFn: (args: { id: string; v: SkillFormSubmit }) =>
      client.patch("/admin/skills/{skill_id}", {
        params: { path: { skill_id: args.id } },
        body: {
          content_md: args.v.content_md,
          description: args.v.description,
          allowed_employee_roles: args.v.allowed_employee_roles,
          is_active: args.v.is_active,
        },
      }),
    onSuccess: () => {
      setDialog(null);
      void invalidate();
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      client.delete("/admin/skills/{skill_id}", {
        params: { path: { skill_id: id } },
      }),
    onSuccess: () => void invalidate(),
  });

  const attachMut = useMutation({
    mutationFn: (args: { id: string; ai_employee_id: string }) =>
      client.post("/admin/skills/{skill_id}/attach", {
        params: { path: { skill_id: args.id } },
        body: { ai_employee_id: args.ai_employee_id, attached: true },
      }),
    onSuccess: () => {
      setAttachFor(null);
      setEmployeeId("");
      void invalidate();
    },
  });

  if (isForbidden(list.error)) return <AdminDenied />;

  const skills = list.data ?? [];
  const activeCount = skills.filter((s) => s.is_active).length;
  const inactiveCount = skills.length - activeCount;
  const q = query.trim().toLowerCase();
  const visible = q
    ? skills.filter((s) =>
        `${s.name ?? ""} ${s.description ?? ""}`.toLowerCase().includes(q),
      )
    : skills;

  const ROW_GRID =
    "grid grid-cols-[minmax(0,1fr)_80px_minmax(120px,200px)_110px_auto] items-center gap-4";

  return (
    <section className="flex flex-col gap-6">
      {/* ── ヘッダー ── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
            Skill Management
          </div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-on-surface">
            スキル管理
          </h1>
          <p className="mt-1 text-body-md text-on-surface-variant">
            ユーザー側ではスキルの中身は編集できません。運営側で一括管理します。
          </p>
        </div>
        <AdminButton
          variant="primary"
          onClick={() => setDialog({ mode: "create" })}
        >
          新規アップロード
        </AdminButton>
      </div>

      {/* ── 統計カード ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-white p-5">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
            登録スキル
          </div>
          <div className="mt-1 text-3xl font-bold tabular-nums text-on-surface">
            {skills.length}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-white p-5">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
            有効
          </div>
          <div className="mt-1 text-3xl font-bold tabular-nums text-tertiary">
            {activeCount}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-white p-5">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
            無効
          </div>
          <div className="mt-1 text-3xl font-bold tabular-nums text-on-surface">
            {inactiveCount}
          </div>
        </div>
      </div>

      {/* ── アップロードゾーン ── */}
      <button
        type="button"
        onClick={() => setDialog({ mode: "create" })}
        className="rounded-lg border-2 border-dashed border-border bg-white px-6 py-7 text-center transition-colors hover:border-primary hover:bg-primary-container"
      >
        <div className="text-base font-bold text-on-surface">
          スキルファイルをドロップ
        </div>
        <p className="mt-1 text-body-sm text-on-surface-variant">
          SKILL.md + assets/ フォルダ · YAML frontmatter 付き ·
          既存スキルは新バージョンとして登録
        </p>
      </button>

      {/* ── スキル一覧カード ── */}
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <div className="flex items-center justify-between gap-2 border-b border-border px-[18px] py-3">
          <h2 className="text-base font-bold tracking-tight text-on-surface">
            スキル一覧
          </h2>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="検索..."
            aria-label="スキルを検索"
            className="h-9 w-60 rounded-md border border-border bg-surface px-3 text-body-sm text-on-surface placeholder:text-on-surface-variant focus-visible:border-primary focus-visible:outline-none"
          />
        </div>

        {list.isLoading ? (
          <Loading className="py-md" />
        ) : skills.length === 0 ? (
          <p className="px-[18px] py-12 text-center text-body-md text-on-surface-variant">
            スキルがありません
          </p>
        ) : (
          <>
            <div
              className={`${ROW_GRID} bg-surface-variant px-[18px] py-3 text-[10.5px] font-bold uppercase tracking-[0.06em] text-on-surface-variant`}
            >
              <div>スキル名 / 説明</div>
              <div>Version</div>
              <div>許可ロール</div>
              <div>有効</div>
              <div className="text-right">操作</div>
            </div>

            {visible.length === 0 ? (
              <p className="px-[18px] py-12 text-center text-body-md text-on-surface-variant">
                該当するスキルがありません
              </p>
            ) : (
              visible.map((s) => {
                const roles = s.allowed_employee_roles ?? [];
                return (
                  <div
                    key={s.id}
                    className={`${ROW_GRID} border-b border-border px-[18px] py-[14px] transition-colors hover:bg-surface-variant ${
                      s.is_active ? "" : "opacity-60"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[13.5px] font-bold text-on-surface">
                        {s.name}
                      </div>
                      {s.description ? (
                        <div className="mt-0.5 truncate text-[11.5px] text-on-surface-variant">
                          {s.description}
                        </div>
                      ) : null}
                    </div>
                    <div>
                      <span
                        className={`inline-flex items-center rounded-sm px-2 py-0.5 text-[10.5px] font-semibold ${
                          s.is_active
                            ? "bg-primary-container text-primary-container-fg"
                            : "bg-surface-variant text-on-surface-variant"
                        }`}
                      >
                        v{s.version}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {roles.length > 0 ? (
                        roles.map((r) => (
                          <span
                            key={r}
                            className="inline-flex items-center gap-1 rounded-sm bg-surface-variant px-2 py-0.5 text-[10.5px] font-semibold text-on-surface-variant"
                          >
                            {r}
                          </span>
                        ))
                      ) : (
                        <span className="inline-flex items-center rounded-sm bg-surface-variant px-2 py-0.5 text-[10.5px] font-semibold text-on-surface-variant">
                          —
                        </span>
                      )}
                    </div>
                    <div>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                          s.is_active
                            ? "bg-tertiary-container text-tertiary-container-fg"
                            : "bg-[#FEE2E2] text-[#991B1B]"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            s.is_active ? "bg-tertiary" : "bg-error"
                          }`}
                        />
                        {s.is_active ? "active" : "disabled"}
                      </span>
                    </div>
                    <div className="flex justify-end gap-xs">
                      <AdminButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setDialog({ mode: "edit", skill: s })}
                      >
                        編集
                      </AdminButton>
                      <AdminButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setAttachFor(s)}
                      >
                        装着
                      </AdminButton>
                      <AdminButton
                        variant="ghost"
                        size="sm"
                        aria-label={`${s.name} を削除`}
                        onClick={() => s.id && deleteMut.mutate(s.id)}
                      >
                        削除
                      </AdminButton>
                    </div>
                  </div>
                );
              })
            )}

            <div className="px-[18px] py-3 text-center text-body-sm text-on-surface-variant">
              全 {skills.length} 件
            </div>
          </>
        )}
      </div>

      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog?.mode === "edit" ? "スキル編集" : "新規スキル登録"}
        className="max-w-2xl"
      >
        {dialog ? (
          <SkillForm
            mode={dialog.mode}
            defaultValues={
              dialog.skill
                ? {
                    name: dialog.skill.name,
                    version: dialog.skill.version,
                    description: dialog.skill.description ?? "",
                    content_md: dialog.skill.content_md,
                    allowed_employee_roles: (
                      dialog.skill.allowed_employee_roles ?? []
                    ).join(", "),
                    is_active: dialog.skill.is_active,
                  }
                : undefined
            }
            submitting={createMut.isPending || updateMut.isPending}
            onCancel={() => setDialog(null)}
            onSubmit={(v) => {
              if (dialog.mode === "edit" && dialog.skill?.id) {
                updateMut.mutate({ id: dialog.skill.id, v });
              } else {
                createMut.mutate(v);
              }
            }}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={attachFor !== null}
        onClose={() => setAttachFor(null)}
        title="AI 社員へ装着"
        footer={
          <>
            <AdminButton variant="ghost" onClick={() => setAttachFor(null)}>
              キャンセル
            </AdminButton>
            <AdminButton
              variant="primary"
              disabled={!employeeId || attachMut.isPending}
              onClick={() =>
                attachFor?.id &&
                attachMut.mutate({
                  id: attachFor.id,
                  ai_employee_id: employeeId,
                })
              }
            >
              装着する
            </AdminButton>
          </>
        }
      >
        <label className="flex flex-col gap-xs">
          <span className="text-label-lg font-semibold text-on-surface">
            AI 社員 ID
          </span>
          <input
            type="text"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="h-10 rounded-md border border-border bg-surface px-sm text-body-md text-on-surface"
          />
        </label>
      </Dialog>
    </section>
  );
}
