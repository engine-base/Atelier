import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * Assistant UI Thread コンテナの薄い wrapper。
 * 本実装では @assistant-ui/react の Thread / Composer を組み合わせる。
 * Phase 0 ではコンテナ + 子の slot 構造のみ提供する。
 */
export interface ThreadProps {
  readonly className?: string;
  readonly children?: ReactNode;
}

export function Thread({ className, children }: ThreadProps) {
  return (
    <section
      aria-label="Assistant thread"
      className={cn(
        'flex h-full w-full flex-col gap-md overflow-y-auto bg-surface p-lg',
        className,
      )}
    >
      {children}
    </section>
  );
}

export interface ThreadMessageProps {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly children: ReactNode;
}

export function ThreadMessage({ role, children }: ThreadMessageProps) {
  const isUser = role === 'user';
  return (
    <article
      data-role={role}
      className={cn(
        'max-w-prose rounded-lg p-md text-body-md',
        isUser
          ? 'self-end bg-primary-container text-primary-container-fg'
          : 'self-start bg-surface-variant text-on-surface-variant',
      )}
    >
      {children}
    </article>
  );
}
