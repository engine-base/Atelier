/**
 * ErrorBoundary — T-US-06 (React Error Boundary + Sentry 配線スロット)
 *
 * - React の標準的な class component error boundary
 * - error を Sentry に送る hook (sentryClient.captureException) を受ける (省略可)
 * - fallback UI は default + custom 切替
 * - reset 機能でユーザーが再試行できる
 */

'use client';

import * as React from 'react';
import { type ErrorInfo, type ReactNode } from 'react';

import { t } from '../lib/i18n';

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** カスタム fallback (省略時は Atelier 既定) */
  readonly fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Sentry 等への通知 hook */
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
