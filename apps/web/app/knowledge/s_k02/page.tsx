'use client';

import * as React from 'react';

import { PromotionReview, type PromotionItem } from './_components/PromotionReview';

const ITEMS: PromotionItem[] = [
  {
    id: 'pr1',
    title: 'ライフサイクル状態の遷移ルール',
    confidence: 0.92,
    content: 'active → paused → archived の単方向...',
    source: 'タスク T-XXX の議事録',
  },
];

export default function SK02Page() {
  return (
    <div className="mx-auto w-full max-w-3xl px-md py-lg">
      <h1 className="mb-md text-headline-md font-bold text-on-surface">ナレッジ昇格レビュー</h1>
      <PromotionReview items={ITEMS} onApprove={() => undefined} onReject={() => undefined} />
    </div>
  );
}
