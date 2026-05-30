/**
 * S-PUB03 特商法表記 — T-UC-28
 */

import * as React from 'react';

export const metadata = {
  title: '特定商取引法に基づく表記 | Atelier',
};

export default function SPub03Page() {
  return (
    <article className="mx-auto max-w-3xl px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">
        特定商取引法に基づく表記
      </h1>
      <dl className="mt-md grid grid-cols-1 gap-sm text-body-md text-on-surface md:grid-cols-[auto_1fr]">
        <dt className="font-semibold">販売事業者</dt>
        <dd>株式会社 Atelier</dd>
        <dt className="font-semibold">所在地</dt>
        <dd>東京都(請求により遅滞なく開示します)</dd>
        <dt className="font-semibold">代表者</dt>
        <dd>代表取締役</dd>
        <dt className="font-semibold">問い合わせ先</dt>
        <dd>info@example.com</dd>
        <dt className="font-semibold">販売価格</dt>
        <dd>各プランページに表示の通り</dd>
        <dt className="font-semibold">支払方法</dt>
        <dd>クレジットカード(Stripe)</dd>
        <dt className="font-semibold">役務提供時期</dt>
        <dd>決済完了後、即時</dd>
        <dt className="font-semibold">返金・キャンセル</dt>
        <dd>
          月額プランは日割り返金なし。年額プランは未使用残月分を返金可。詳細はプライバシーポリシー参照。
        </dd>
      </dl>
    </article>
  );
}
