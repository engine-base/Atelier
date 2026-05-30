/**
 * T-US-07 Notifications bell tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Notifications } from '../../components/Notifications';
import type { Notification } from '../../lib/realtime';

const ITEMS: Notification[] = [
  { id: 'n1', level: 'info', message: 'first', createdAt: 't1' },
  { id: 'n2', level: 'error', message: 'oops', createdAt: 't2' },
];

describe('Notifications (T-US-07)', () => {
  it('shows badge with unread count', () => {
    render(<Notifications items={ITEMS} />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows 99+ when count exceeds 99', () => {
    const many: Notification[] = Array.from({ length: 100 }, (_, i) => ({
      id: `n${i}`,
      level: 'info' as const,
      message: 'x',
      createdAt: 't',
    }));
    render(<Notifications items={many} />);
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('a11y: button aria-label includes unread count', () => {
    render(<Notifications items={ITEMS} />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toContain('2');
  });

  it('opens panel on click and lists items', () => {
    render(<Notifications items={ITEMS} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('oops')).toBeInTheDocument();
  });

  it('renders dash when no items', () => {
    render(<Notifications items={[]} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('invokes onClear when clear button clicked', () => {
    const onClear = vi.fn();
    render(<Notifications items={ITEMS} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('閉じる'));
    expect(onClear).toHaveBeenCalled();
  });
});
