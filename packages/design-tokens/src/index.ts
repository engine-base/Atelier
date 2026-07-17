/**
 * Atelier デザイントークン (TypeScript)
 *
 * 信頼源: 05_design/DESIGN-atelier.md
 * これを変更する際は DESIGN-atelier.md を先に編集し、ここに反映する。
 *
 * 「工房の静謐 × 編集者の精密」— Material Design 3 命名規則 + 生成り背景。
 */

export const colors = {
  primary: '#2563EB',
  onPrimary: '#FFFFFF',
  primaryContainer: '#DBEAFE',
  onPrimaryContainer: '#1E3A8A',
  secondary: '#C7A04A',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#FAEDC4',
  onSecondaryContainer: '#5C4A1E',
  tertiary: '#14B8A6',
  onTertiary: '#FFFFFF',
  tertiaryContainer: '#CCFBF1',
  onTertiaryContainer: '#134E4A',
  surface: '#FEFCF8',
  onSurface: '#0F172A',
  surfaceVariant: '#F4F1EC',
  onSurfaceVariant: '#475569',
  error: '#DC2626',
  onError: '#FFFFFF',
  neutral: '#94A3B8',
  onNeutral: '#0F172A',
  border: '#E7E5E4',
} as const;

export type ColorToken = keyof typeof colors;

export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '48px',
  '2xl': '96px',
} as const;

export type SpacingToken = keyof typeof spacing;

export const rounded = {
  none: '0px',
  sm: '4px',
  md: '8px',
  lg: '16px',
  xl: '24px',
  full: '9999px',
} as const;

export type RoundedToken = keyof typeof rounded;

export const fontFamily = {
  sans: '"Noto Sans JP", system-ui, -apple-system, "Helvetica Neue", sans-serif',
  mono: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace',
} as const;

export const typography = {
  'headline-display': {
    fontFamily: fontFamily.sans,
    fontSize: '72px',
    fontWeight: 900,
    lineHeight: 1.1,
    letterSpacing: '-0.02em',
  },
  'headline-lg': {
    fontFamily: fontFamily.sans,
    fontSize: '48px',
    fontWeight: 700,
    lineHeight: 1.2,
    letterSpacing: '-0.01em',
  },
  'headline-md': {
    fontFamily: fontFamily.sans,
    fontSize: '36px',
    fontWeight: 700,
    lineHeight: 1.25,
  },
  'body-lg': {
    fontFamily: fontFamily.sans,
    fontSize: '18px',
    fontWeight: 400,
    lineHeight: 1.7,
    letterSpacing: '0.01em',
  },
  'body-md': {
    fontFamily: fontFamily.sans,
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: 1.6,
  },
  'body-sm': {
    fontFamily: fontFamily.sans,
    fontSize: '14px',
    fontWeight: 400,
    lineHeight: 1.5,
  },
  'label-lg': {
    fontFamily: fontFamily.sans,
    fontSize: '14px',
    fontWeight: 600,
    letterSpacing: '0.04em',
  },
  'label-md': {
    fontFamily: fontFamily.sans,
    fontSize: '12px',
    fontWeight: 500,
    letterSpacing: '0.05em',
  },
  'label-sm': {
    fontFamily: fontFamily.sans,
    fontSize: '11px',
    fontWeight: 500,
    letterSpacing: '0.06em',
  },
} as const;

export type TypographyToken = keyof typeof typography;

export const tokens = {
  colors,
  spacing,
  rounded,
  fontFamily,
  typography,
} as const;

export type DesignTokens = typeof tokens;
