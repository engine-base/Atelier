/**
 * Form — T-US-11 (React Hook Form + Zod 統合)
 *
 * - useAtelierForm: 既定で zodResolver、mode='onBlur'、reValidateMode='onChange'
 * - Form: <form onSubmit={handleSubmit(onValid)}> を最小ラップ
 * - 子の Field は手動で `{...register('name')}` で配線
 *
 * 依存:
 *   - react-hook-form (T-US-11 で apps/web/package.json に追加)
 *   - @hookform/resolvers (zod resolver)
 *   - zod (既存)
 */

'use client';

import * as React from 'react';
import { type FormEvent, type ReactNode } from 'react';
import {
  type DefaultValues,
  type FieldValues,
  type UseFormProps,
  type UseFormReturn,
  useForm,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';

import { cn } from '../../lib/cn';

export interface UseAtelierFormOptions<Schema extends z.ZodTypeAny> {
  readonly schema: Schema;
  readonly defaultValues?: DefaultValues<z.infer<Schema>>;
  readonly mode?: UseFormProps<z.infer<Schema>>['mode'];
}

export function useAtelierForm<Schema extends z.ZodTypeAny>(
  opts: UseAtelierFormOptions<Schema>,
): UseFormReturn<z.infer<Schema>> {
  return useForm<z.infer<Schema>>({
    resolver: zodResolver(opts.schema),
    defaultValues: opts.defaultValues,
    mode: opts.mode ?? 'onBlur',
    reValidateMode: 'onChange',
  });
}

export interface FormProps<Values extends FieldValues> {
  readonly form: UseFormReturn<Values>;
  readonly onValid: (values: Values) => void | Promise<void>;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Form<Values extends FieldValues>({
  form,
  onValid,
  children,
  className,
}: FormProps<Values>) {
  const submit = (e: FormEvent<HTMLFormElement>) => {
    void form.handleSubmit(onValid)(e);
  };
  return (
    <form onSubmit={submit} className={cn('flex flex-col gap-md', className)} noValidate>
      {children}
    </form>
  );
}
