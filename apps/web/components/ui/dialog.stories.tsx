/**
 * Dialog stories — T-I-20.
 *
 * open 状態の Dialog をカタログ表示。a11y addon で aria-modal / focus を検査。
 */

import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { Dialog } from './dialog';

const meta: Meta<typeof Dialog> = {
  title: 'Components/Dialog',
  component: Dialog,
};
export default meta;

type Story = StoryObj<typeof Dialog>;

export const Open: Story = {
  args: {
    open: true,
    title: 'サンプルダイアログ',
    onClose: () => undefined,
    children: <p>ここに本文が入ります。</p>,
  },
};

export const WithFooter: Story = {
  args: {
    open: true,
    title: '確認',
    onClose: () => undefined,
    children: <p>この操作を実行しますか?</p>,
    footer: (
      <>
        <button type="button">キャンセル</button>
        <button type="button">OK</button>
      </>
    ),
  },
};
