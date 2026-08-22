/**
 * GAP-206 — 規約が新しくなったことを本人に伝えて同意を取る / 503 の理由で案内を変える
 *
 * これまでの実態:
 *   ① 同意の記録は新規登録のときだけで、**既存ユーザーへ再同意を求める導線が
 *      無かった**。GAP-188・GAP-204 で足した条項が、旧版に同意したままの
 *      利用者には効きにくい状態だった。
 *   ② 503 は「Bridge 未接続」「保存先が未設定」「LLM 経路が未設定」と別物なのに
 *      **status しか画面に届いていなかった**ため、設定漏れでも
 *      「パソコンを繋いでください」と案内していた。
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@atelier/api-client';

const getJson = vi.fn();
const sendJson = vi.fn();

vi.mock('../../lib/auth/connector', () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  sendJson: (...args: unknown[]) => sendJson(...args),
}));

import { ReconsentNotice, versionKey } from '../../components/layout/ReconsentNotice';

const NEEDS = {
  items: [
    {
      doc_type: 'terms_of_service',
      current_version: '2026-08-21',
      accepted_version: '2026-05-25',
      needs_consent: true,
    },
    {
      doc_type: 'privacy_policy',
      current_version: '2026-08-20',
      accepted_version: '2026-08-20',
      needs_consent: false,
    },
  ],
  needs_consent: true,
};

const SATISFIED = {
  items: [
    {
      doc_type: 'terms_of_service',
      current_version: '2026-08-21',
      accepted_version: '2026-08-21',
      needs_consent: false,
    },
  ],
  needs_consent: false,
};

beforeEach(() => {
  window.localStorage.clear();
  getJson.mockReset();
  sendJson.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('GAP-206 再同意の導線', () => {
  it('旧版のままなら、更新された規約の名前と読むリンクを出す', async () => {
    getJson.mockResolvedValue({ data: NEEDS });
    render(<ReconsentNotice />);

    await waitFor(() => {
      expect(screen.getByRole('region', { name: '規約の更新のお知らせ' })).toBeInTheDocument();
    });
    expect(screen.getByRole('region')).toHaveTextContent('利用規約');
    // 同意済みのものは載せない (無関係な不安を与えない)
    expect(screen.queryByText(/プライバシーポリシーを読む/)).toBeNull();
    expect(screen.getByRole('link', { name: '利用規約を読む' })).toHaveAttribute('href', '/terms');
  });

  it('全部同意済みなら何も出さない', async () => {
    getJson.mockResolvedValue({ data: SATISFIED });
    const { container } = render(<ReconsentNotice />);
    await waitFor(() => expect(getJson).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('未ログイン等で取得に失敗しても、画面を壊さず黙って出さない', async () => {
    getJson.mockRejectedValue(new Error('401'));
    const { container } = render(<ReconsentNotice />);
    await waitFor(() => expect(getJson).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('「同意する」で、**画面が見せた版**を指定して記録する', async () => {
    getJson.mockResolvedValueOnce({ data: NEEDS }).mockResolvedValueOnce({ data: SATISFIED });
    sendJson.mockResolvedValue(undefined);
    render(<ReconsentNotice />);

    await waitFor(() => expect(screen.getByRole('button', { name: '同意する' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '同意する' }));

    await waitFor(() => expect(sendJson).toHaveBeenCalled());
    expect(sendJson).toHaveBeenCalledWith('POST', '/me/consents', {
      doc_type: 'terms_of_service',
      version: '2026-08-21',
    });
    // 同意済みのものへは送らない
    expect(sendJson).toHaveBeenCalledTimes(1);
  });

  it('記録に失敗したら理由を出し、読み直しを促す（黙って成功にしない）', async () => {
    getJson.mockResolvedValue({ data: NEEDS });
    sendJson.mockRejectedValue(new Error('409'));
    render(<ReconsentNotice />);

    await waitFor(() => expect(screen.getByRole('button', { name: '同意する' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '同意する' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('読み直して');
    });
  });

  it('**強制しない** — 閉じられる。ただし版が変わればまた出る', async () => {
    getJson.mockResolvedValue({ data: NEEDS });
    const { unmount } = render(<ReconsentNotice />);
    await waitFor(() => expect(screen.getByRole('region')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'あとで' }));
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
    unmount();

    // 同じ版なら再表示しない
    const again = render(<ReconsentNotice />);
    await waitFor(() => expect(getJson).toHaveBeenCalledTimes(2));
    expect(again.container.textContent).toBe('');
    again.unmount();

    // **版が変わったら**また出す（閉じたことを永久には引きずらない）
    const newer = {
      items: [
        {
          doc_type: 'terms_of_service',
          current_version: '2026-12-01',
          accepted_version: '2026-05-25',
          needs_consent: true,
        },
      ],
      needs_consent: true,
    };
    getJson.mockResolvedValue({ data: newer });
    render(<ReconsentNotice />);
    await waitFor(() => expect(screen.getByRole('region')).toBeInTheDocument());
  });

  it('版のキーは「要同意のものだけ」から作られる', () => {
    expect(versionKey(NEEDS.items)).toBe('terms_of_service:2026-08-21');
  });
});

describe('GAP-206 503 の理由で案内を変える', () => {
  it('サーバーが理由を申告したら、それを読める', () => {
    const err = new ApiError({
      status: 503,
      statusText: 'Service Unavailable',
      payload: { detail: '保存先が未設定です' },
      path: '/outputs/x',
      method: 'get',
      reason: 'storage_unconfigured',
    });
    expect(err.reason).toBe('storage_unconfigured');
    // **未接続と決めつけない**のがこの GAP の要点
    expect(err.reason === 'bridge_offline').toBe(false);
  });

  it('理由が無ければ null（古い API と混ぜても壊れない）', () => {
    const err = new ApiError({
      status: 503,
      statusText: 'Service Unavailable',
      payload: undefined,
      path: '/x',
      method: 'get',
    });
    expect(err.reason).toBeNull();
  });
});
