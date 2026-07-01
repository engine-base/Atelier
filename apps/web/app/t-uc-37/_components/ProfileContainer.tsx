/**
 * T-UC-37 プロフィール コンテナ — 実 /me API 配線
 *
 * GET /me で表示名/メールを取得し、PATCH /me {display_name} で保存する。
 * email は認証（Supabase Auth）に紐づき本 API では変更不可のため読み取り専用。
 * api client は注入可能。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../lib/auth/connector";
import { Field } from "../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../components/forms/Form";
import { Avatar } from "../../../components/Avatar";
import { t } from "../../../lib/i18n";

interface ApiMe {
  email: string;
  display_name?: string | null;
}

const Schema = z.object({
  display_name: z.string().min(1, "入力必須").max(100),
});

export interface ProfileContainerProps {
  readonly client?: ApiClient;
}

export function ProfileContainer({ client: injected }: ProfileContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);

  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await client.get("/me");
      return (res as { data?: ApiMe }).data ?? null;
    },
    retry: false,
  });

  if (me.error instanceof ApiError && me.error.status === 401) {
    return (
      <p role="alert" className="text-body-md text-error">
        サインインが必要です。
      </p>
    );
  }
  if (me.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        プロフィールの取得に失敗しました。
      </p>
    );
  }
  if (me.isLoading || !me.data) {
    return <Loading className="py-md" />;
  }

  return (
    <ProfileForm
      client={client}
      email={me.data.email}
      initialName={me.data.display_name ?? ""}
    />
  );
}

interface ProfileFormProps {
  readonly client: ApiClient;
  readonly email: string;
  readonly initialName: string;
}

function ProfileForm({ client, email, initialName }: ProfileFormProps) {
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: { display_name: initialName },
  });

  // 楽観更新: 表示名をキャッシュ(['me'])へ即時反映、失敗時に戻す。
  const saveMut = useMutation({
    mutationFn: (v: { display_name: string }) =>
      client.patch("/me", { body: { display_name: v.display_name } }),
    onMutate: async (v) => {
      setServerError(null);
      setSaved(false);
      await queryClient.cancelQueries({ queryKey: ["me"] });
      const prev = queryClient.getQueryData<ApiMe>(["me"]);
      queryClient.setQueryData<ApiMe>(["me"], (old) =>
        old ? { ...old, display_name: v.display_name } : old,
      );
      return { prev };
    },
    onError: (error, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["me"], ctx.prev);
      setServerError(
        error instanceof ApiError && error.status === 401
          ? "サインインが必要です。"
          : "プロフィールの保存に失敗しました。",
      );
    },
    onSuccess: () => setSaved(true),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["me"] }),
  });

  const onSubmit = async (v: { display_name: string }): Promise<void> => {
    await saveMut.mutateAsync(v).catch(() => undefined);
  };

  const name = form.watch("display_name") || email || "User";

  return (
    <div className="flex flex-col gap-lg">
      <header className="flex items-center gap-md">
        <Avatar name={name} size="lg" />
        <h1 className="text-headline-md font-bold text-on-surface">
          プロフィール
        </h1>
      </header>
      <Form form={form} onValid={onSubmit}>
        {serverError ? (
          <p role="alert" className="text-label-lg text-error">
            {serverError}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="text-label-md text-primary">
            保存しました。
          </p>
        ) : null}
        <Field
          label="表示名"
          required
          error={form.formState.errors.display_name?.message}
        >
          <input
            {...form.register("display_name")}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </Field>
        <Field label={t("auth.email")}>
          <input
            type="email"
            value={email}
            readOnly
            aria-readonly="true"
            className="h-10 rounded-md border border-surface-variant bg-surface-variant/40 px-sm text-body-md text-on-surface-variant"
          />
        </Field>
        <button
          type="submit"
          disabled={form.formState.isSubmitting}
          className="inline-flex h-10 w-fit items-center rounded-md bg-primary px-md text-label-lg text-primary-fg disabled:opacity-50"
        >
          {t("common.save")}
        </button>
      </Form>
    </div>
  );
}
