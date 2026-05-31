import type { Config } from 'tailwindcss';

import {
  colors,
  rounded,
  spacing,
  typography,
} from './packages/design-tokens/src/index.js';

// content グロブは Tailwind の CWD (= postcss 実行ディレクトリ) 基準で解決される。
// 環境により CWD が異なる:
//   - ローカル/CI/Fly: repo root
//   - Vercel (Root Directory=apps/web): apps/web
// 片方の相対形だけだと 0 マッチ → 全ユーティリティ purge → CSS 空 (無装飾) になる。
// __dirname は .ts config ローダーによって解決が不定なので使わず、両 CWD 用の
// 相対グロブを両方列挙する。マッチしないグロブは Tailwind が無視するため安全。
const config: Config = {
  content: [
    // CWD = repo root のとき
    './apps/web/app/**/*.{ts,tsx}',
    './apps/web/components/**/*.{ts,tsx}',
    './packages/**/src/**/*.{ts,tsx}',
    // CWD = apps/web のとき (Vercel Root Directory=apps/web)
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    '../../packages/**/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: colors.primary,
          fg: colors.onPrimary,
          container: colors.primaryContainer,
          'container-fg': colors.onPrimaryContainer,
        },
        secondary: {
          DEFAULT: colors.secondary,
          fg: colors.onSecondary,
          container: colors.secondaryContainer,
          'container-fg': colors.onSecondaryContainer,
        },
        tertiary: {
          DEFAULT: colors.tertiary,
          fg: colors.onTertiary,
          container: colors.tertiaryContainer,
          'container-fg': colors.onTertiaryContainer,
        },
        surface: {
          DEFAULT: colors.surface,
          fg: colors.onSurface,
          variant: colors.surfaceVariant,
          'variant-fg': colors.onSurfaceVariant,
        },
        error: {
          DEFAULT: colors.error,
          fg: colors.onError,
        },
        neutral: {
          DEFAULT: colors.neutral,
          fg: colors.onNeutral,
        },
      },
      spacing: {
        xs: spacing.xs,
        sm: spacing.sm,
        md: spacing.md,
        lg: spacing.lg,
        xl: spacing.xl,
        '2xl': spacing['2xl'],
      },
      borderRadius: {
        none: rounded.none,
        sm: rounded.sm,
        md: rounded.md,
        lg: rounded.lg,
        xl: rounded.xl,
        full: rounded.full,
      },
      fontFamily: {
        sans: ['"Noto Sans JP"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      fontSize: {
        'headline-display': [
          typography['headline-display'].fontSize,
          {
            lineHeight: String(typography['headline-display'].lineHeight),
            letterSpacing: typography['headline-display'].letterSpacing,
            fontWeight: typography['headline-display'].fontWeight,
          },
        ],
        'headline-lg': [
          typography['headline-lg'].fontSize,
          {
            lineHeight: String(typography['headline-lg'].lineHeight),
            letterSpacing: typography['headline-lg'].letterSpacing,
            fontWeight: typography['headline-lg'].fontWeight,
          },
        ],
        'headline-md': [
          typography['headline-md'].fontSize,
          {
            lineHeight: String(typography['headline-md'].lineHeight),
            fontWeight: typography['headline-md'].fontWeight,
          },
        ],
        'body-lg': [
          typography['body-lg'].fontSize,
          {
            lineHeight: String(typography['body-lg'].lineHeight),
            letterSpacing: typography['body-lg'].letterSpacing,
            fontWeight: typography['body-lg'].fontWeight,
          },
        ],
        'body-md': [
          typography['body-md'].fontSize,
          {
            lineHeight: String(typography['body-md'].lineHeight),
            fontWeight: typography['body-md'].fontWeight,
          },
        ],
        'body-sm': [
          typography['body-sm'].fontSize,
          {
            lineHeight: String(typography['body-sm'].lineHeight),
            fontWeight: typography['body-sm'].fontWeight,
          },
        ],
        'label-lg': [
          typography['label-lg'].fontSize,
          {
            letterSpacing: typography['label-lg'].letterSpacing,
            fontWeight: typography['label-lg'].fontWeight,
          },
        ],
        'label-md': [
          typography['label-md'].fontSize,
          {
            letterSpacing: typography['label-md'].letterSpacing,
            fontWeight: typography['label-md'].fontWeight,
          },
        ],
        'label-sm': [
          typography['label-sm'].fontSize,
          {
            letterSpacing: typography['label-sm'].letterSpacing,
            fontWeight: typography['label-sm'].fontWeight,
          },
        ],
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'in-out-quart': 'cubic-bezier(0.76, 0, 0.24, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
