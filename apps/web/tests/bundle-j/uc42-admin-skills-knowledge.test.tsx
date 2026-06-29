/**
 * T-UC-42 — S-T02 スキル管理 / S-T06 運営デフォルトナレッジ 配線テスト
 *
 * api client を fake で注入し、real API を叩かずに以下を検証する:
 *   - S-T02: list 描画 / create→post / attach→post / 403→AdminDenied
 *   - S-T06: list 描画 / create(account_type=platform)→post / visible_in_tree toggle→patch / 403→denied
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ApiError, type ApiClient } from '@atelier/api-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../../lib/query-client';
import { SkillManager } from '../../app/admin/s_t02/_components/SkillManager';
import { PlatformKnowledgeManager } from '../../app/admin/s_t06/_components/PlatformKnowledgeManager';

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: 'Forbidden',
    payload: undefined,
    path: '/x',
    method: 'get',
  });
}

/** 最小 fake ApiClient。テストごとに get/post/patch/delete を差し替える */
function fakeClient(impl: Partial<Record<'get' | 'post' | 'patch' | 'delete', unknown>>): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get: impl.get ?? noop,
    post: impl.post ?? noop,
    patch: impl.patch ?? noop,
    delete: impl.delete ?? noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe('S-T02 SkillManager (T-UC-42)', () => {
  const skills = [
    {
      id: 'sk1',
      name: 'hearing',
      version: '1.2.0',
      description: 'ヒアリング',
      content_md: '# hearing',
      allowed_employee_roles: ['lead'],
      is_active: true,
    },
  ];

  it('renders the skill list from GET /admin/skills', async () => {
    const get = vi.fn(async () => ({ data: skills }));
    renderWithQuery(<SkillManager client={fakeClient({ get })} />);
    expect(await screen.findByText('hearing')).toBeInTheDocument();
    expect(screen.getByText('ヒアリング')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('creates a skill: form submit → POST → list refetch', async () => {
    const get = vi.fn(async () => ({ data: skills }));
    const post = vi.fn(async () => ({ data: { id: 'sk2' } }));
    renderWithQuery(<SkillManager client={fakeClient({ get, post })} />);
    await screen.findByText('hearing');

    fireEvent.click(screen.getByRole('button', { name: '新規アップロード' }));
    fireEvent.change(screen.getByLabelText(/スキル名/), { target: { value: 'proposal' } });
    fireEvent.change(screen.getByLabelText(/バージョン/), { target: { value: '1.0.0' } });
    fireEvent.change(screen.getByLabelText(/SKILL.md 本文/), { target: { value: '# x' } });
    fireEvent.click(screen.getByRole('button', { name: '登録' }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { name: string; version: string } },
    ];
    expect(init.body.name).toBe('proposal');
    expect(init.body.version).toBe('1.0.0');
    // list 再取得 (invalidate により少なくとも 2 回)
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('rejects invalid semver version', async () => {
    const get = vi.fn(async () => ({ data: skills }));
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(<SkillManager client={fakeClient({ get, post })} />);
    await screen.findByText('hearing');
    fireEvent.click(screen.getByRole('button', { name: '新規アップロード' }));
    fireEvent.change(screen.getByLabelText(/スキル名/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/バージョン/), { target: { value: 'not-semver' } });
    fireEvent.change(screen.getByLabelText(/SKILL.md 本文/), { target: { value: '# x' } });
    fireEvent.click(screen.getByRole('button', { name: '登録' }));
    expect(await screen.findByText(/semver 形式/)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('attaches a skill to an AI employee via POST /attach', async () => {
    const get = vi.fn(async () => ({ data: skills }));
    const post = vi.fn(async () => ({ data: true }));
    renderWithQuery(<SkillManager client={fakeClient({ get, post })} />);
    await screen.findByText('hearing');

    fireEvent.click(screen.getByRole('button', { name: '装着' }));
    fireEvent.change(screen.getByLabelText('AI 社員 ID'), { target: { value: 'emp-1' } });
    fireEvent.click(screen.getByRole('button', { name: '装着する' }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [string, { params: { path: { skill_id: string } }; body: { ai_employee_id: string; attached: boolean } }];
    expect(path).toBe('/admin/skills/{skill_id}/attach');
    expect(init.params.path.skill_id).toBe('sk1');
    expect(init.body).toEqual({ ai_employee_id: 'emp-1', attached: true });
  });

  it('edits a skill: name/version disabled, PATCH on save', async () => {
    const get = vi.fn(async () => ({ data: skills }));
    const patch = vi.fn(async () => ({ data: skills[0] }));
    renderWithQuery(<SkillManager client={fakeClient({ get, patch })} />);
    await screen.findByText('hearing');

    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    // 編集時 name/version は不変 (disabled)
    expect(screen.getByLabelText(/スキル名/)).toBeDisabled();
    expect(screen.getByLabelText(/バージョン/)).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/SKILL.md 本文/), { target: { value: '# updated' } });
    fireEvent.click(screen.getByRole('button', { name: '更新' }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      { params: { path: { skill_id: string } }; body: { content_md: string } },
    ];
    expect(path).toBe('/admin/skills/{skill_id}');
    expect(init.params.path.skill_id).toBe('sk1');
    expect(init.body.content_md).toBe('# updated');
  });

  it('deletes a skill via DELETE', async () => {
    const get = vi.fn(async () => ({ data: skills }));
    const del = vi.fn(async () => undefined);
    renderWithQuery(<SkillManager client={fakeClient({ get, delete: del })} />);
    await screen.findByText('hearing');
    fireEvent.click(screen.getByRole('button', { name: 'hearing を削除' }));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
  });

  it('shows AdminDenied on 403', async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(<SkillManager client={fakeClient({ get })} />);
    expect(await screen.findByText('アクセス権限がありません')).toBeInTheDocument();
  });
});

describe('S-T06 PlatformKnowledgeManager (T-UC-42)', () => {
  const rows = [
    {
      id: 'k1',
      title: '提案書テンプレ',
      category: '提案',
      content_md: '# t',
      visible_in_tree: false,
      updated_at: '2026-06-20T00:00:00Z',
    },
  ];

  it('renders platform knowledge list (GET account_type=platform)', async () => {
    const get = vi.fn(async () => ({ data: rows }));
    renderWithQuery(<PlatformKnowledgeManager client={fakeClient({ get })} />);
    expect(await screen.findByText('提案書テンプレ')).toBeInTheDocument();
    const [, init] = get.mock.calls[0]! as unknown as [string, { params: { query: { account_type: string } } }];
    expect(init.params.query.account_type).toBe('platform');
  });

  it('creates knowledge with account_type=platform via POST /knowledge', async () => {
    const get = vi.fn(async () => ({ data: rows }));
    const post = vi.fn(async () => ({ data: { id: 'k2' } }));
    renderWithQuery(
      <PlatformKnowledgeManager client={fakeClient({ get, post })} platformAccountId="acc-9" />,
    );
    await screen.findByText('提案書テンプレ');

    fireEvent.click(screen.getByRole('button', { name: '新規追加' }));
    fireEvent.change(screen.getByLabelText(/タイトル/), { target: { value: '用語辞書' } });
    fireEvent.change(screen.getByLabelText(/カテゴリ/), { target: { value: '用語' } });
    fireEvent.change(screen.getByLabelText(/本文/), { target: { value: '# 用語' } });
    fireEvent.click(screen.getByRole('button', { name: '追加する' }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { account_type: string; account_id: string; visible_in_tree: boolean; title: string } },
    ];
    expect(path).toBe('/knowledge');
    expect(init.body.account_type).toBe('platform');
    expect(init.body.account_id).toBe('acc-9');
    expect(init.body.visible_in_tree).toBe(false);
    expect(init.body.title).toBe('用語辞書');
  });

  it('toggles visible_in_tree via PATCH', async () => {
    const get = vi.fn(async () => ({ data: rows }));
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(<PlatformKnowledgeManager client={fakeClient({ get, patch })} />);
    await screen.findByText('提案書テンプレ');

    const toggle = screen.getByRole('switch', { name: /ツリー表示/ });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      { params: { path: { knowledge_id: string } }; body: { visible_in_tree: boolean } },
    ];
    expect(path).toBe('/knowledge/{knowledge_id}');
    expect(init.params.path.knowledge_id).toBe('k1');
    expect(init.body.visible_in_tree).toBe(true);
  });

  it('shows empty state when no rows', async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(<PlatformKnowledgeManager client={fakeClient({ get })} />);
    expect(await screen.findByText('ナレッジがありません')).toBeInTheDocument();
  });

  it('shows AdminDenied on 403', async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(<PlatformKnowledgeManager client={fakeClient({ get })} />);
    expect(await screen.findByText('アクセス権限がありません')).toBeInTheDocument();
  });
});
