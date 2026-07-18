/**
 * T-UC-14/15/16/17 tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  KanbanBoard,
  STAGE_ORDER,
  type TaskCard,
} from '../../app/tasks/s_i01/_components/KanbanBoard';
import { TaskDetailTabs } from '../../app/tasks/s_i02/_components/TaskDetailTabs';
import { ExecutionMonitor, type LogLine } from '../../app/tasks/s_i03/_components/ExecutionMonitor';
import {
  ApprovalsList,
  type ApprovalRow,
} from '../../app/approvals/s_j01/_components/ApprovalsList';

describe('KanbanBoard (T-UC-14)', () => {
  const tasks: TaskCard[] = [
    { id: 't1', title: 'A', stage: 'ready' },
    { id: 't2', title: 'B', stage: 'in_progress' },
    { id: 't3', title: 'C', stage: 'blocked' },
  ];

  it('renders 6 columns', () => {
    render(<KanbanBoard tasks={tasks} />);
    expect(STAGE_ORDER.length).toBe(6);
    for (const stage of STAGE_ORDER) {
      // レーン名は凡例と同一語に統一 (モック準拠。旧: バックログ/実行可/進行中/ブロック)
      const label = {
        backlog: '準備中',
        ready: '着手可',
        in_progress: '実装中',
        awaiting: '承認待ち',
        done: '完了',
        blocked: '要対応',
      }[stage];
      expect(screen.getByRole('region', { name: label })).toBeInTheDocument();
    }
  });

  it('shows play button only for ready and blocked tasks when onPlay provided', () => {
    const onPlay = vi.fn();
    render(<KanbanBoard tasks={tasks} onPlay={onPlay} />);
    const playButtons = screen.getAllByText(/再生/);
    expect(playButtons.length).toBe(2); // ready + blocked
    fireEvent.click(playButtons[0]!);
    expect(onPlay).toHaveBeenCalled();
  });

  it('hides play buttons when onPlay not provided', () => {
    render(<KanbanBoard tasks={tasks} />);
    expect(screen.queryByText(/再生/)).toBeNull();
  });
});

describe('TaskDetailTabs (T-UC-15)', () => {
  it('renders 6 tabs and switches on click', () => {
    render(<TaskDetailTabs title="X" />);
    const tablist = screen.getByRole('tablist');
    const tabs = tablist.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(6);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(tabs[2]!);
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false');
  });
});

describe('ExecutionMonitor (T-UC-16)', () => {
  const lines: LogLine[] = [
    { id: '1', ts: '10:00', level: 'info', message: 'start' },
    { id: '2', ts: '10:01', level: 'error', message: 'oops' },
  ];

  it('renders log role with aria-live polite', () => {
    render(<ExecutionMonitor lines={lines} />);
    const log = screen.getByRole('log');
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('start')).toBeInTheDocument();
    expect(screen.getByText('oops')).toBeInTheDocument();
  });

  it('shows level abbreviations', () => {
    render(<ExecutionMonitor lines={lines} />);
    expect(screen.getByText('INF')).toBeInTheDocument();
    expect(screen.getByText('ERR')).toBeInTheDocument();
  });
});

describe('ApprovalsList (T-UC-17)', () => {
  const rows: ApprovalRow[] = [
    {
      id: 'a1',
      kind: 'task_approval',
      title: 'X',
      requester: 'tony',
      created_at: '5m',
    },
  ];

  it('renders kind label, title, and action buttons', () => {
    render(
      <ApprovalsList rows={rows} onApprove={() => undefined} onReject={() => undefined} />,
    );
    expect(screen.getByText('タスク')).toBeInTheDocument();
    expect(screen.getByText('X')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'X を承認' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'X を却下' })).toBeInTheDocument();
  });

  it('invokes onApprove and onReject', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ApprovalsList rows={rows} onApprove={onApprove} onReject={onReject} />);
    fireEvent.click(screen.getByRole('button', { name: 'X を承認' }));
    fireEvent.click(screen.getByRole('button', { name: 'X を却下' }));
    expect(onApprove).toHaveBeenCalledWith('a1');
    expect(onReject).toHaveBeenCalledWith('a1');
  });

  it('shows empty message when no rows', () => {
    render(<ApprovalsList rows={[]} onApprove={() => undefined} onReject={() => undefined} />);
    expect(screen.getByText('承認待ち項目はありません')).toBeInTheDocument();
  });
});
