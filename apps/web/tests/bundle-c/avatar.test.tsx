/**
 * T-US-09 Avatar + EmployeeIcon tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Avatar, deriveInitials } from '../../components/Avatar';
import { EMPLOYEE_IDS, EmployeeIcon } from '../../components/EmployeeIcon';

describe('deriveInitials', () => {
  it('returns ? for empty string', () => {
    expect(deriveInitials('')).toBe('?');
  });
  it('uses 2 initials from 2-word ASCII name', () => {
    expect(deriveInitials('Sam Smith')).toBe('SS');
  });
  it('uses first 2 chars of single-word ASCII name', () => {
    expect(deriveInitials('alice')).toBe('AL');
  });
  it('uses first 2 chars for Japanese name', () => {
    expect(deriveInitials('鈴木 太郎')).toBe('鈴木');
  });
});

describe('Avatar (T-US-09)', () => {
  it('renders initials when src is not provided', () => {
    render(<Avatar name="Alice Wonder" />);
    expect(screen.getByText('AW')).toBeInTheDocument();
  });

  it('renders img when src is provided with name as alt', () => {
    render(<Avatar name="Alice" src="https://x/y.png" />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('alt')).toBe('Alice');
  });

  it('uses custom alt when provided', () => {
    render(<Avatar name="A" src="https://x/y.png" alt="hello" />);
    expect(screen.getByRole('img').getAttribute('alt')).toBe('hello');
  });

  it('falls back to initials on image error', () => {
    render(<Avatar name="Fallback Person" src="https://x/y.png" />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByText('FP')).toBeInTheDocument();
  });

  it('decorative: aria-hidden and empty alt', () => {
    render(<Avatar name="X" decorative src="https://x/y.png" />);
    const img = screen.getByAltText('');
    expect(img.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('EmployeeIcon (T-US-09)', () => {
  it('exports 7 employees', () => {
    expect(EMPLOYEE_IDS.length).toBe(7);
  });

  it.each(EMPLOYEE_IDS)('renders %s with AI 社員 a11y label', (id) => {
    render(<EmployeeIcon employeeId={id} />);
    expect(screen.getByRole('img', { name: /AI 社員/ })).toBeInTheDocument();
  });
});
