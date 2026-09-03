/**
 * 横断: オンボーディング・ウェルカム画面 — T-UC-35
 *
 * 初回ログイン時に表示されるウォークスルー。3 ステップ。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { cn } from '../../lib/cn';
import { markWalkthroughDone } from '../../lib/walkthrough';

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

function UC35Inner() {
  const [step, setStep] = useState(0);
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get('redirect') || '/projects';
  const last = step === STEPS.length - 1;
  // GAP-262 (通し J15-01): 最後のステップに「完了」を置き、完了を記録してから中の画面へ
  const finish = (): void => {
    markWalkthroughDone();
    router.push(redirectTo);
  };
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
          onClick={() => (last ? finish() : setStep((s) => Math.min(STEPS.length - 1, s + 1)))}
          className="inline-flex h-10 items-center rounded-md bg-primary px-md text-label-lg text-primary-fg disabled:opacity-50"
        >
          {last ? '完了' : '次へ'}
        </button>
      </div>
    </div>
  );
}

// GAP-316: useSearchParams はプリレンダー時に Suspense 境界が必須 (無いと `next build` が
// /t-uc-35 で落ち、Vercel の本番配信が 2026-09-03 04:30 UTC から止まっていた)。
export default function UC35Page() {
  return (
    <Suspense
      fallback={
        <div className="p-lg text-body-md text-on-surface-variant">読み込み中…</div>
      }
    >
      <UC35Inner />
    </Suspense>
  );
}
