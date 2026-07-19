/**
 * S-PUB04 個人データ削除要求 — T-UC-29 (design-audit v2)
 *
 * 実 API 配線: GET /me (本人特定) + POST /public/data-deletion-requests。
 */

import * as React from 'react';

import { PublicHeader } from '../_components/PublicHeader';
import { DataDeletionContainer } from './_components/DataDeletionContainer';

export const metadata = {
  title: '個人データ削除要求 | Atelier',
  description: '個人情報保護法に基づく保有個人データの削除・利用停止の請求',
};

export default function SPub04Page() {
  return (
    <>
      <PublicHeader backHref="/privacy" backLabel="プライバシーポリシー" />
      <div className="mx-auto w-full max-w-[680px] px-md py-lg">
        <DataDeletionContainer />
      </div>
    </>
  );
}
