/**
 * S-PUB04 データ削除要求 コンテナ — T-UC-29 (design-audit v2: 実 API 配線)
 *
 * 従来は onSubmit が no-op で「申請しても何も起きない偽フォーム」だった。
 * GET /me でログイン中アカウントを特定し、未ログイン時はサインイン誘導。
 *
 * GAP-233 (2026-08-26 の通し J52 で発見): その是正後も、申請は
 * POST /public/data-deletion-requests (監査ログに記録するだけ) しか呼んでおらず、
 * **退会の本体 (T-A-05 POST /auth/account/delete = users.deleted_at を立てる)**
 * はどの UI からも呼ばれていなかった。purge ジョブは deleted_at しか見ないため、
 * 「申請から 30 日後にハード削除」という受付表示が嘘になっていた
 * (実測: 受付番号は出るが deleted_at は NULL のまま = 削除は永遠に実行されない)。
 * 今は password で本人確認したうえで /auth/account/delete を呼び、
 * 実際の削除予定日時 (scheduled_purge_at) を受付表示に出す。
 * 取り消しは 30 日以内に /auth/account/restore (サインイン画面の復元導線) で行う。
 */

"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import Link from "next/link";

import {
  ApiError,
  clearLocalSession,
  getJson,
  sendJson,
} from "../../../../lib/auth/connector";
import { DataDeletionForm, type DeletionValues } from "./DataDeletionForm";

interface MeLite {
  readonly email?: string | null;
}

interface DeletionReceipt {
  readonly user_id: string;
  readonly scheduled_purge_at: string;
  readonly deleted_at: string;
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
      // 退会の本体 (T-A-05): password で本人確認し users.deleted_at を立てる。
      // これが無いと purge ジョブの対象にならず「30 日後に削除」が嘘になる (GAP-233)。
      const data = await sendJson<DeletionReceipt>(
        "POST",
        "/auth/account/delete",
        { password: v.password, reason: v.reason || undefined },
      );
      if (!data) throw new Error("no receipt");
      setReceipt(data);
      // 退会後のセッションは使えないので、この場で確実に手放す
      clearLocalSession();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setServerError("パスワードが正しくありません。");
        return;
      }
      if (e instanceof ApiError && e.status === 409) {
        setServerError("このアカウントはすでに退会手続き済みです。");
        return;
      }
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
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition hover:bg-primary-hover"
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
          削除予定日時:{" "}
          <code className="font-mono">
            {new Date(receipt.scheduled_purge_at).toLocaleString("ja-JP")}
          </code>
        </p>
        <p className="text-sm leading-[1.8] text-on-surface-variant">
          上記の日時にナレッジ匿名化と個人情報のハード削除を実行します。
          それまでサインインはできません。
          <br />
          取り消したい場合は 30 日以内に、サインイン画面の
          「退会済みアカウントの復元」からメールアドレスとパスワードで復元できます。
        </p>
        <p className="mt-4">
          <Link
            href="/signin"
            className="inline-flex items-center rounded-md border border-border px-4 py-2 text-sm font-semibold text-on-surface transition hover:bg-surface-variant"
          >
            サインイン画面へ
          </Link>
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
