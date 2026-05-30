/**
 * S-PUB01 利用規約 — T-UC-26
 *
 * 静的な利用規約ページ。robots は noindex 解除 (公開)、metadata で SEO 設定。
 */

import * as React from 'react';

export const metadata = {
  title: '利用規約 | Atelier',
  description: 'Atelier の利用規約',
};

export default function SPub01Page() {
  return (
    <article className="mx-auto max-w-3xl px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">利用規約</h1>
      <section className="mt-md space-y-md text-body-md text-on-surface">
        <p>本規約は、Atelier(以下「本サービス」)の利用条件を定めるものです。</p>
        <h2 className="mt-lg text-label-lg font-semibold">第 1 条 (適用)</h2>
        <p>
          本規約は、ユーザーと運営者との間の本サービスの利用に関わる一切の関係に適用されます。
        </p>
        <h2 className="mt-lg text-label-lg font-semibold">第 2 条 (利用登録)</h2>
        <p>登録希望者が本規約に同意のうえ、所定の方法で申請するものとします。</p>
        <h2 className="mt-lg text-label-lg font-semibold">第 3 条 (AI 学習)</h2>
        <p>
          顧客データの AI 学習利用は <strong>既定で OFF</strong> です。明示的に有効化された場合のみ利用します。
        </p>
        <h2 className="mt-lg text-label-lg font-semibold">第 4 条 (退会)</h2>
        <p>退会後 30 日間は復元可能なグレース期間とし、その後完全削除されます。</p>
      </section>
    </article>
  );
}
