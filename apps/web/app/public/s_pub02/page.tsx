/**
 * S-PUB02 プライバシーポリシー — T-UC-27
 */

import * as React from 'react';

export const metadata = {
  title: 'プライバシーポリシー | Atelier',
};

export default function SPub02Page() {
  return (
    <article className="mx-auto max-w-3xl px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">プライバシーポリシー</h1>
      <section className="mt-md space-y-md text-body-md text-on-surface">
        <h2 className="mt-lg text-label-lg font-semibold">1. 取得する情報</h2>
        <p>メールアドレス、表示名、アクセスログ、操作履歴、決済情報など。</p>
        <h2 className="mt-lg text-label-lg font-semibold">2. 利用目的</h2>
        <p>本サービスの提供、品質改善、不正利用の防止、法令遵守。</p>
        <h2 className="mt-lg text-label-lg font-semibold">3. 第三者提供</h2>
        <p>法令に基づく場合を除き、本人同意なく第三者へ提供しません。</p>
        <h2 className="mt-lg text-label-lg font-semibold">4. AI 学習</h2>
        <p>
          顧客データの AI 学習利用は<strong>既定で OFF</strong>です。
          有効化はワークスペース単位の opt-in です(F-LEGAL-005)。
        </p>
        <h2 className="mt-lg text-label-lg font-semibold">5. 開示・訂正・削除</h2>
        <p>
          データ削除請求は <a href="/data-deletion" className="text-primary underline">専用フォーム</a> から受け付けます。
        </p>
      </section>
    </article>
  );
}
