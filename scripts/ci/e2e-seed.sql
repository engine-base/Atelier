-- E2E (Playwright) 用の決定論 seed。
--
-- apps/web/tests/e2e/*.e2e.ts が参照する固定 UUID を投入する。
-- 前提: scripts/ci/pg-bootstrap.sql + scripts/ci/apply-migrations.sh 適用済み。
-- 冪等 (on conflict do nothing / 事前 delete)。
--
--   user      a818edcd-8e05-4bd9-a0d1-aaf80c777adf (qahuman@example.com)
--   workspace 2d2345c1-b0a8-4ea1-a5bd-d80bac1b7b69
--   project   a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b
--   employee  11111111-0000-4000-8000-000000000001 (tony)
--   task      2834763b-dd83-4f27-9d55-b02d33cf9841 (ready)
--   mock      55555555-0000-4000-8000-000000000001
--   output    55555555-0000-4000-8000-000000000002
--   execution dc77372d-36d0-4fea-9ba4-f0da85aa0332 (succeeded)
--   invitation token 平文 'qa-inv-token' (sha256 hash 保存)

begin;

insert into auth.users (id, email) values
  ('a818edcd-8e05-4bd9-a0d1-aaf80c777adf', 'qahuman@example.com')
on conflict do nothing;

insert into public.users (id, email, display_name) values
  ('a818edcd-8e05-4bd9-a0d1-aaf80c777adf', 'qahuman@example.com', 'QA Human')
on conflict do nothing;

insert into public.workspaces (id, owner_user_id, name) values
  ('2d2345c1-b0a8-4ea1-a5bd-d80bac1b7b69',
   'a818edcd-8e05-4bd9-a0d1-aaf80c777adf', 'QA Human WS')
on conflict do nothing;

-- owner membership は t-d-90 trigger が自動作成するが冪等に明示
insert into public.workspace_memberships (workspace_id, user_id, role) values
  ('2d2345c1-b0a8-4ea1-a5bd-d80bac1b7b69',
   'a818edcd-8e05-4bd9-a0d1-aaf80c777adf', 'owner')
on conflict do nothing;

insert into public.projects (id, workspace_id, name, project_type, status) values
  ('a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b',
   '2d2345c1-b0a8-4ea1-a5bd-d80bac1b7b69',
   'サンプル案件A', 'client_work', 'active')
on conflict do nothing;

insert into public.ai_employees (id, workspace_id, name, display_name, role, department) values
  ('11111111-0000-4000-8000-000000000001',
   '2d2345c1-b0a8-4ea1-a5bd-d80bac1b7b69', 'tony', 'トニー', 'coo', 'executive'),
  ('11111111-0000-4000-8000-000000000002',
   '2d2345c1-b0a8-4ea1-a5bd-d80bac1b7b69', 'strange', 'ストレンジ', 'lead', 'architecture')
on conflict do nothing;

insert into public.tasks
  (id, project_id, category, title, type, estimated_hours, lifecycle_stage) values
  ('2834763b-dd83-4f27-9d55-b02d33cf9841',
   'a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b',
   'backend', '要件ヒアリング', 'feature', 3, 'ready'),
  ('2834763b-dd83-4f27-9d55-b02d33cf9842',
   'a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b',
   'frontend', '画面設計', 'screen', 5, 'in_progress')
on conflict do nothing;

insert into public.task_executions (id, task_id, started_at, status) values
  ('dc77372d-36d0-4fea-9ba4-f0da85aa0332',
   '2834763b-dd83-4f27-9d55-b02d33cf9841', now() - interval '1 hour', 'succeeded')
on conflict do nothing;

insert into public.phases (id, project_id, "order", name, status) values
  ('44444444-0000-4000-8000-000000000001', 'a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b', 1, 'ヒアリング', 'completed'),
  ('44444444-0000-4000-8000-000000000002', 'a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b', 2, '要件定義', 'in_progress'),
  ('44444444-0000-4000-8000-000000000003', 'a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b', 3, '設計', 'pending')
on conflict do nothing;

insert into public.approval_inbox (id, user_id, type, target_type, target_id, title) values
  ('33333333-0000-4000-8000-000000000001',
   'a818edcd-8e05-4bd9-a0d1-aaf80c777adf', 'task_approval', 'task',
   'a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b', 'タスク承認: 要件ヒアリング'),
  ('33333333-0000-4000-8000-000000000002',
   'a818edcd-8e05-4bd9-a0d1-aaf80c777adf', 'knowledge_write', 'knowledge_node',
   '22222222-0000-4000-8000-000000000001', 'ナレッジ昇格: 提案書の書き方')
on conflict do nothing;

insert into public.knowledge_nodes (id, account_id, account_type, scope, category, title, content_md) values
  ('22222222-0000-4000-8000-000000000001',
   '2d2345c1-b0a8-4ea1-a5bd-d80bac1b7b69', 'workspace', 'common',
   'general', '提案書の書き方', '# 提案書')
on conflict do nothing;

insert into public.mocks (id, project_id, screen_name, html_storage_path) values
  ('55555555-0000-4000-8000-000000000001',
   'a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b', 'S-B01 一覧', 'mocks/s-b01.html')
on conflict do nothing;

insert into public.workflow_outputs (id, project_id, stage, summary) values
  ('55555555-0000-4000-8000-000000000002',
   'a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b', 'proposal', '提案書 v1')
on conflict do nothing;

insert into public.external_uploads
  (id, project_id, uploaded_by_user_id, type, storage_path, file_name, file_size_bytes, mime_type) values
  ('66666666-0000-4000-8000-000000000001',
   'a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b',
   'a818edcd-8e05-4bd9-a0d1-aaf80c777adf',
   'audio', 'meetings/rec1.mp3', '定例0704.mp3', 102400, 'audio/mpeg')
on conflict do nothing;

insert into public.cron_schedules (id, project_id, name, cron_expression, target_action) values
  ('aaaaaaaa-0000-4000-8000-000000000001',
   'a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b',
   '日次ダイジェスト', '0 9 * * *', 'daily_digest')
on conflict do nothing;

insert into public.client_invitations (id, project_id, email, token_hash, expires_at) values
  ('99999999-0000-4000-8000-000000000001',
   'a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b',
   'client@example.com', encode(sha256('qa-inv-token'), 'hex'), now() + interval '30 days')
on conflict do nothing;

commit;
