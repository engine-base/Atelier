/**
 * S-B03 プロジェクト設定画面 — T-UC-05
 */

'use client';

import * as React from 'react';

import {
  ProjectSettingsForm,
  type ProjectSettingsValues,
} from './_components/ProjectSettingsForm';

export default function SB03Page() {
  const initial: ProjectSettingsValues = {
    name: '',
    client_name: '',
    description: '',
    lifecycle: 'active',
  };
  return (
    <div className="mx-auto w-full max-w-2xl px-md py-lg">
      <ProjectSettingsForm
        defaultValues={initial}
        onSubmit={async () => undefined}
        onDelete={() => undefined}
      />
    </div>
  );
}
