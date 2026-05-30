'use client';

import * as React from 'react';

import { AdminDashboard } from './_components/AdminDashboard';

export default function ST01Page() {
  return (
    <div className="bg-on-surface min-h-dvh p-lg">
      <AdminDashboard
        kpis={[
          { id: 'orgs', label: 'WS 数', value: 42 },
          { id: 'users', label: 'ユーザ数', value: 318 },
          { id: 'mrr', label: 'MRR', value: '¥1.2M' },
          { id: 'churn', label: 'チャーン率', value: '2.1%' },
        ]}
        recent={[
          { id: '1', ts: '5m', actor: 'tony', action: 'プロジェクト作成' },
          { id: '2', ts: '20m', actor: 'wanda', action: 'WS 設定変更' },
        ]}
      />
    </div>
  );
}
