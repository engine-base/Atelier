/**
 * Bundle J tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AdminDashboard } from '../../app/admin/s_t01/_components/AdminDashboard';
import {
  TemplateEditor,
  TemplateList,
  type Template,
} from '../../app/admin/s_t03/_components/TemplateList';
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

// --------------------------------------------------------------------------- //
// GAP-031⑤: TemplateEditor + 保存フロー (T-A-42 scope expand)
// --------------------------------------------------------------------------- //

describe('TemplateEditor (GAP-031⑤)', () => {
  const editorTemplate = {
    id: 'tpl-1',
    defaultName: 'tony',
    displayName: 'トニー',
    department: 'sales',
    role: 'lead',
    systemPrompt: 'あなたは営業部長です。',
    specialty: '提案書',
    version: 3,
    skills: ['sk-1'],
    knowledgeCats: ['成約パターン'],
  } as const;
  const skills = [
    { id: 'sk-1', label: 'proposal v1.3' },
    { id: 'sk-2', label: 'estimate v1.0' },
  ];

  function renderEditor(onSave = vi.fn()) {
    render(
      <TemplateEditor
        template={editorTemplate}
        availableSkills={skills}
        deployment={{ workspaceCount: 9, employeeCount: 9 }}
        saving={false}
        actionNotice={null}
        actionError={null}
        onSave={onSave}
      />,
    );
    return onSave;
  }

  it('renders mock-faithful editor: 基本情報 / prompt / pills / 実展開先', () => {
    renderEditor();
    expect(screen.getByText('内部名（変更不可）')).toBeInTheDocument();
    expect(screen.getByText('tony')).toBeInTheDocument();
    expect(screen.getByDisplayValue('トニー')).toBeInTheDocument();
    expect(screen.getByDisplayValue('あなたは営業部長です。')).toBeInTheDocument();
    // スキル pill は /admin/skills の実ラベルで解決
    expect(screen.getByText('proposal v1.3')).toBeInTheDocument();
    expect(screen.getByText('成約パターン')).toBeInTheDocument();
    // 実展開先 (ai_employees.template_id 実カウント)
    expect(screen.getByText('展開先：9 WS（自動同期）')).toBeInTheDocument();
    expect(screen.getByText(/9 ワークスペースの 9 体に次回利用時から適用/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存して全 WS 反映' })).toBeInTheDocument();
  });

  it('saves only changed fields (partial patch)', () => {
    const onSave = renderEditor();
    fireEvent.change(screen.getByLabelText(/専門領域（specialty）/), {
      target: { value: '提案書・見積書' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存して全 WS 反映' }));
    expect(onSave).toHaveBeenCalledWith({ specialty: '提案書・見積書' });
  });

  it('blocks save without changes (honest client-side guard)', () => {
    const onSave = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: '保存して全 WS 反映' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('変更がありません。');
  });

  it('adds a skill from real options and removes a category via pills', () => {
    const onSave = renderEditor();
    fireEvent.change(screen.getByLabelText('追加するスキル'), {
      target: { value: 'sk-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'スキル追加' }));
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ 成約パターン を外す' }));
    fireEvent.change(screen.getByLabelText('追加するカテゴリ名'), {
      target: { value: '価格戦略' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }));
    fireEvent.click(screen.getByRole('button', { name: '保存して全 WS 反映' }));
    expect(onSave).toHaveBeenCalledWith({
      default_skills: ['sk-1', 'sk-2'],
      default_knowledge_cats: ['価格戦略'],
    });
  });
});
