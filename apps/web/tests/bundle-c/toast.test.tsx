/**
 * T-US-08 Toast tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toast } from '../../components/ui/toast';

describe('Toast (T-US-08)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders message and role=status', () => {
    render(<Toast id="t1" message="hello" onClose={() => undefined} durationMs={0} />);
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('uses aria-live=assertive for error tone', () => {
    render(<Toast id="t1" message="bad" tone="error" onClose={() => undefined} durationMs={0} />);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('assertive');
  });

  it('calls onClose after durationMs', () => {
    const onClose = vi.fn();
    render(<Toast id="t1" message="x" onClose={onClose} durationMs={1000} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onClose).toHaveBeenCalledWith('t1');
  });

  it('calls onClose on close button click', () => {
    const onClose = vi.fn();
    render(<Toast id="t1" message="x" onClose={onClose} durationMs={0} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClose).toHaveBeenCalledWith('t1');
  });
});
