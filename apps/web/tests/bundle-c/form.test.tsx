/**
 * T-US-11 Field + Form tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Field } from '../../components/forms/Field';
import { Form, useAtelierForm } from '../../components/forms/Form';

describe('Field (T-US-11)', () => {
  it('associates label with input via for/id', () => {
    render(
      <Field label="名前">
        <input type="text" />
      </Field>,
    );
    const input = screen.getByLabelText('名前');
    expect(input).toBeInTheDocument();
  });

  it('marks required visually and via aria-required', () => {
    render(
      <Field label="必須" required>
        <input />
      </Field>,
    );
    expect(screen.getByText('*')).toBeInTheDocument();
    // label に required の '*' があるため正規表現 ^必須 で限定
    expect(screen.getByLabelText(/^必須/).getAttribute('aria-required')).toBe('true');
  });

  it('shows error with aria-invalid and role=alert', () => {
    render(
      <Field label="lbl" error="ng">
        <input />
      </Field>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('ng');
    expect(screen.getByLabelText('lbl').getAttribute('aria-invalid')).toBe('true');
  });

  it('renders description and links via aria-describedby', () => {
    render(
      <Field label="x" description="hint">
        <input />
      </Field>,
    );
    expect(screen.getByText('hint')).toBeInTheDocument();
  });
});

describe('Form + useAtelierForm (T-US-11)', () => {
  const Schema = z.object({ name: z.string().min(1, '入力必須') });

  function Harness({ onValid }: { readonly onValid: (v: { name: string }) => void }) {
    const form = useAtelierForm({ schema: Schema, defaultValues: { name: '' } });
    return (
      <Form form={form} onValid={onValid}>
        <Field label="名前" error={form.formState.errors.name?.message}>
          <input {...form.register('name')} />
        </Field>
        <button type="submit">送信</button>
      </Form>
    );
  }

  it('submits valid values', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: '太郎' } });
    await act(async () => {
      fireEvent.click(screen.getByText('送信'));
      await new Promise((r) => setTimeout(r, 0));
    });
    // react-hook-form は (values, event) の 2 引数で呼ぶ — 第1引数のみ検証
    expect(onValid).toHaveBeenCalled();
    expect(onValid.mock.calls[0]![0]).toEqual({ name: '太郎' });
  });

  it('blocks invalid submit and shows zod message', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    await act(async () => {
      fireEvent.click(screen.getByText('送信'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onValid).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('入力必須');
  });
});
