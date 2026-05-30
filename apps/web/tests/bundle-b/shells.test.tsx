/**
 * T-US-15 / T-US-16: ClientShell + AdminShell tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AdminShell } from '../../components/admin/AdminShell';
import { ClientShell } from '../../components/client/ClientShell';

describe('ClientShell (T-US-15)', () => {
  it('renders portal title and children', () => {
    render(
      <ClientShell>
        <p>OK</p>
      </ClientShell>,
    );
    expect(screen.getByText('クライアントポータル')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('renders projectName and clientDisplayName when provided', () => {
    render(
      <ClientShell projectName="P-Alpha" clientDisplayName="顧客 A">
        <p>X</p>
      </ClientShell>,
    );
    expect(screen.getByText('P-Alpha')).toBeInTheDocument();
    expect(screen.getByText('顧客 A')).toBeInTheDocument();
  });

  it('has banner landmark and main with skip target', () => {
    render(
      <ClientShell>
        <p>X</p>
      </ClientShell>,
    );
    expect(screen.getByRole('banner')).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main.id).toBe('main-content');
  });
});

describe('AdminShell (T-US-16)', () => {
  it('renders admin header with data-theme="admin-dark"', () => {
    const { container } = render(
      <AdminShell>
        <p>X</p>
      </AdminShell>,
    );
    expect(container.querySelector('[data-theme="admin-dark"]')).not.toBeNull();
    expect(screen.getByText('Atelier Admin')).toBeInTheDocument();
  });

  it('renders children inside main', () => {
    render(
      <AdminShell>
        <p>ADMIN-PAGE</p>
      </AdminShell>,
    );
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByText('ADMIN-PAGE')).toBeInTheDocument();
  });

  it('has skip-to-content link', () => {
    render(
      <AdminShell>
        <p>X</p>
      </AdminShell>,
    );
    const link = screen.getByText('メインコンテンツへスキップ');
    expect(link.getAttribute('href')).toBe('#main-content');
  });
});
