'use client';

import * as React from 'react';

import { TranscriptUpload } from './_components/TranscriptUpload';

export default function SM01Page() {
  return (
    <div className="mx-auto w-full max-w-3xl px-md py-lg">
      <TranscriptUpload
        onUpload={async (_f) => {
          // 実 API 連携は別 PR (audio→STT)。本 PR はモック transcript を返す。
          await new Promise((r) => setTimeout(r, 200));
          return 'これはサンプルの文字起こし結果です。';
        }}
      />
    </div>
  );
}
