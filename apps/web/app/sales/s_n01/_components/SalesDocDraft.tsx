/**
 * S-N01 商談ドラフト — T-UC-24
 *
 * 商談メモから AI 提案ドラフトを生成する UI。
 * - 顧客名 / 案件 / 概要 入力
 * - "ドラフト生成" ボタン → loading → ドラフト表示
 */

"use client";

import * as React from "react";
import { useState } from "react";
import { z } from "zod";

import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";
import { Loading } from "../../../../components/Loading";

const Schema = z.object({
  customer: z.string().min(1, "入力必須"),
  opportunity: z.string().min(1, "入力必須"),
  summary: z.string().min(10, "10 文字以上で入力してください"),
});
export type SalesDraftValues = z.infer<typeof Schema>;

export interface SalesDocDraftProps {
  readonly onDraft: (v: SalesDraftValues) => Promise<string>;
}

export function SalesDocDraft({ onDraft }: SalesDocDraftProps) {
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: { customer: "", opportunity: "", summary: "" },
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="text-headline-md font-bold text-on-surface">
        商談ドラフト
      </h1>
      <Form
        form={form}
        onValid={async (v) => {
          setLoading(true);
          try {
            setDraft(await onDraft(v));
          } finally {
            setLoading(false);
          }
        }}
        className="gap-md"
      >
        <Field
          label="顧客名"
          required
          error={form.formState.errors.customer?.message}
        >
          <input
            {...form.register("customer")}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </Field>
        <Field
          label="案件"
          required
          error={form.formState.errors.opportunity?.message}
        >
          <input
            {...form.register("opportunity")}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </Field>
        <Field
          label="商談概要"
          required
          error={form.formState.errors.summary?.message}
        >
          <textarea
            {...form.register("summary")}
            rows={5}
            className="rounded-md border border-surface-variant bg-surface px-sm py-xs text-body-md text-on-surface"
          />
        </Field>
        <button
          type="submit"
          disabled={loading}
          className="inline-flex h-10 w-fit items-center rounded-md bg-primary px-md text-label-lg text-primary-fg disabled:opacity-50"
        >
          ドラフト生成
        </button>
      </Form>
      {loading ? <Loading /> : null}
      {draft && !loading ? (
        <article aria-label="生成ドラフト">
          <h2 className="text-label-lg font-semibold text-on-surface">
            生成されたドラフト
          </h2>
          <pre className="whitespace-pre-wrap rounded-md bg-surface-variant/30 p-md text-body-sm text-on-surface">
            {draft}
          </pre>
        </article>
      ) : null}
    </section>
  );
}
