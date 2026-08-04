-- GAP-004: 工程 (phases) への担当 AI 社員割当
--
-- tasks.dependencies (uuid[]) と同型の配列列方式。join テーブルより読み書きが
-- 単純で、RLS は phases 既存ポリシー (project 経由 workspace membership) を
-- そのまま継承する。要素は ai_employees.id (同一 workspace) を指す。
--
-- Idempotency: add column if not exists。

alter table public.phases
  add column if not exists assigned_employee_ids uuid[] not null default '{}';

comment on column public.phases.assigned_employee_ids is
  '担当 AI 社員 (GAP-004)。S-F01 ヘッダーアバター / S-F02 割当 UI のデータ源';
