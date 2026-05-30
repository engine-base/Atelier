/**
 * Storybook 8 設定 — T-I-20.
 *
 * Bundle B/C で作った Avatar / Skeleton / Dialog / DataTable 等を個別に確認する。
 * @storybook/addon-a11y が各 story の WCAG 2.2 AA 違反を即時検出する。
 * 依存は apps/web/package.json に追加済 (storybook + @storybook/nextjs + addons)。
 */

import type { StorybookConfig } from '@storybook/nextjs';

const config: StorybookConfig = {
  framework: {
    name: '@storybook/nextjs',
    options: {},
  },
  stories: [
    '../components/**/*.stories.@(ts|tsx|mdx)',
    '../app/**/*.stories.@(ts|tsx|mdx)',
  ],
  addons: ['@storybook/addon-essentials', '@storybook/addon-a11y'],
  docs: {
    autodocs: 'tag',
  },
  typescript: {
    check: false,
    reactDocgen: 'react-docgen-typescript',
  },
};

export default config;
