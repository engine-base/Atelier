/**
 * T-UC-01 SigninForm / SignupForm tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SigninForm } from '../../app/auth/s_a01/_components/SigninForm';
import { SignupForm } from '../../app/auth/s_a01/_components/SignupForm';

describe('SigninForm (T-UC-01)', () => {
  it('renders email/password fields and submit', () => {
    render(<SigninForm onSubmit={() => undefined} />);
    expect(screen.getByLabelText(/メールアドレス/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^パスワード/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'サインイン' })).toBeInTheDocument();
  });

  it('blocks submit and shows validation error for empty email', async () => {
    const onSubmit = vi.fn();
    render(<SigninForm onSubmit={onSubmit} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'サインイン' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText(/メール形式/)).toBeInTheDocument();
  });

  it('locked state shows alert and disables submit', () => {
    render(<SigninForm onSubmit={() => undefined} locked />);
    const alerts = screen.getAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'サインイン' })).toBeDisabled();
  });

  it('shows serverError when provided', () => {
    render(<SigninForm onSubmit={() => undefined} serverError="認証に失敗しました" />);
    expect(screen.getByText('認証に失敗しました')).toBeInTheDocument();
  });

  it('magic link button calls onMagicLink with current email', () => {
    const onMagicLink = vi.fn();
    render(<SigninForm onSubmit={() => undefined} onMagicLink={onMagicLink} />);
    fireEvent.change(screen.getByLabelText(/メールアドレス/), {
      target: { value: 'a@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /マジックリンク/ }));
    expect(onMagicLink).toHaveBeenCalledWith('a@example.com');
  });
});

describe('SignupForm (T-UC-01)', () => {
  it('renders email/password/confirm/consent fields', () => {
    render(<SignupForm onSubmit={() => undefined} />);
    expect(screen.getByLabelText(/メールアドレス/)).toBeInTheDocument();
    // 「パスワード」と「パスワード確認」の 2 つがあるため getAll
    expect(screen.getAllByLabelText(/^パスワード/).length).toBe(2);
    expect(screen.getByLabelText(/パスワード確認/)).toBeInTheDocument();
  });

  it('requires consent', async () => {
    const onSubmit = vi.fn();
    render(<SignupForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/メールアドレス/), {
      target: { value: 'a@example.com' },
    });
    const passwordInputs = screen.getAllByLabelText(/^パスワード/);
    fireEvent.change(passwordInputs[0]!, { target: { value: 'abcdefgh' } });
    fireEvent.change(screen.getByLabelText(/パスワード確認/), {
      target: { value: 'abcdefgh' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '新規登録' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    // 同意 label と zod error の両方が表示されるので、role=alert で error メッセージのみ取る
    expect(await screen.findByRole('alert')).toHaveTextContent(/同意/);
  });

  it('mismatched password shows confirm error', async () => {
    const onSubmit = vi.fn();
    render(<SignupForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/メールアドレス/), {
      target: { value: 'a@example.com' },
    });
    const passwordInputs = screen.getAllByLabelText(/^パスワード/);
    fireEvent.change(passwordInputs[0]!, { target: { value: 'abcdefgh' } });
    fireEvent.change(screen.getByLabelText(/パスワード確認/), {
      target: { value: 'differentpw' },
    });
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '新規登録' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText(/一致しません/)).toBeInTheDocument();
  });
});
