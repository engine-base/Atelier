import type { ReactNode } from 'react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * tool-ui の ToolCard 表示の薄い wrapper。
 * Web Search / File Read / Code Diff / Knowledge Citation / Task Progress /
 * Approval / Mock Preview / AC Checklist など 8 種のカード表示を統一する。
 */
export type ToolStatus = 'pending' | 'running' | 'success' | 'error';

export interface ToolCardProps {
  readonly name: string;
  readonly status: ToolStatus;
  readonly description?: string;
  readonly children?: ReactNode;
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  pending: '待機中',
  running: '実行中',
  success: '完了',
  error: 'エラー',
};

export function ToolCard({ name, status, description, children }: ToolCardProps) {
  return (
    <Card data-status={status} aria-label={`tool ${name} (${STATUS_LABEL[status]})`}>
      <CardHeader>
        <CardTitle>{name}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      {children ? <CardContent>{children}</CardContent> : null}
    </Card>
  );
}

export { STATUS_LABEL as TOOL_STATUS_LABEL };
