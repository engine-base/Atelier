/**
 * S-H01 モックビューア コンテナ — T-UC-13 (実 mocks API 配線)
 *
 * GET /mocks/{id} で screen_name（タイトル）、GET /mocks/{id}/content-url で
 * HTML の署名付き閲覧 URL を取得し、MockViewer の iframe src に渡す。
 * storage 未設定(503)時はその旨を表示する。api client は注入可能。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { MockViewer } from "./MockViewer";

interface ApiMock {
  screen_name: string;
}

export interface MockViewerContainerProps {
  readonly mockId: string;
  readonly client?: ApiClient;
}

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

export function MockViewerContainer({
  mockId,
  client: injected,
}: MockViewerContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);

  const meta = useQuery({
    queryKey: ["mock", mockId],
    queryFn: async () => {
      const res = await client.get("/mocks/{mock_id}", {
        params: { path: { mock_id: mockId } },
      });
      return (res as { data?: ApiMock }).data ?? null;
    },
    retry: false,
  });

  const content = useQuery({
    queryKey: ["mock", mockId, "content-url"],
    queryFn: async () => {
      const res = await client.get("/mocks/{mock_id}/content-url", {
        params: { path: { mock_id: mockId } },
      });
      return (res as { data?: { url: string } }).data ?? null;
    },
    retry: false,
  });

  if (statusOf(meta.error) === 403 || statusOf(content.error) === 403) {
    return (
      <p
        role="alert"
        className="rounded-md border-l-[3px] border-error bg-error/10 px-md py-sm text-body-md text-error"
      >
        このモックを表示する権限がありません。
      </p>
    );
  }
  if (statusOf(content.error) === 503) {
    return (
      <p
        role="alert"
        className="rounded-md border-l-[3px] border-error bg-error/10 px-md py-sm text-body-md text-error"
      >
        モックの保存先が未設定のため表示できません。
      </p>
    );
  }
  if (meta.error || content.error) {
    return (
      <p
        role="alert"
        className="rounded-md border-l-[3px] border-error bg-error/10 px-md py-sm text-body-md text-error"
      >
        モックの取得に失敗しました。
      </p>
    );
  }
  if (meta.isLoading || content.isLoading || !content.data) {
    return <Loading className="py-md" />;
  }

  return (
    <MockViewer
      src={content.data.url}
      title={meta.data?.screen_name ?? "モック"}
    />
  );
}
