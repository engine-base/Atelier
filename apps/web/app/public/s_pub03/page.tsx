/**
 * S-PUB03 特商法表記 — T-UC-28 (design-audit v2)
 *
 * GET /public/legal-documents/tokushoho の正本を描画する (ハードコード縮約版を廃止)。
 */

import * as React from 'react';

import { LegalDocArticle } from '../_components/LegalDocArticle';
import { PublicHeader } from '../_components/PublicHeader';

export const metadata = {
  title: '特定商取引法に基づく表記 | Atelier',
  description: 'Atelier の特定商取引法に基づく表記',
};

export default function SPub03Page() {
  return (
    <>
      <PublicHeader />
      <div className="mx-auto max-w-3xl px-md py-lg">
        <LegalDocArticle docType="tokushoho" />
      </div>
    </>
  );
}
