/**
 * S-A03 ワークスペース設定 — T-UC-02
 *
 * AppShell 内で表示される設定画面。実 API 連携は T-A-XX (workspace API) で別途。
 */

'use client';

import * as React from 'react';

import {
  WorkspaceSettingsForm,
  type WorkspaceSettingsValues,
} from './_components/WorkspaceSettingsForm';

export default function SA03Page() {
  const initial: WorkspaceSettingsValues = { name: '', aiLearningOptOut: false };
  return (
    <div className="mx-auto w-full max-w-2xl px-md py-lg">
      <WorkspaceSettingsForm
        defaultValues={initial}
        onSubmit={async (_v) => {
          // TODO: apiClient.patch('/workspaces/{id}') と連携 (T-A-XX)
        }}
        onDelete={() => {
          // TODO: confirm dialog → apiClient.delete('/workspaces/{id}')
        }}
      />
    </div>
  );
}
