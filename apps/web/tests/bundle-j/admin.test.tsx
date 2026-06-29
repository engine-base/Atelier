/**
 * Bundle J tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AdminDashboard } from '../../app/admin/s_t01/_components/AdminDashboard';
import { TemplateList, type Template } from '../../app/admin/s_t03/_components/TemplateList';
import {
  UserAdminList,
  type AdminUser,
} from '../../app/admin/s_t04/_components/UserAdminList';
import {
  AuditLogTable,
  type AuditEntry,
} from '../../app/admin/s_t05/_components/AuditLogTable';

describe('AdminDashboard (T-UC-30)', () => {
  it('renders KPI tiles and recent activity', () => {
    render(
      <AdminDashboard
        kpis={[{ id: 'k', label: 'K', value: 1 }]}
        recent={[{ id: 'r', ts: '5m', actor: 'tony', action: 'do' }]}
      />,
    );
    expect(screen.getByText('K')).toBeInTheDocument();
    expect(screen.getByText('do')).toBeInTheDocument();
  });

  it('shows empty placeholder when recent is empty', () => {
    render(<AdminDashboard kpis={[]} recent={[]} />);
    expect(screen.getByText('アクティビティはまだありません')).toBeInTheDocument();
  });
});

// NOTE: SkillManager (旧 T-UC-31 employee competency 版) は T-UC-42 で F-007
// SKILL.md マネージャに置換。配線テストは bundle-j/uc42-admin-skills-knowledge.test.tsx を参照。

describe('TemplateList (T-UC-32)', () => {
  const tpl: Template[] = [{ id: 't1', name: 'X', role: 'engineer', description: 'd' }];

  it('renders clone/edit/delete buttons', () => {
    render(
      <TemplateList
        templates={tpl}
        onClone={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'X を複製' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'X を編集' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'X を削除' })).toBeInTheDocument();
  });

  it('invokes callbacks', () => {
    const onClone = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <TemplateList templates={tpl} onClone={onClone} onEdit={onEdit} onDelete={onDelete} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'X を複製' }));
    fireEvent.click(screen.getByRole('button', { name: 'X を編集' }));
    fireEvent.click(screen.getByRole('button', { name: 'X を削除' }));
    expect(onClone).toHaveBeenCalledWith('t1');
    expect(onEdit).toHaveBeenCalledWith('t1');
    expect(onDelete).toHaveBeenCalledWith('t1');
  });
});

describe('UserAdminList (T-UC-33)', () => {
  const users: AdminUser[] = [
    { id: 'u1', email: 'a@x.com', state: 'active', last_login: '5m' },
    { id: 'u2', email: 'b@x.com', state: 'suspended', last_login: null },
    { id: 'u3', email: 'c@x.com', state: 'deleted', last_login: null },
  ];

  it('shows state labels and proper action per state', () => {
    render(<UserAdminList users={users} onSuspend={() => undefined} onRestore={() => undefined} />);
    expect(screen.getByText('有効')).toBeInTheDocument();
    expect(screen.getByText('停止中')).toBeInTheDocument();
    expect(screen.getByText('削除済')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'a@x.com を停止' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'b@x.com を復元' })).toBeInTheDocument();
  });

  it('invokes onSuspend and onRestore', () => {
    const onSuspend = vi.fn();
    const onRestore = vi.fn();
    render(<UserAdminList users={users} onSuspend={onSuspend} onRestore={onRestore} />);
    fireEvent.click(screen.getByRole('button', { name: 'a@x.com を停止' }));
    fireEvent.click(screen.getByRole('button', { name: 'b@x.com を復元' }));
    expect(onSuspend).toHaveBeenCalledWith('u1');
    expect(onRestore).toHaveBeenCalledWith('u2');
  });
});

describe('AuditLogTable (T-UC-34)', () => {
  const entries: AuditEntry[] = [
    {
      id: 'a1',
      action: 'auth.signin',
      actor_type: 'user',
      actor_id: 'u1',
      target_type: 'user',
      target_id: 'u1',
      ip_address: '1.2.3.4',
      created_at: 't',
    },
    {
      id: 'a2',
      action: 'project.create',
      actor_type: 'user',
      actor_id: 'u2',
      target_type: 'project',
      target_id: 'p1',
      ip_address: null,
      created_at: 't',
    },
  ];

  it('renders entries with action as code', () => {
    render(<AuditLogTable entries={entries} />);
    expect(screen.getByText('auth.signin')).toBeInTheDocument();
    // user:u1 は actor と target の両方に出るため getAllByText
    expect(screen.getAllByText('user:u1').length).toBeGreaterThan(0);
  });

  it('filters by action substring', () => {
    render(<AuditLogTable entries={entries} />);
    fireEvent.change(screen.getByPlaceholderText('action / actor で絞り込み'), {
      target: { value: 'project' },
    });
    expect(screen.queryByText('auth.signin')).toBeNull();
    expect(screen.getByText('project.create')).toBeInTheDocument();
  });

  it('shows — when ip is null', () => {
    render(<AuditLogTable entries={[entries[1]!]} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
