/**
 * Skeleton stories — T-I-20.
 */

import type { Meta, StoryObj } from '@storybook/react';

import { Skeleton } from './Skeleton';

const meta: Meta<typeof Skeleton> = {
  title: 'Components/Skeleton',
  component: Skeleton,
  parameters: { layout: 'centered' },
  argTypes: {
    shape: { control: 'inline-radio', options: ['rect', 'circle', 'text'] },
  },
};
export default meta;

type Story = StoryObj<typeof Skeleton>;

export const Rect: Story = {
  args: { shape: 'rect', width: 200, height: 40 },
};

export const Circle: Story = {
  args: { shape: 'circle', width: 48, height: 48 },
};

export const Text: Story = {
  args: { shape: 'text', width: 240 },
};
