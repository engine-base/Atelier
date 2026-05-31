import type { Config } from 'tailwindcss';

import {
  colors,
  rounded,
  spacing,
  typography,
} from '@atelier/design-tokens';

/**
 * apps/web 専用 Tailwind 設定 (自己完結)。
 *
 * Next.js が apps/web を project root として自動検出する正準位置。
 * postcss.config.mjs が `tailwindcss: {}` で本ファイルを読む。content グロブは
 * 本ファイル基準の相対なので CWD/ビルド環境 (ローカル/Vercel) 非依存で常にマッチ。
 *
 * 旧構成: postcss が `config: '../../tailwind.config.ts'` という CWD 相対の文字列
 * パスで root config を参照していたが、Vercel ビルドで解決失敗 → Tailwind が空の
 * デフォルト設定にフォールバック → 全 utility/token が消え preflight(9KB)のみ
 * (画面が無装飾) になっていた。本ファイルで解消する。
 *
 * design-tokens は workspace 依存 (@atelier/design-tokens) として解決するため、
 * root config を import せず tsc 型チェックも自己完結する。
 */
const config: Config = {
  content: [
    './app/**/*.{ts,tsx,mdx}',
    './components/**/*.{ts,tsx,mdx}',
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
