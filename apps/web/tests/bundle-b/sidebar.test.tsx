/**
 * T-US-01: Sidebar tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DEFAULT_NAV_ITEMS, Sidebar, isCurrent } from '../../components/layout/Sidebar';

describe('isCurrent', () => {
  it('matches root exactly', () => {
    expect(isCurrent('/', '/')).toBe(true);
    expect(isCurrent('/', '/projects')).toBe(false);
  });
  it('matches exact path', () => {
    expect(isCurrent('/projects', '/projects')).toBe(true);
  });
  it('matches sub-route via prefix', () => {
    expect(isCurrent('/projects', '/projects/abc')).toBe(true);
  });
  it('does not match unrelated path', () => {
    expect(isCurrent('/projects', '/tasks')).toBe(false);
  });
  it('returns false when currentPath is undefined', () => {
    expect(isCurrent('/projects', undefined)).toBe(false);
  });
});

describe('Sidebar', () => {
  it('renders default nav items with translated labels (expanded)', () => {
    render(<Sidebar currentPath="/" />);
    expect(screen.getByText('ホーム')).toBeInTheDocument();
    expect(screen.getByText('プロジェクト')).toBeInTheDocument();
    expect(screen.getByText('タスク')).toBeInTheDocument();
  });

  it('marks current page with aria-current="page"', () => {
    render(<Sidebar currentPath="/projects" />);
    const link = screen.getByText('プロジェクト').closest('a');
    expect(link?.getAttribute('aria-current')).toBe('page');
  });

  it('hides labels but keeps links when collapsed', () => {
    const { container } = render(<Sidebar currentPath="/" collapsed />);
    const links = container.querySelectorAll('a');
    expect(links.length).toBe(DEFAULT_NAV_ITEMS.length);
    expect(screen.queryByText('プロジェクト')).toBeNull();
  });

  it('uses custom items when provided', () => {
    render(
      <Sidebar
        currentPath="/x"
        items={[{ id: 'x', labelKey: 'common.cancel', href: '/x' }]}
      />,
    );
    expect(screen.getByText('キャンセル')).toBeInTheDocument();
  });
});
