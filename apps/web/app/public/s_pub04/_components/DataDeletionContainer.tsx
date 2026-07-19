/**
 * S-PUB04 データ削除要求 コンテナ — T-UC-29 (design-audit v2: 実 API 配線)
 *
 * 従来は onSubmit が no-op で「申請しても何も起きない偽フォーム」だった。
 * GET /me でログイン中アカウントを特定し、POST /public/data-deletion-requests に
 * 実申請する (未ログイン時はサインイン誘導)。成功時は受付番号つきの完了表示。
 */

"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import Link from "next/link";

import { ApiError, getJson, sendJson } from "../../../../lib/auth/connector";
import { DataDeletionForm, type DeletionValues } from "./DataDeletionForm";

interface MeLite {
  readonly email?: string | null;
}

interface DeletionReceipt {
  readonly request_id: string;
  readonly status: string;
  readonly requested_at: string;
}

export function DataDeletionContainer() {
  const [email, setEmail] = useState<string | null>(null);
  const [unauthed, setUnauthed] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJson<MeLite>("/me")
      .then((r) => {
        if (!cancelled) setEmail(r.data.email ?? "");
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) setUnauthed(true);
        else setServerError("アカウント情報の取得に失敗しました。");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (v: DeletionValues): Promise<void> => {
    setServerError(null);
    try {
      const data = await sendJson<DeletionReceipt>(
        "POST",
        "/public/data-deletion-requests",
        { reason: v.reason || undefined },
      );
      if (!data) throw new Error("no receipt");
      setReceipt(data);
    } catch {
      setServerError(
        "削除申請の送信に失敗しました。時間をおいて再度お試しください。",
      );
    }
  };

  if (unauthed) {
    return (
      <section className="rounded-lg border border-border bg-white p-6">
        <h1 className="mb-2 text-[22px] font-bold text-on-surface">
          個人データ削除要求
        </h1>
        <p className="mb-4 text-body-md text-on-surface">
          削除要求はご本人確認のため、対象アカウントで
          <strong>サインインした状態</strong>で行っていただきます。
        </p>
        <Link
          href="/signin?redirect=/data-deletion"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition hover:bg-[#1E54D8]"
        >
          サインインして続ける
        </Link>
      </section>
    );
  }

  if (receipt) {
    return (
      <section
        role="status"
        className="rounded-lg border border-border bg-white p-6"
      >
        <h1 className="mb-2 text-[22px] font-bold text-on-surface">
          削除申請を受け付けました
        </h1>
        <p className="mb-3 text-body-md text-on-surface">
          受付番号: <code className="font-mono">{receipt.request_id}</code>
        </p>
        <p className="text-sm leading-[1.8] text-on-surface-variant">
          申請から 30 日後にナレッジ匿名化と個人情報のハード削除を実行します。
          <br />
          30 日以内に再ログインすると申請をキャンセルできます。
        </p>
      </section>
    );
  }

  if (email === null) {
    return (
      <p role="status" className="text-body-md text-on-surface-variant">
        読み込み中…
      </p>
    );
  }

  return (
    <DataDeletionForm email={email} onSubmit={submit} serverError={serverError} />
  );
}
