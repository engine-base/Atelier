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

  return (
    <section className="flex flex-col gap-md">
      <div className="flex items-center justify-between">
        <p className="text-body-md text-on-surface-variant">
          ユーザー側ではスキルの中身は編集できません。運営側で一括管理します。
        </p>
        <AdminButton
          variant="primary"
          onClick={() => setDialog({ mode: "create" })}
        >
          新規アップロード
        </AdminButton>
      </div>

      {list.isLoading ? (
        <Loading className="py-md" />
      ) : skills.length === 0 ? (
        <p className="text-body-md text-on-surface-variant">
          スキルがありません
        </p>
      ) : (
        <table className="w-full border-collapse">
          <caption className="sr-only">スキル一覧</caption>
          <thead>
            <tr className="border-b border-surface-variant text-left text-label-md text-on-surface-variant">
              <th className="py-sm">スキル名 / 説明</th>
              <th className="py-sm">Version</th>
              <th className="py-sm">許可ロール</th>
              <th className="py-sm">有効</th>
              <th className="py-sm text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => (
              <tr key={s.id} className="border-b border-surface-variant/60">
                <td className="py-sm">
                  <div className="font-mono font-bold text-on-surface">
                    {s.name}
                  </div>
                  {s.description ? (
                    <div className="text-label-md text-on-surface-variant">
                      {s.description}
                    </div>
                  ) : null}
                </td>
                <td className="py-sm text-body-md">v{s.version}</td>
                <td className="py-sm text-label-md">
                  {(s.allowed_employee_roles ?? []).join(", ") || "—"}
                </td>
                <td className="py-sm text-label-md">
                  {s.is_active ? "active" : "disabled"}
                </td>
                <td className="py-sm text-right">
                  <div className="inline-flex gap-xs">
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

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
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </label>
      </Dialog>
    </section>
  );
}
