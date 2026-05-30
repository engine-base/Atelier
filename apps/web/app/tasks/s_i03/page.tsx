'use client';

import * as React from 'react';

import { ExecutionMonitor, type LogLine } from './_components/ExecutionMonitor';

const SAMPLE: LogLine[] = [
  { id: '1', ts: '10:00:01', level: 'info', message: '実行開始' },
  { id: '2', ts: '10:00:03', level: 'debug', message: 'プロンプト構築' },
  { id: '3', ts: '10:00:05', level: 'warn', message: 'リトライ実行 (1/3)' },
  { id: '4', ts: '10:00:10', level: 'info', message: '正常終了' },
];

export default function SI03Page() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-lg px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">実行モニター</h1>
      <ExecutionMonitor lines={SAMPLE} />
    </div>
  );
}
