/**
 * ErrorBoundary — T-US-06 (React Error Boundary) / T-F-42 (Sentry 実配線)
 *
 * - React の標準的な class component error boundary
 * - 捕捉した error は **常に** Sentry へ送る (T-F-42)。呼び出し側が `onError` を
 *   渡すかどうかに依存しない。T-US-06 時点では「Sentry 配線スロット」が空のままで、
 *   実際には 1 件も送られていなかった (GAP-108)。
 * - `onError` は Sentry 送信に加えて呼ばれる追加 hook (省略可)
 * - fallback UI は default + custom 切替
 * - reset 機能でユーザーが再試行できる
 */

'use client';

import * as React from 'react';
import { type ErrorInfo, type ReactNode } from 'react';

import { t } from '../lib/i18n';
import { captureException } from '../providers/observability-provider';

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** カスタム fallback (省略時は Atelier 既定) */
  readonly fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Sentry 送信に**加えて**呼ばれる追加の通知 hook (省略可) */
  readonly onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // T-F-42: Sentry へ実送信する。SDK 不在なら captureException が false を返すだけで
    // throw しないが、念のため rejection も握り潰す (観測失敗で UI を壊さない)。
    void captureException(error, {
      category: 'ui',
      componentStack: info.componentStack ?? undefined,
    }).catch(() => false);
    this.props.onError?.(error, info);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return <DefaultFallback error={error} onReset={this.reset} />;
  }
}

function DefaultFallback({ error, onReset }: { readonly error: Error; readonly onReset: () => void }) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex min-h-dvh flex-col items-center justify-center gap-md bg-surface px-md py-lg text-on-surface"
    >
      <h1 className="text-headline-md font-bold text-error">{t('common.error')}</h1>
      <p className="text-body-md text-on-surface-variant">{error.message}</p>
      <button
        type="button"
        onClick={onReset}
        className="inline-flex h-9 items-center rounded-md bg-primary px-md text-label-lg text-primary-fg hover:bg-primary/90"
      >
        {t('common.retry')}
      </button>
    </div>
  );
}
