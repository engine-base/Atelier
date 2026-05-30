/**
 * Storybook 7+ 設定 — T-I-20 (任意 / Phase 5+).
 *
 * Bundle B/C で作った AppShell / Pickers / Dialog / Toast / Avatar / DataTable 等を
 * 個別に確認するための Storybook 設定。Storybook 8 系 + Next.js framework adapter。
 *
 * 本ファイルは scope を予約するスケルトン。実 stories ファイルは別 PR で追加し
 * `stories` glob から拾う。
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
  addons: [
    '@storybook/addon-essentials',
    '@storybook/addon-a11y',
    '@storybook/addon-interactions',
  ],
  staticDirs: ['../public'],
  docs: {
    autodocs: 'tag',
  },
  typescript: {
    check: false,
    reactDocgen: 'react-docgen-typescript',
  },
};

export default config;
