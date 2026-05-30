'use client';

import * as React from 'react';

import { MockViewer } from './_components/MockViewer';

export default function SH01Page() {
  return (
    <div className="mx-auto w-full max-w-7xl px-md py-lg">
      <MockViewer src="about:blank" title="サンプルモック" />
    </div>
  );
}
