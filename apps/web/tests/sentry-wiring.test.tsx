/**
 * T-F-42: Sentry が Web の**実行経路**から呼ばれることの検証。
 *
 * T-F-08 は `initSentryClient()` を実装したが呼び出し元が 1 つも無く、
 * `ErrorBoundary` の通知 hook も空スロットのままだった (GAP-108)。
 * ここでは「定義がある」ではなく「layout のツリーから初期化され、
 * ErrorBoundary が実際に captureException を呼ぶ」ことを検証する。
 *
 * captureException は実装を差し替えず spy で包む (delegate) ため、
 * 「SDK 不在で false を返す」実挙動もそのまま検証できる。
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ObservabilityModule from '../providers/observability-provider';

const { initSentryClient, captureSpy } = vi.hoisted(() => ({
  initSentryClient: vi.fn(async () => true),
  captureSpy: vi.fn(),
}));

vi.mock('../lib/sentry.client', () => ({
  initSentryClient,
  isSentryAvailable: () => false,
}));

vi.mock('../providers/observability-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof ObservabilityModule>();
  return {
    ...actual,
    captureException: (
      ...args: Parameters<typeof actual.captureException>
    ): ReturnType<typeof actual.captureException> => {
      captureSpy(...args);
      return actual.captureException(...args);
    },
  };
});

vi.mock('next/font/google', () => ({
  Noto_Sans_JP: () => ({ variable: 'font-noto', className: 'font-noto' }),
}));

vi.mock('../components/layout/ConditionalAppShell', () => ({
  ConditionalAppShell: ({ children }: { readonly children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

import RootLayout from '../app/layout';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { captureException, ObservabilityProvider } from '../providers/observability-provider';

function Boom(): React.ReactElement {
  throw new Error('boom');
}

beforeEach(() => {
  initSentryClient.mockClear();
  initSentryClient.mockResolvedValue(true);
  captureSpy.mockClear();
});

describe('ObservabilityProvider (T-F-42)', () => {
  it('calls initSentryClient once on mount', async () => {
    render(
      <ObservabilityProvider>
        <p>child</p>
      </ObservabilityProvider>,
    );

    await waitFor(() => expect(initSentryClient).toHaveBeenCalledTimes(1));
    expect(screen.getByText('child')).toBeInTheDocument();
  });

  it('still renders children when initialization rejects', async () => {
    initSentryClient.mockRejectedValueOnce(new Error('no dsn'));

    render(
      <ObservabilityProvider>
        <p>child</p>
      </ObservabilityProvider>,
    );

    await waitFor(() => expect(initSentryClient).toHaveBeenCalled());
    expect(screen.getByText('child')).toBeInTheDocument();
  });
});

describe('app/layout.tsx wiring (T-F-42)', () => {
  it('mounts ObservabilityProvider in the root tree so init actually runs', async () => {
    render(<RootLayout>{<p>page</p>}</RootLayout>);

    await waitFor(() => expect(initSentryClient).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByText('page')).toBeInTheDocument();
  });
});

describe('captureException (T-F-42)', () => {
  it('returns false without throwing when the Sentry SDK is absent', async () => {
    await expect(captureException(new Error('x'), { category: 'ui' })).resolves.toBe(false);
  });
});

describe('ErrorBoundary → Sentry wiring (T-F-42)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errSpy.mockRestore());

  it('reports to Sentry and still renders the fallback UI', () => {
    render(
      <ErrorBoundary fallback={(e) => <p>FALLBACK:{e.message}</p>}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('FALLBACK:boom')).toBeInTheDocument();
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(captureSpy.mock.calls[0]?.[1]).toMatchObject({ category: 'ui' });
  });

  it('reports to Sentry even when no onError prop is supplied', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(captureSpy).toHaveBeenCalledTimes(1);
  });

  it('still calls the optional onError hook in addition to Sentry', () => {
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });
});
