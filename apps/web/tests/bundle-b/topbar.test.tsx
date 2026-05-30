/**
 * T-US-01: TopBar tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TopBar } from '../../components/layout/TopBar';

describe('TopBar', () => {
  it('renders app name and menu button with aria-label', () => {
    render(<TopBar />);
    expect(screen.getByText('Atelier')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /メニュー/ })).toBeInTheDocument();
  });

  it('invokes onToggleSidebar on menu click', () => {
    const onToggle = vi.fn();
    render(<TopBar onToggleSidebar={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /メニュー/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders center and trailing slots', () => {
    render(
      <TopBar trailing={<span>RIGHT</span>}>
        <span>CENTER</span>
      </TopBar>,
    );
    expect(screen.getByText('CENTER')).toBeInTheDocument();
    expect(screen.getByText('RIGHT')).toBeInTheDocument();
  });

  it('has banner landmark role', () => {
    render(<TopBar />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });
});
