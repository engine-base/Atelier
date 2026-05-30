/**
 * TanStack Query Provider (Next.js 15 App Router 対応) — T-US-05
 *
 * - 'use client' 必須 (QueryClientProvider は client component)
 * - QueryClient は useState で初期化 (re-render 跨ぎで instance 安定)
 * - dev では Devtools をマウント (production bundle から除外)
 */

'use client';

import { type ReactNode, useState } from 'react';

import { QueryClientProvider } from '@tanstack/react-query';

import { createQueryClient } from '../lib/query-client';

interface QueryProviderProps {
  readonly children: ReactNode;
}

export function QueryProvider({ children }: QueryProviderProps) {
  const [client] = useState(() => createQueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
