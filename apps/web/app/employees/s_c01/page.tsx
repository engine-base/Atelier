'use client';

import * as React from 'react';

import { OrgChart, type OrgNode } from './_components/OrgChart';

const NODES: OrgNode[] = [
  { id: 'tony', displayName: 'Tony', role: 'engineer' },
  { id: 'strange', displayName: 'Strange', role: 'specialist' },
  { id: 'thor', displayName: 'Thor', role: 'engineer' },
  { id: 'wanda', displayName: 'Wanda', role: 'specialist' },
  { id: 'vision', displayName: 'Vision', role: 'specialist' },
  { id: 'tchalla', displayName: 'T’Challa', role: 'specialist' },
  { id: 'steve', displayName: 'Steve', role: 'pm' },
];

export default function SC01Page() {
  return (
    <div className="mx-auto w-full max-w-5xl px-md py-lg">
      <h1 className="mb-lg text-headline-md font-bold text-on-surface">AI 社員組織図</h1>
      <OrgChart nodes={NODES} onSelect={() => undefined} />
    </div>
  );
}
