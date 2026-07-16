/**
 * T-US-01 / F-VIS: TopBar tests (モック topbar 忠実化後の契約)
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TopBar } from '../../components/layout/TopBar';

describe('TopBar', () => {
  it('renders the workspace picker with the workspace name', () => {
    render(<TopBar workspaceName="ENGINE BASE" />);
    expect(screen.getByText('ENGINE BASE')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /ワークスペース: ENGINE BASE/ }),
    ).toBeInTheDocument();
  });

  it('renders the breadcrumb label', () => {
    render(<TopBar workspaceName="ENGINE BASE" breadcrumb="プロジェクト" />);
    expect(screen.getByText('プロジェクト')).toBeInTheDocument();
  });

  it('renders the trailing slot', () => {
    render(<TopBar trailing={<span>RIGHT</span>} />);
    expect(screen.getByText('RIGHT')).toBeInTheDocument();
  });

  it('has banner landmark role', () => {
    render(<TopBar />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });
});
