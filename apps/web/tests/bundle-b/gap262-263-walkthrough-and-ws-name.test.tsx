/**
 * GAP-262 (通し J15-01): 初回ウォークスルーは最後に「完了」があり、完了を記録して中の画面へ進む。
 * GAP-263 (通し J10-07): 空のワークスペース名で送信すると日本語の理由が出て、作成されない。
 */

// jsdom を明示する。ルートの vitest.config.ts は environment=node なので、
// 宣言が無いと CI (リポジトリ全体の実行) でだけ document/window が無くて落ちる。
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { nav, api } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    nav: { push: vi.fn(), params: new URLSearchParams('redirect=%2Fprojects') },
    api: {
      getJson: vi.fn(async () => ({ data: [] })),
      sendJson: vi.fn(async () => ({ id: 'ws-new' })),
      ApiError,
    },
  };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => '/t-uc-35',
}));
vi.mock('../../lib/auth/connector', () => api);

import UC35Page from '../../app/t-uc-35/page';
import { WALKTHROUGH_DONE_KEY } from '../../lib/walkthrough';
import ProjectsPage from '../../app/projects/s_b01/page';

beforeEach(() => {
  nav.push.mockClear();
  api.sendJson.mockClear();
  window.localStorage.clear();
});

describe('T-UC-35 ウォークスルーの完了 (GAP-262)', () => {
  it('最後のステップで「完了」を押すと完了が記録され、redirect 先へ進む', () => {
    render(<UC35Page />);
    expect(screen.getByRole('heading', { name: 'ようこそ Atelier へ' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '次へ' }));
    fireEvent.click(screen.getByRole('button', { name: '次へ' }));
    expect(screen.getByRole('heading', { name: 'プロジェクトを始める' })).toBeInTheDocument();
    const done = screen.getByRole('button', { name: '完了' });
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(window.localStorage.getItem(WALKTHROUGH_DONE_KEY)).toBe('1');
    expect(nav.push).toHaveBeenCalledWith('/projects');
  });
});

describe('S-B01 ワークスペース作成 (GAP-263)', () => {
  it('空の名前で送信すると日本語の理由が出て、API は呼ばれない', async () => {
    render(<ProjectsPage />);
    const form = await screen.findByRole('button', { name: /ワークスペースを作成|作成/ });
    fireEvent.submit(form.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('ワークスペース名を入力してください。');
    await waitFor(() => expect(api.sendJson).not.toHaveBeenCalled());
  });
});
