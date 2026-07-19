/**
 * S-PUB02 プライバシーポリシー — T-UC-27 (design-audit v2)
 *
 * GET /public/legal-documents/privacy_policy の正本を描画する (ハードコード縮約版を廃止)。
 */

import * as React from 'react';

import { LegalDocArticle } from '../_components/LegalDocArticle';
import { PublicHeader } from '../_components/PublicHeader';

export const metadata = {
  title: 'プライバシーポリシー | Atelier',
  description: 'Atelier のプライバシーポリシー',
};

export default function SPub02Page() {
  return (
    <>
      <PublicHeader />
      <div className="mx-auto max-w-3xl px-md py-lg">
        <LegalDocArticle docType="privacy_policy" />
      </div>
    </>
  );
}
