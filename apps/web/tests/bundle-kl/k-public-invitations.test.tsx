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
  it('blocks submit on mismatched emails and shows mismatch error', async () => {
    const onSubmit = vi.fn();
    render(<DataDeletionForm onSubmit={onSubmit} />);
    const [emailInput, emailConfirmInput] = screen.getAllByLabelText(/^メールアドレス/);
    fireEvent.change(emailInput!, { target: { value: 'a@example.com' } });
    fireEvent.change(emailConfirmInput!, { target: { value: 'different@example.com' } });
    // consent も check して email mismatch だけが残るようにする
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '削除請求を送信' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    // role=alert で error メッセージを取る
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => a.textContent?.includes('一致しません'))).toBe(true);
  });

  it('submits with valid input', async () => {
    const onSubmit = vi.fn();
    render(<DataDeletionForm onSubmit={onSubmit} />);
    const [emailInput, emailConfirmInput] = screen.getAllByLabelText(/^メールアドレス/);
    fireEvent.change(emailInput!, { target: { value: 'a@example.com' } });
    fireEvent.change(emailConfirmInput!, { target: { value: 'a@example.com' } });
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '削除請求を送信' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSubmit).toHaveBeenCalled();
  });
});
