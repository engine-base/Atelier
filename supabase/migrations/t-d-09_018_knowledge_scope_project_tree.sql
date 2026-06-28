-- T-D-09 拡張: knowledge_nodes に「プロジェクト単位 scope」+「構造ツリー(parent_id)」を追加
--
-- 信頼源: 04_functional_breakdown/entities.json E-018
-- 背景: ナレッジを 共通(common) / AI社員別(employee_specific) / プロジェクト単位(project)
--   の3層 + フォルダ的な構造ツリーで扱えるようにする。
--
-- 設計:
--   - scope enum に 'project' を追加。scope=project の行は source_project_id を束縛先とする。
--   - parent_id (自己FK, on delete set null) で階層ツリーを構成。null=ルート。
--   - 可視性は既存 account_scoped RLS が踏襲（scope=project も workspace アカウント配下）。
--
-- Idempotency: ADD VALUE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS で re-run 安全。
-- NOTE: ALTER TYPE ... ADD VALUE は トランザクション外で実行する必要があるため、
--   enum 追加とテーブル変更を分離している。

-- 1) scope enum に 'project' を追加（トランザクション外・冪等）
alter type public.knowledge_scope_enum add value if not exists 'project';

-- 2) 構造ツリー用 parent_id + project scope index（トランザクション内）
begin;

alter table public.knowledge_nodes
  add column if not exists parent_id uuid
  references public.knowledge_nodes(id) on delete set null;

comment on column public.knowledge_nodes.parent_id is
  '構造ツリーの親ノード。null=ルート。同一 account 内でフォルダ的階層を構成。';

create index if not exists idx_knowledge_parent
  on public.knowledge_nodes (parent_id)
  where parent_id is not null;

create index if not exists idx_knowledge_project_scope
  on public.knowledge_nodes (source_project_id)
  where scope = 'project';

commit;
