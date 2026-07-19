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
    { id: 'i1', email: 'a@x.com', status: 'pending', expires_at: '2026-06-30' },
    { id: 'i2', email: 'b@x.com', status: 'used', expires_at: '2026-06-30' },
  ];

  it('renders status labels', () => {
    render(
      <InvitationsList
        invitations={invs}
        onIssue={() => undefined}
        onRevoke={() => undefined}
        onResend={() => undefined}
      />,
    );
    expect(screen.getByText('未使用')).toBeInTheDocument();
    expect(screen.getByText('使用済')).toBeInTheDocument();
  });

  it('shows resend/revoke only for pending', () => {
    render(
      <InvitationsList
        invitations={invs}
        onIssue={() => undefined}
        onRevoke={() => undefined}
        onResend={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'a@x.com に再送' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'b@x.com に再送' })).toBeNull();
  });

  it('issues invitation on form submit', () => {
    const onIssue = vi.fn();
    render(
      <InvitationsList
        invitations={[]}
        onIssue={onIssue}
        onRevoke={() => undefined}
        onResend={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText(/招待メールアドレス/), {
      target: { value: 'new@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '招待を発行' }));
    expect(onIssue).toHaveBeenCalledWith('new@example.com');
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
