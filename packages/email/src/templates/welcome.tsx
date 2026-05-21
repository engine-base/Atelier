import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import type { ReactElement } from 'react';

import { colors, spacing } from '@atelier/design-tokens';

export interface WelcomeEmailProps {
  readonly recipientName: string;
  readonly workspaceName: string;
  readonly signInUrl: string;
}

export default function WelcomeEmail({
  recipientName,
  workspaceName,
  signInUrl,
}: WelcomeEmailProps): ReactElement {
  return (
    <Html lang="ja">
      <Head />
      <Preview>Atelier へようこそ — {workspaceName} の準備が整いました</Preview>
      <Body
        style={{
          backgroundColor: colors.surface,
          color: colors.onSurface,
          fontFamily: '"Noto Sans JP", system-ui, sans-serif',
          margin: 0,
          padding: spacing.lg,
        }}
      >
        <Container
          style={{
            maxWidth: 560,
            margin: '0 auto',
            padding: spacing.xl,
            backgroundColor: colors.surface,
          }}
        >
          <Heading
            as="h1"
            style={{
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              color: colors.onSurface,
              margin: `0 0 ${spacing.lg} 0`,
            }}
          >
            ようこそ、{recipientName} さん
          </Heading>

          <Section>
            <Text
              style={{
                fontSize: 16,
                lineHeight: 1.7,
                color: colors.onSurface,
              }}
            >
              ワークスペース「{workspaceName}」の準備が整いました。
              下記のリンクからサインインしてください。
            </Text>
            <Text style={{ marginTop: spacing.lg }}>
              <a
                href={signInUrl}
                style={{
                  display: 'inline-block',
                  backgroundColor: colors.primary,
                  color: colors.onPrimary,
                  padding: '12px 24px',
                  borderRadius: 8,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                サインイン
              </a>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
