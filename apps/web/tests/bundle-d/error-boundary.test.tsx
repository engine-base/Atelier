/**
 * T-US-06 ErrorBoundary tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '../../components/ErrorBoundary';

function Boom({ fail }: { readonly fail: boolean }) {
  if (fail) throw new Error('boom');
  return <p>OK</p>;
}

describe('ErrorBoundary (T-US-06)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errSpy.mockRestore());

  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <Boom fail={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('renders default fallback with retry button on error', () => {
    render(
      <ErrorBoundary>
        <Boom fail={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再試行' })).toBeInTheDocument();
  });

  it('invokes onError prop with the thrown Error', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Boom fail={true} />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalled();
    expect((onError.mock.calls[0]![0] as Error).message).toBe('boom');
  });

  it('uses custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={(e) => <p>CUSTOM:{e.message}</p>}>
        <Boom fail={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('CUSTOM:boom')).toBeInTheDocument();
  });

  it('reset() clears the error state', () => {
    const Wrapper = () => {
      const [fail, setFail] = React.useState(true);
      return (
        <ErrorBoundary fallback={(_e, reset) => (
          <button
            onClick={() => {
              setFail(false);
              reset();
            }}
          >
            reset
          </button>
        )}>
          <Boom fail={fail} />
        </ErrorBoundary>
      );
    };
    render(<Wrapper />);
    fireEvent.click(screen.getByText('reset'));
    expect(screen.getByText('OK')).toBeInTheDocument();
  });
});
