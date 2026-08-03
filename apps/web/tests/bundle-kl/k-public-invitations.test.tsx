/**
 * Bundle K+L tests: InvitationsList / DataDeletionForm / 横断 page
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  InvitationsList,
  type Invitation,
} from '../../app/client/s_l01/_components/InvitationsList';
import { DataDeletionForm } from '../../app/public/s_pub04/_components/DataDeletionForm';

describe('InvitationsList (T-UC-20)', () => {
  const invs: Invitation[] = [
    {
      id: 'i1',
      email: 'a@x.com',
      displayName: '小松 太郎',
      status: 'pending',
      expires_at: '2999-06-30',
    },
    {
      id: 'i2',
      email: 'b@x.com',
      status: 'used',
      expires_at: '2999-06-30',
      usedAt: '2026-06-01',
    },
    {
      id: 'i3',
      email: 'c@x.com',
      status: 'revoked',
      expires_at: '2026-05-05',
      endDate: '2026-05-01',
    },
  ];

  it('renders status labels, display names and used dates', () => {
    render(
      <InvitationsList
        invitations={invs}
        onIssue={() => undefined}
        onRevoke={() => undefined}
      />,
    );
    expect(screen.getByText('未使用')).toBeInTheDocument();
    expect(screen.getByText('使用済')).toBeInTheDocument();
    expect(screen.getByText('失効')).toBeInTheDocument();
    // 表示名 + メール (client_display_name 実データ)
    expect(screen.getByText('小松 太郎')).toBeInTheDocument();
    expect(screen.getByText('a@x.com')).toBeInTheDocument();
    // 使用日 / 終了日 (used_at / revoked_at 実データ)
    expect(screen.getByText('2026-06-01')).toBeInTheDocument();
    expect(screen.getByText('2026-05-01')).toBeInTheDocument();
    // 再送 API は無いため再送ボタンを出さない (Rule 10)
    expect(screen.queryByRole('button', { name: /再送/ })).toBeNull();
  });

  it('issues invitation with all form params (display name / ttl / scopes)', () => {
    const onIssue = vi.fn();
    render(
      <InvitationsList
        invitations={[]}
        onIssue={onIssue}
        onRevoke={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText(/クライアント表示名/), {
      target: { value: '福浦 様' },
    });
    fireEvent.change(screen.getByLabelText(/招待メールアドレス/), {
      target: { value: 'new@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/有効期限/), {
      target: { value: '14' },
    });
    fireEvent.change(screen.getByLabelText(/スコープ/), {
      target: { value: 'view' },
    });
    fireEvent.click(screen.getByRole('button', { name: '招待を発行' }));
    expect(onIssue).toHaveBeenCalledWith({
      email: 'new@example.com',
      displayName: '福浦 様',
      ttlDays: 14,
      scopes: ['view'],
    });
  });

  it('revokes only after a 2-step confirmation', () => {
    const onRevoke = vi.fn();
    render(
      <InvitationsList
        invitations={invs}
        onIssue={() => undefined}
        onRevoke={onRevoke}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'a@x.com を失効' }));
    expect(onRevoke).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'a@x.com の失効を確定' }),
    );
    expect(onRevoke).toHaveBeenCalledWith('i1');
  });

  it('resends only after a 2-step confirmation, pending rows only (GAP-027)', () => {
    const onResend = vi.fn();
    render(
      <InvitationsList
        invitations={invs}
        onIssue={() => undefined}
        onRevoke={() => undefined}
        onResend={onResend}
      />,
    );
    // used 行 (b@x.com) には再送ボタンが出ない
    expect(
      screen.queryByRole('button', { name: 'b@x.com へ招待メールを再送' }),
    ).toBeNull();
    // pending 行は 2 段階確認 (旧リンク失効を伴うため)
    fireEvent.click(
      screen.getByRole('button', { name: 'a@x.com へ招待メールを再送' }),
    );
    expect(onResend).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'a@x.com へ再送を確定 (旧リンクは失効)',
      }),
    );
    expect(onResend).toHaveBeenCalledWith('i1');
  });

  it('hides resend buttons when onResend is not provided (Rule 10)', () => {
    render(
      <InvitationsList
        invitations={invs}
        onIssue={() => undefined}
        onRevoke={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: /再送/ })).toBeNull();
  });

  it('reissues from history with the original display name', () => {
    const onIssue = vi.fn();
    render(
      <InvitationsList
        invitations={[
          {
            id: 'i9',
            email: 'old@x.com',
            displayName: '山田 様',
            status: 'expired',
            expires_at: '2026-05-10',
            endDate: '2026-05-10',
          },
        ]}
        onIssue={onIssue}
        onRevoke={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'old@x.com を再発行' }));
    expect(onIssue).toHaveBeenCalledWith({
      email: 'old@x.com',
      displayName: '山田 様',
      ttlDays: 7,
      scopes: ['view', 'comment'],
    });
  });
});

describe('DataDeletionForm (T-UC-29)', () => {
  const base = { email: 'you@example.com' };

  it('shows the logged-in email as display-only (mock parity)', () => {
    render(<DataDeletionForm {...base} onSubmit={vi.fn()} />);
    const email = screen.getByLabelText(
      'メールアドレス（ログイン中のアカウント）',
    ) as HTMLInputElement;
    expect(email.value).toBe('you@example.com');
    expect(email).toBeDisabled();
  });

  it('blocks submit until 「削除する」 is typed and consent is checked', async () => {
    const onSubmit = vi.fn();
    render(<DataDeletionForm {...base} onSubmit={onSubmit} />);
    // 確認テキスト未入力 + 同意なし → 送信不可
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '削除を申請する' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    // 誤テキストでも不可
    fireEvent.change(screen.getByLabelText(/確認のため/), {
      target: { value: '削除' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '削除を申請する' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    const alerts = await screen.findAllByRole('alert');
    expect(
      alerts.some((a) => a.textContent?.includes('「削除する」と入力')),
    ).toBe(true);
  });

  it('submits with 「削除する」 typed + consent, passing the optional reason', async () => {
    const onSubmit = vi.fn();
    render(<DataDeletionForm {...base} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/削除を希望する理由/), {
      target: { value: '利用終了のため' },
    });
    fireEvent.change(screen.getByLabelText(/確認のため/), {
      target: { value: '削除する' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '削除を申請する' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      reason: '利用終了のため',
      confirm_text: '削除する',
      consent: true,
    });
  });

  it('renders the danger checklist and schedule (mock parity)', () => {
    render(<DataDeletionForm {...base} onSubmit={vi.fn()} />);
    expect(screen.getByText('削除される内容')).toBeInTheDocument();
    expect(
      screen.getByText('アカウント情報（メール・名前・アバター）'),
    ).toBeInTheDocument();
    expect(screen.getByText('削除スケジュール')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'キャンセル' })).toHaveAttribute(
      'href',
      '/privacy',
    );
  });
});
