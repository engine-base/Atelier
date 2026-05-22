import { z } from 'zod';

/**
 * Atelier 共通 Zod schema。
 *
 * BE (apps/api Pydantic) と FE (apps/web React Hook Form) が両方参照するため
 * packages/shared に配置する。後段 (T-F-25) で OpenAPI ↔ Zod 整合 CI チェックを追加予定。
 */

export const ProjectStatus = z.enum([
  '準備中',
  '着手可',
  '実装中',
  '要対応',
  '承認待ち',
  '完了',
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const TaskGroup = z.enum(['F', 'D', 'A', 'U-shared', 'U-screen', 'I']);
export type TaskGroup = z.infer<typeof TaskGroup>;

export const TaskIdSchema = z
  .string()
  .regex(/^T-[A-Z]+-\d+$/i, 'task id must match T-X-Y pattern');
export type TaskId = z.infer<typeof TaskIdSchema>;

export const AssignedEmployee = z.enum([
  'tony',
  'strange',
  'thor',
  'wanda',
  'vision',
  'tchalla',
  'steve',
  'natasha',
  'peter',
  'jarvis',
]);
export type AssignedEmployee = z.infer<typeof AssignedEmployee>;
