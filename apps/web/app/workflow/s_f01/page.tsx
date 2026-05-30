'use client';

import * as React from 'react';

import { type PhaseEdge, type PhaseNode, WorkflowGraph } from './_components/WorkflowGraph';

const NODES: PhaseNode[] = [
  { id: 'discovery', label: '要件定義', status: 'done' },
  { id: 'design', label: '設計', status: 'in_progress' },
  { id: 'impl', label: '実装', status: 'pending' },
  { id: 'release', label: 'リリース', status: 'pending' },
];
const EDGES: PhaseEdge[] = [
  { from: 'discovery', to: 'design' },
  { from: 'design', to: 'impl' },
  { from: 'impl', to: 'release' },
];

export default function SF01Page() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-lg px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">工程ワークフロー</h1>
      <WorkflowGraph nodes={NODES} edges={EDGES} />
    </div>
  );
}
