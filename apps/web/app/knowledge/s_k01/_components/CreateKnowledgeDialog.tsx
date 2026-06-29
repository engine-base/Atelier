/**
 * CreateKnowledgeDialog — S-K01 ナレッジ作成フォーム (T-UC-43 / F-024)
 *
 * workspace member が現在の scope にナレッジを追加する。送信時に
 * POST /knowledge (account_type=workspace, account_id=workspaceId, scope=現在の scope,
 * source_type=manual, visible_in_tree=true) を呼ぶ。成功で親が list を invalidate する。
 */

"use client";

import * as React from "react";
import { useState } from "react";

import { Dialog } from "../../../../components/ui/dialog";
import { Field } from "../../../../components/forms/Field";
import { KbButton } from "./ui";
import type { KnowledgeScope } from "./types";

export interface KnowledgeDraft {
  readonly title: string;
  readonly category: string;
  readonly content_md: string;
}

export interface CreateKnowledgeDialogProps {
  readonly open: boolean;
  readonly scope: KnowledgeScope;
  readonly submitting: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (draft: KnowledgeDraft) => void;
}

const SCOPE_LABEL: Record<KnowledgeScope, string> = {
  common: "共通",
  employee_specific: "AI社員別",
  project: "プロジェクト別",
};

export function CreateKnowledgeDialog({
  open,
  scope,
  submitting,
  onClose,
  onSubmit,
}: CreateKnowledgeDialogProps) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [content, setContent] = useState("");

  const reset = () => {
    setTitle("");
    setCategory("");
    setContent("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = () => {
    onSubmit({ title, category, content_md: content });
    reset();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={`ナレッジを追加（${SCOPE_LABEL[scope]}）`}
      className="max-w-2xl"
      footer={
        <>
          <KbButton variant="ghost" onClick={handleClose}>
            キャンセル
          </KbButton>
          <KbButton
            variant="primary"
            disabled={!title || !category || !content || submitting}
            onClick={handleSubmit}
          >
            追加する
          </KbButton>
        </>
      }
    >
      <div className="flex flex-col gap-md">
        <Field label="タイトル" required>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </Field>
        <Field label="カテゴリ" required>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </Field>
        <Field label="本文 (Markdown)" required>
          <textarea
            rows={8}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="rounded-md border border-surface-variant bg-surface px-sm py-sm font-mono text-body-md text-on-surface"
          />
        </Field>
      </div>
    </Dialog>
  );
}
