/**
 * T-UC-02 WorkspaceSettingsForm + T-UC-21 ClientSigninForm tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceSettingsForm } from '../../app/auth/s_a03/_components/WorkspaceSettingsForm';
import { ClientSigninForm } from '../../app/client/s_l02/_components/ClientSigninForm';

describe('WorkspaceSettingsForm (T-UC-02)', () => {
  const defaults = { name: 'My WS', aiLearningOptIn: false };

  it('renders with default values', () => {
    render(<WorkspaceSettingsForm defaultValues={defaults} onSubmit={() => undefined} />);
    expect((screen.getByLabelText(/^名前/) as HTMLInputElement).value).toBe('My WS');
  });

  it('shows danger zone only when onDelete provided', () => {
    const { rerender } = render(
      <WorkspaceSettingsForm defaultValues={defaults} onSubmit={() => undefined} />,
    );
    expect(screen.queryByText('Danger Zone')).toBeNull();
    rerender(
      <WorkspaceSettingsForm
        defaultValues={defaults}
        onSubmit={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(screen.getByText('Danger Zone')).toBeInTheDocument();
  });

  it('invokes onDelete only after 2-step confirmation (design-audit v2)', () => {
    const onDelete = vi.fn();
    render(
      <WorkspaceSettingsForm
        defaultValues={defaults}
        onSubmit={() => undefined}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'ワークスペースを削除' }));
    // 1 クリック目は確認表示のみ
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '削除を確定' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('cancel aborts the delete confirmation', () => {
    const onDelete = vi.fn();
    render(
      <WorkspaceSettingsForm
        defaultValues={defaults}
        onSubmit={() => undefined}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'ワークスペースを削除' }));
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('blocks submit when name is empty', async () => {
    const onSubmit = vi.fn();
    render(
      <WorkspaceSettingsForm
        defaultValues={{ name: '', aiLearningOptIn: false }}
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

describe('ClientSigninForm (T-UC-21)', () => {
  it('uses defaultToken when provided', () => {
    render(<ClientSigninForm defaultToken="invite-12345" onSubmit={() => undefined} />);
    expect((screen.getByLabelText(/招待トークン/) as HTMLInputElement).value).toBe(
      'invite-12345',
    );
  });

  it('blocks submit when token too short', async () => {
    const onSubmit = vi.fn();
    render(<ClientSigninForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/招待トークン/), { target: { value: 'short' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'プロジェクトを開く' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('accepts optional display_name', async () => {
    const onSubmit = vi.fn();
    render(<ClientSigninForm defaultToken="invite-12345678" onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/表示名/), { target: { value: 'Client A' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'プロジェクトを開く' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSubmit).toHaveBeenCalled();
    expect((onSubmit.mock.calls[0]![0] as { display_name?: string }).display_name).toBe(
      'Client A',
    );
  });
});
