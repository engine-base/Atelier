'use client';

import * as React from 'react';

import { SalesDocDraft } from './_components/SalesDocDraft';

export default function SN01Page() {
  return (
    <div className="mx-auto w-full max-w-3xl px-md py-lg">
      <SalesDocDraft
        onDraft={async (v) => {
          await new Promise((r) => setTimeout(r, 200));
          return `# ${v.opportunity}\n\n## 顧客: ${v.customer}\n\n${v.summary}\n\n---\nAI 生成ドラフト`;
        }}
      />
    </div>
  );
}
