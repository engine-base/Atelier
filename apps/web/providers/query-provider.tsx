/**
 * TanStack Query Provider (Next.js 15 App Router 対応) — T-US-05
 *
 * - 'use client' 必須 (QueryClientProvider は client component)
 * - QueryClient は useState で初期化 (re-render 跨ぎで instance 安定)
 * - dev では Devtools をマウント (production bundle から除外)
 * - GAP-261: 起動時に HttpOnly cookie からトークンをメモリへ載せる
 *   (画面の同期コードが Authorization を組み立てられるようにするため)
 */

"use client";

import { type ReactNode, useEffect, useState } from "react";

import { QueryClientProvider } from "@tanstack/react-query";

import { ToastViewport } from "../components/ui/ToastViewport";
import { ensureAccessToken } from "../lib/auth/connector";
import { createQueryClient } from "../lib/query-client";

interface QueryProviderProps {
  readonly children: ReactNode;
}

export function QueryProvider({ children }: QueryProviderProps) {
  const [client] = useState(() => createQueryClient());
  // GAP-261: JWT は HttpOnly cookie にあり JS からは読めない。ストリーム系など
  // 同期でトークンを要求する経路のために、起動時に一度だけ取り直しておく。
  useEffect(() => {
    void ensureAccessToken();
  }, []);
  return (
    <QueryClientProvider client={client}>
      {children}
      <ToastViewport />
    </QueryClientProvider>
  );
}
