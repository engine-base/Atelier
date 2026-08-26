/**
 * 権限が無い画面に来たときの着地先 (GAP-219)。
 *
 * これまで、運営でない人が /admin を開くと **運営コンソールの枠がそのまま描画され**、
 * 7 つのメニューが並んだうえで「権限がありません」というメッセージが 11 件・
 * 約 7 秒間 出続けていた (実測)。API は正しく 403 を返していたので危険では
 * なかったが、画面としては
 *   - 触れないメニューを見せる
 *   - 同じ文言を大量に浴びせる
 *   - 次に何をすればいいか言わない
 * の 3 つが同時に起きていた。middleware がここへ差し替えることで、
 * そもそも運営コンソールを組み立てない。
 */

import Link from 'next/link';

export const metadata = { title: '権限がありません — Atelier' };

export default function AccessDeniedPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface px-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-white p-8 text-center">
        <p className="text-[11px] font-extrabold tracking-[0.12em] text-on-surface-variant">
          ACCESS DENIED
        </p>
        <h1 className="mt-3 text-[19px] font-bold text-on-surface">
          この画面は運営専用です
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-on-surface-variant">
          お使いのアカウントには、この画面を開く権限がありません。
          必要な場合は、運営の担当者にご連絡ください。
        </p>
        <Link
          href="/projects"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
        >
          プロジェクト一覧へ戻る
        </Link>
      </div>
    </main>
  );
}
