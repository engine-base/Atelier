/**
 * Storybook preview — T-I-20 (任意 / Phase 5+).
 *
 * global decorators / parameters / a11y 設定。
 */

import type { Preview } from '@storybook/react';

import '../app/globals.css';

const preview: Preview = {
  parameters: {
    actions: { argTypesRegex: '^on[A-Z].*' },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'surface',
      values: [
        { name: 'surface', value: '#FEFCF8' },
        { name: 'dark', value: '#0F172A' },
      ],
    },
    a11y: {
      element: '#storybook-root',
      config: {
        rules: [
          // WCAG 2.2 AA
          { id: 'wcag22aa', enabled: true },
        ],
      },
      options: {},
      manual: false,
    },
  },
};

export default preview;
