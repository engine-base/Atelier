/**
 * S-L03 クライアントプロジェクトビュー画面 — T-UC-22 (R-T08)
 *
 * client_portal JWT で /client/projects/{id} を fetch する想定。
 * 本 PR は UI 配線のみ、実 fetch は別 connector PR。
 */

'use client';

import * as React from 'react';

import {
  ClientProjectView,
  type ClientProjectViewData,
} from './_components/ClientProjectView';

const SAMPLE: ClientProjectViewData = {
  id: 'p1',
  name: 'Sample Project (Client View)',
  description: 'クライアント向けに公開される最小情報のみが表示されます。',
  scopes: ['view', 'comment'],
  viewed_as_client_display_name: '株式会社ACME 山田',
};

export default function SL03Page() {
  return (
    <div className="mx-auto w-full max-w-3xl px-md py-lg">
      <ClientProjectView data={SAMPLE} />
    </div>
  );
}
