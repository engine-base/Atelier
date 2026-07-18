/**
 * S-M01 議事録アップロード画面 — T-UC-23
 *
 * 実 meetings API に配線（2 段階アップロード + 非同期 transcription）。
 * projectId は URL ?project=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useProjectId } from "../../../lib/useProjectId";

import { MeetingUploadContainer } from "./_components/MeetingUploadContainer";

function SM01Inner() {
  const projectId = useProjectId();

  return (
    <div className="mx-auto w-full max-w-[1200px] px-md py-lg">
      {projectId ? (
        <MeetingUploadContainer projectId={projectId} />
      ) : (
        <p className="rounded-md border-l-[3px] border-primary bg-primary-container px-4 py-3 text-body-md text-primary-container-fg">
          プロジェクトを選択すると議事録をアップロードできます。
        </p>
      )}
    </div>
  );
}

export default function SM01Page() {
  return (
    <Suspense
      fallback={
        <div className="p-lg text-body-md text-on-surface-variant">
          読み込み中…
        </div>
      }
    >
      <SM01Inner />
    </Suspense>
  );
}
