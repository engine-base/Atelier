-- GAP-158: 出力デザインテンプレート (経営者フィードバック 2026-08-19)
--
--   「テンプレはフォーマット (構成) ではなく出力のデザイン。内容 (md/json) は
--    スキルで整える。最後に人間 (クライアント) に見せる HTML や PDF のデザインの
--    テンプレ。Open Design の機能で作る状態で十分。専用タブでしっかり見れる形」
--
-- GAP-154 の output_templates (content_md = 構成テンプレ) は認識違いだったため
-- 廃止し、HTML 実物のデザインテンプレ (版連鎖・mockdb 保存) に置き換える。
-- 未リリース (直前 commit で導入) のため drop で整理する — データ移行対象なし。

drop table if exists public.output_templates;

create table if not exists public.output_design_templates (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  stage             public.workflow_stage_enum not null,
  version           integer not null check (version >= 1),
  html_storage_path text not null,
  -- 版の変更概要 (ワンダの応答 or 指示の要約) — 履歴の可読性
  note              text not null default '',
  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (workspace_id, stage, version)
);

comment on table public.output_design_templates is
  'GAP-158: workspace 単位の出力デザインテンプレ (クライアント提出 HTML/PDF の見た目の型)。版連鎖・mockdb 保存。内容の構成はスキルが担い、これは視覚デザインのみ。';

create index if not exists output_design_templates_ws_stage_idx
  on public.output_design_templates (workspace_id, stage, version desc);

alter table public.output_design_templates enable row level security;

drop policy if exists design_templates_select_member on public.output_design_templates;
create policy design_templates_select_member on public.output_design_templates
  for select to authenticated
  using (workspace_id in (select public.current_user_workspaces()));

drop policy if exists design_templates_insert_member on public.output_design_templates;
create policy design_templates_insert_member on public.output_design_templates
  for insert to authenticated
  with check (workspace_id in (select public.current_user_workspaces()));

-- 版は履歴 — update/delete ポリシーは出さない (積むだけ。訂正は新版で)
