-- GAP-014: プラットフォーム必須ジョブ (法令・運用バックエンド)
--
-- データ整合性チェック (integrity-check cron) が矛盾検知時に「承認待ちに通知」
-- するための approval_inbox type を追加する。挿入は service (cron) のみ —
-- 既存の approval_inbox RLS (本人可視) をそのまま使う。
--
-- NOTE: ALTER TYPE ... ADD VALUE は transaction block 外で実行する必要が
-- あるため begin/commit で包まない。IF NOT EXISTS で冪等。

alter type public.approval_inbox_type_enum add value if not exists 'integrity_alert';

-- integrity_alert は project 単位で通知するため target_type に 'project' を許可
alter table public.approval_inbox
  drop constraint if exists approval_inbox_target_type_valid;
alter table public.approval_inbox
  add constraint approval_inbox_target_type_valid
  check (target_type in ('task', 'phase', 'knowledge_node', 'comment', 'scope_change', 'project'));
