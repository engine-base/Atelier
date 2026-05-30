/**
 * T-US-17 Skeleton + Loading tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Loading } from '../../components/Loading';
import { Skeleton } from '../../components/Skeleton';

describe('Skeleton (T-US-17)', () => {
  it('renders role=status with aria-busy and aria-label', () => {
    render(<Skeleton width={100} height={20} />);
    const el = screen.getByRole('status');
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.getAttribute('aria-label')).toBeTruthy();
  });

  it.each(['rect', 'circle', 'text'] as const)('renders with shape=%s', (shape) => {
    const { container } = render(<Skeleton shape={shape} />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it('uses custom label when provided', () => {
    render(<Skeleton label="あとちょっと" />);
    expect(screen.getByLabelText('あとちょっと')).toBeInTheDocument();
  });
});

describe('Loading (T-US-17)', () => {
  it('renders aria-live=polite with default message', () => {
    render(<Loading />);
    const el = screen.getByRole('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText(/読み込み中/)).toBeInTheDocument();
  });

  it('renders fullScreen variant with fixed positioning', () => {
    const { container } = render(<Loading fullScreen message="待ち" />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('fixed');
    expect(screen.getByText('待ち')).toBeInTheDocument();
  });
});
