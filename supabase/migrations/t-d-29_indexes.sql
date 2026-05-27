-- T-D-29: DB index 設計（パフォーマンス）— 未カバー FK 列の補完
--
-- 信頼源: 04_functional_breakdown/entities.json + 既存 migration (T-D-01〜13)
-- 依存: T-D-01 / T-D-02 / T-D-05（対象テーブル作成済）
--
-- 設計方針:
--   テーブル作成 migration (T-D-01〜13) で workspace_scoped / soft_delete /
--   embedding 等のホットパス index は配置済。本 migration では「親テーブル削除
--   および JOIN 性能を劣化させる未 index の外部キー列」のみを補完する。
--   (PostgreSQL は FK 列に自動 index を張らないため、親行の DELETE / UPDATE 時に
--    子テーブル全走査が発生する。これを防ぐのが目的。)
--
--   対象は以下 6 列（いずれも NULL 許容のため partial index で軽量化）:
--     - comments.author_invitation_id        (client_invitations 削除時の走査回避)
--     - knowledge_nodes.approved_by_user_id   (承認者ユーザ削除時)
--     - knowledge_nodes.source_project_id     (出自 project 削除時 / 出自逆引き)
--     - tasks.acceptance_criteria_id          (AC 行から task 逆引き)
--     - tasks.mock_id                         (mock 行から task 逆引き)
--     - tasks.phase_id                        (phase 削除時 / phase 内 task 列挙)
--
-- Idempotency: CREATE INDEX IF NOT EXISTS で re-run 安全。
-- RLS: index は行可視性に影響しない（既存 RLS policy をそのまま維持）。

begin;

create index if not exists comments_author_invitation_idx
  on public.comments (author_invitation_id)
  where author_invitation_id is not null;

create index if not exists knowledge_nodes_approved_by_idx
  on public.knowledge_nodes (approved_by_user_id)
  where approved_by_user_id is not null;

create index if not exists knowledge_nodes_source_project_idx
  on public.knowledge_nodes (source_project_id)
  where source_project_id is not null;

create index if not exists tasks_acceptance_criteria_idx
  on public.tasks (acceptance_criteria_id)
  where acceptance_criteria_id is not null;

create index if not exists tasks_mock_idx
  on public.tasks (mock_id)
  where mock_id is not null;

create index if not exists tasks_phase_idx
  on public.tasks (phase_id)
  where phase_id is not null;

commit;
