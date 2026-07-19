/**
 * S-PUB01 利用規約 — T-UC-26 (design-audit v2)
 *
 * 従来は縮約版本文のハードコードで、DB/API の正本 (legal_documents) と乖離していた。
 * GET /public/legal-documents/terms_of_service の正本を描画する方式に是正。
 */

import * as React from 'react';

import { LegalDocArticle } from '../_components/LegalDocArticle';
import { PublicHeader } from '../_components/PublicHeader';

export const metadata = {
  title: '利用規約 | Atelier',
  description: 'Atelier の利用規約',
};

export default function SPub01Page() {
  return (
    <>
      <PublicHeader />
      <div className="mx-auto max-w-3xl px-md py-lg">
        <LegalDocArticle docType="terms_of_service" />
      </div>
    </>
  );
}
