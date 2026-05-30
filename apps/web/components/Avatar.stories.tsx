/**
 * Avatar stories — T-I-20 (Storybook カタログ).
 *
 * Bundle C の Avatar コンポーネントを各バリアントで確認する。
 * @storybook/addon-a11y が各 story の WCAG 2.2 AA 違反を即時検出する。
 */

import type { Meta, StoryObj } from '@storybook/react';

import { Avatar } from './Avatar';

const meta: Meta<typeof Avatar> = {
  title: 'Components/Avatar',
  component: Avatar,
  parameters: { layout: 'centered' },
  argTypes: {
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
  },
};
export default meta;

type Story = StoryObj<typeof Avatar>;

export const Initials: Story = {
  args: { name: 'Alice Wonder', size: 'md' },
};

export const SingleWord: Story = {
  args: { name: 'tony', size: 'lg' },
};

export const Japanese: Story = {
  args: { name: '鈴木 太郎', size: 'md' },
};

export const Small: Story = {
  args: { name: 'Sam Smith', size: 'sm' },
};
