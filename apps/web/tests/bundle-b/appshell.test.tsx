/**
 * T-US-01: AppShell tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AppShell } from '../../components/layout/AppShell';

describe('AppShell', () => {
  it('renders children inside main with id and tabIndex for skip-link', () => {
    render(
      <AppShell currentPath="/">
        <p>HELLO</p>
      </AppShell>,
    );
    expect(screen.getByText('HELLO')).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main.id).toBe('main-content');
    expect(main.getAttribute('tabindex')).toBe('-1');
  });

  it('renders skip-to-content link as first interactive element', () => {
    render(
      <AppShell currentPath="/">
        <p>X</p>
      </AppShell>,
    );
    const link = screen.getByText('メインコンテンツへスキップ');
    expect(link.getAttribute('href')).toBe('#main-content');
  });

  it('renders the workspace name and breadcrumb in the TopBar', () => {
    render(
      <AppShell currentPath="/" workspaceName="ENGINE BASE" breadcrumb="プロジェクト">
        <p>X</p>
      </AppShell>,
    );
    expect(screen.getByText('ENGINE BASE')).toBeInTheDocument();
    // パンくずの「プロジェクト」(サイドバーのナビ項目とは別に TopBar 内にも出る)
    expect(
      screen.getByRole('banner').textContent?.includes('プロジェクト'),
    ).toBe(true);
  });

  it('renders the topBarTrailing slot', () => {
    render(
      <AppShell currentPath="/" topBarTrailing={<span>TRL</span>}>
        <p>X</p>
      </AppShell>,
    );
    expect(screen.getByText('TRL')).toBeInTheDocument();
  });
});
