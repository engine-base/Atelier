'use client';

import * as React from 'react';

import { TemplateList, type Template } from './_components/TemplateList';

const TEMPLATES: Template[] = [
  {
    id: 't1',
    name: 'Senior Engineer',
    role: 'engineer',
    description: 'コードレビューと設計レビュー特化',
  },
];

export default function ST03Page() {
  return (
    <div className="bg-on-surface min-h-dvh p-lg">
      <h1 className="mb-md text-headline-md font-bold text-surface">AI 社員テンプレ</h1>
      <TemplateList
        templates={TEMPLATES}
        onClone={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
      />
    </div>
  );
}
