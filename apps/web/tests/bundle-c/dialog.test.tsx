/**
 * T-US-08 Dialog tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Dialog } from '../../components/ui/dialog';

describe('Dialog (T-US-08)', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <Dialog open={false} onClose={() => undefined} title="X">
        body
      </Dialog>,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders dialog with role/aria-modal/aria-labelledby when open', () => {
    render(
      <Dialog open onClose={() => undefined} title="My Title">
        body
      </Dialog>,
    );
    const dlg = screen.getByRole('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    const titleEl = screen.getByText('My Title');
    expect(dlg.getAttribute('aria-labelledby')).toBe(titleEl.id);
  });

  it('invokes onClose on Escape key', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="X">
        body
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('invokes onClose on overlay click by default', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog open onClose={onClose} title="X">
        body
      </Dialog>,
    );
    const overlay = container.querySelector('[role="presentation"]');
    fireEvent.click(overlay!);
    expect(onClose).toHaveBeenCalled();
  });

  it('does NOT invoke onClose on overlay click when closeOnOverlay=false', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog open onClose={onClose} closeOnOverlay={false} title="X">
        body
      </Dialog>,
    );
    fireEvent.click(container.querySelector('[role="presentation"]')!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders footer slot', () => {
    render(
      <Dialog open onClose={() => undefined} title="X" footer={<button>OK</button>}>
        body
      </Dialog>,
    );
    expect(screen.getByText('OK')).toBeInTheDocument();
  });
});
