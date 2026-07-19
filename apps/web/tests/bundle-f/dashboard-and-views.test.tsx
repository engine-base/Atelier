/**
 * T-UC-04 ProjectDashboard + T-UC-05 ProjectSettingsForm + T-UC-22 ClientProjectView tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  ProjectDashboard,
  type DashboardKpi,
} from '../../app/projects/s_b02/_components/ProjectDashboard';
import {
  ProjectSettingsForm,
  type ProjectSettingsValues,
} from '../../app/projects/s_b03/_components/ProjectSettingsForm';
import { ClientProjectView } from '../../app/client/s_l03/_components/ClientProjectView';

describe('ProjectDashboard (T-UC-04)', () => {
  const kpis: DashboardKpi[] = [
    { id: 'a', label: 'A', value: 10, tone: 'info' },
    { id: 'b', label: 'B', value: 0, tone: 'error' },
  ];

  it('renders project name and KPIs', () => {
    render(<ProjectDashboard projectName="X" kpis={kpis} />);
    // 新デザイン: h1 は「プロジェクトダッシュボード」、プロジェクト名はサブタイトル
    expect(
      screen.getByRole('heading', { name: 'プロジェクトダッシュボード' }),
    ).toBeInTheDocument();
    expect(screen.getByText('X')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('renders skeletons while loading', () => {
    const { container } = render(<ProjectDashboard projectName="X" kpis={[]} loading />);
    expect(container.querySelectorAll('[role="status"]').length).toBeGreaterThan(0);
  });

  it('has KPI region landmark', () => {
    render(<ProjectDashboard projectName="X" kpis={kpis} />);
    expect(screen.getByRole('region', { name: 'KPI 一覧' })).toBeInTheDocument();
  });
});

describe('ProjectSettingsForm (T-UC-05)', () => {
  const defaults: ProjectSettingsValues = {
    name: 'P1',
    client_name: 'ACME',
    description: '',
    type: 'client_project',
    lifecycle: 'active',
  };

  it('renders with default values', () => {
    render(<ProjectSettingsForm defaultValues={defaults} onSubmit={() => undefined} />);
    expect((screen.getByLabelText(/プロジェクト名/) as HTMLInputElement).value).toBe('P1');
    expect((screen.getByLabelText(/ステータス/) as HTMLSelectElement).value).toBe('active');
  });

  it('shows Danger Zone only with onDelete', () => {
    const { rerender } = render(
      <ProjectSettingsForm defaultValues={defaults} onSubmit={() => undefined} />,
    );
    expect(screen.queryByText('Danger Zone')).toBeNull();
    rerender(
      <ProjectSettingsForm
        defaultValues={defaults}
        onSubmit={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(screen.getByText('Danger Zone')).toBeInTheDocument();
  });

  it('blocks submit when name is empty', async () => {
    const onSubmit = vi.fn();
    render(
      <ProjectSettingsForm
        defaultValues={{ ...defaults, name: '' }}
        onSubmit={onSubmit}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('ClientProjectView (T-UC-22)', () => {
  it('renders project name, description, scope badges and client display name', () => {
    render(
      <ClientProjectView
        data={{
          id: 'p1',
          name: 'Test Project',
          description: 'desc',
          scopes: ['view', 'comment'],
          viewed_as_client_display_name: '山田 太郎',
        }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Test Project' })).toBeInTheDocument();
    expect(screen.getByText('desc')).toBeInTheDocument();
    expect(screen.getByText('閲覧')).toBeInTheDocument();
    expect(screen.getByText('コメント')).toBeInTheDocument();
    expect(screen.getByText('山田 太郎')).toBeInTheDocument();
  });

  it('omits description when null', () => {
    render(
      <ClientProjectView
        data={{
          id: 'p1',
          name: 'X',
          description: null,
          scopes: [],
          viewed_as_client_display_name: null,
        }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'X' })).toBeInTheDocument();
  });
});
