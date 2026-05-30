/**
 * 横断: オンボーディング・ウェルカム画面 — T-UC-35
 *
 * 初回ログイン時に表示されるウォークスルー。3 ステップ。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { cn } from '../../lib/cn';

const STEPS = [
  {
    title: 'ようこそ Atelier へ',
    body: 'AI 社員と一緒にプロジェクトを進めるためのワークスペースです。',
  },
  {
    title: 'ワークスペースを作成',
    body: 'まずは個人 or 組織のワークスペースを作成します。',
  },
  {
    title: 'プロジェクトを始める',
    body: 'プロジェクトを作成して、AI 社員にタスクを依頼してみましょう。',
  },
];

export default function UC35Page() {
  const [step, setStep] = useState(0);
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center justify-center gap-lg px-md py-lg">
      <ol
        aria-label="ステップ進捗"
        className="flex w-full justify-center gap-sm"
        role="list"
      >
        {STEPS.map((_, i) => (
          <li
            key={i}
            aria-current={i === step ? 'step' : undefined}
            className={cn(
              'h-1 flex-1 rounded-full',
              i <= step ? 'bg-primary' : 'bg-surface-variant',
            )}
          />
        ))}
      </ol>
      <section aria-label={STEPS[step]!.title} className="flex flex-col gap-md text-center">
        <h1 className="text-headline-md font-bold text-on-surface">{STEPS[step]!.title}</h1>
        <p className="text-body-md text-on-surface-variant">{STEPS[step]!.body}</p>
      </section>
      <div className="flex gap-sm">
        <button
          type="button"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          className="inline-flex h-10 items-center rounded-md border border-surface-variant px-md text-label-lg disabled:opacity-50"
        >
          戻る
        </button>
        <button
          type="button"
          onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
          disabled={step === STEPS.length - 1}
          className="inline-flex h-10 items-center rounded-md bg-primary px-md text-label-lg text-primary-fg disabled:opacity-50"
        >
          次へ
        </button>
      </div>
    </div>
  );
}
