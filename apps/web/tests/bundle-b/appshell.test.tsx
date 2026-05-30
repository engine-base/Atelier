/**
 * T-US-01: AppShell tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('toggles sidebar collapse on TopBar menu click', () => {
    render(
      <AppShell currentPath="/">
        <p>X</p>
      </AppShell>,
    );
    // 初期は展開状態 → ラベル「プロジェクト」が見える
    expect(screen.getByText('プロジェクト')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /メニュー/ }));
    // 折りたたみ後 → ラベルが消える (icon 名はそのまま隠す方針)
    expect(screen.queryByText('プロジェクト')).toBeNull();
  });

  it('renders topBarCenter and topBarTrailing slots', () => {
    render(
      <AppShell
        currentPath="/"
        topBarCenter={<span>CTR</span>}
        topBarTrailing={<span>TRL</span>}
      >
        <p>X</p>
      </AppShell>,
    );
    expect(screen.getByText('CTR')).toBeInTheDocument();
    expect(screen.getByText('TRL')).toBeInTheDocument();
  });
});
