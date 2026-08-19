-- GAP-154: 出力テンプレート (経営者すり合わせ 2026-08-18)
--
--   「見積もりとか出力のテンプレは自作できる形にして基本的にそれを使う。
--    ワークスペース単位でつけるべきかな」→ 決定: workspace のみ。
--
-- 設計:
--   - workspace × 種類 (workflow_stage_enum = 成果物の stage 体系) で 1 件。
--   - AI の成果物生成 (チャット/スティーブ改訂) の system prompt に必ず注入 —
--     「基本的にそれを使う」を構造で保証する (任意参照ではない)。
--   - テンプレは設定 (config) であり履歴ではないため member が削除も可能。

create table if not exists public.output_templates (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  stage        public.workflow_stage_enum not null,
  title        text not null default '' check (char_length(title) <= 120),
  content_md   text not null check (char_length(content_md) between 1 and 20000),
  updated_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, stage)
);

comment on table public.output_templates is
  'GAP-154: workspace 単位の出力テンプレート (見積/提案/請求/テスト仕様 等)。生成時に必ず注入。';

alter table public.output_templates enable row level security;

drop policy if exists output_templates_select_member on public.output_templates;
create policy output_templates_select_member on public.output_templates
  for select to authenticated
  using (workspace_id in (select public.current_user_workspaces()));

drop policy if exists output_templates_insert_member on public.output_templates;
create policy output_templates_insert_member on public.output_templates
  for insert to authenticated
  with check (workspace_id in (select public.current_user_workspaces()));

drop policy if exists output_templates_update_member on public.output_templates;
create policy output_templates_update_member on public.output_templates
  for update to authenticated
  using (workspace_id in (select public.current_user_workspaces()))
  with check (workspace_id in (select public.current_user_workspaces()));

drop policy if exists output_templates_delete_member on public.output_templates;
create policy output_templates_delete_member on public.output_templates
  for delete to authenticated
  using (workspace_id in (select public.current_user_workspaces()));
