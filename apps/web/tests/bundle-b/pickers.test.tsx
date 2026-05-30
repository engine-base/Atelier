/**
 * T-US-02: WorkspacePicker + ProjectPicker tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectPicker } from '../../components/ProjectPicker';
import { WorkspacePicker } from '../../components/WorkspacePicker';

const WS_OPTIONS = [
  { id: 'w1', name: 'WS Alpha' },
  { id: 'w2', name: 'WS Beta' },
];
const PROJ_OPTIONS = [
  { id: 'p1', name: 'P1' },
  { id: 'p2', name: 'P2' },
];

describe('WorkspacePicker', () => {
  it('shows current workspace name in trigger', () => {
    render(<WorkspacePicker value="w2" options={WS_OPTIONS} onChange={() => undefined} />);
    expect(screen.getByText('WS Beta')).toBeInTheDocument();
  });

  it('shows loading label when value is undefined', () => {
    render(<WorkspacePicker value={undefined} options={WS_OPTIONS} onChange={() => undefined} />);
    expect(screen.getByText(/読み込み中/)).toBeInTheDocument();
  });

  it('opens listbox with aria-expanded toggle', () => {
    render(<WorkspacePicker value="w1" options={WS_OPTIONS} onChange={() => undefined} />);
    const trigger = screen.getByRole('button');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('calls onChange when an option is selected and closes', () => {
    const onChange = vi.fn();
    render(<WorkspacePicker value="w1" options={WS_OPTIONS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('WS Beta'));
    expect(onChange).toHaveBeenCalledWith('w2');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('selects via keyboard Enter on option', () => {
    const onChange = vi.fn();
    render(<WorkspacePicker value="w1" options={WS_OPTIONS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.keyDown(screen.getByText('WS Beta'), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('w2');
  });
});

describe('ProjectPicker', () => {
  it('shows current project name in trigger', () => {
    render(<ProjectPicker value="p1" options={PROJ_OPTIONS} onChange={() => undefined} />);
    expect(screen.getByText('P1')).toBeInTheDocument();
  });

  it('marks selected option with aria-selected', () => {
    render(<ProjectPicker value="p2" options={PROJ_OPTIONS} onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button'));
    const selected = screen.getByRole('option', { name: 'P2' });
    expect(selected.getAttribute('aria-selected')).toBe('true');
  });
});
