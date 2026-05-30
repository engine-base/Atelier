/**
 * Storybook 8 設定 — T-I-20.
 *
 * Bundle B/C で作った Avatar / Skeleton / Dialog / DataTable 等を個別に確認する。
 * @storybook/addon-a11y が各 story の WCAG 2.2 AA 違反を即時検出する。
 *
 * Builder: @storybook/nextjs-vite (Storybook 10+) を使う。
 * 理由: SB8 default の `@storybook/nextjs` (webpack5) は Next 15 と互換性が無く
 *       `SB_BUILDER-WEBPACK5_0002 reading 'tap' of undefined` で build 不能。
 *       SB8.6 の experimental-nextjs-vite も vite-plugin-storybook-nextjs@1.x 経由で
 *       Next 14 internal path に依存 (Next 15 で消えた) → build 不能。
 *       SB10 の nextjs-vite + vite-plugin-storybook-nextjs@3.x は Next 15 + React 19 で動く。
 */

import type { StorybookConfig } from '@storybook/nextjs-vite';

const config: StorybookConfig = {
  framework: {
    name: '@storybook/nextjs-vite',
    options: {},
  },
  stories: [
    '../components/**/*.stories.@(ts|tsx|mdx)',
    '../app/**/*.stories.@(ts|tsx|mdx)',
  ],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  typescript: {
    check: false,
    reactDocgen: 'react-docgen-typescript',
  },
};

export default config;
