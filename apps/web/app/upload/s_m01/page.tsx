/**
 * S-M01 議事録アップロード画面 — T-UC-23
 *
 * 実 meetings API に配線（2 段階アップロード + 非同期 transcription）。
 * projectId は URL ?project=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { MeetingUploadContainer } from "./_components/MeetingUploadContainer";

function SM01Inner() {
  const params = useSearchParams();
  const projectId = params.get("project");

  return (
    <div className="mx-auto w-full max-w-3xl px-md py-lg">
      {projectId ? (
        <MeetingUploadContainer projectId={projectId} />
      ) : (
        <p className="text-body-md text-on-surface-variant">
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
