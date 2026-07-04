-- T-D-97: knowledge_nodes_scope_owner_consistency に scope='project' を許容 (T-A-47 の欠落補完)
--
-- 背景: t-d-09_018_knowledge_scope_project_tree.sql で knowledge_scope_enum に 'project' を
--   追加したが、CHECK 制約 knowledge_nodes_scope_owner_consistency (t-d-09_018.sql) が
--   employee_specific / common の 2 値しか許容しておらず、scope='project' の INSERT が
--   全て制約違反になることが実DB検証で発覚 (test_knowledge_scope_tree ×7,
--   apps/web/.qa/RESULTS-2026-07-04-realdb.md)。
-- 仕様 (T-A-47): scope=project は project ツリー用で owner_employee_id を持たない
--   (employee_specific のみ owner 必須)。
--
-- Idempotency: drop constraint if exists → add。

begin;

alter table public.knowledge_nodes
  drop constraint if exists knowledge_nodes_scope_owner_consistency;

alter table public.knowledge_nodes
  add constraint knowledge_nodes_scope_owner_consistency
  check (
    (scope = 'employee_specific'::knowledge_scope_enum and owner_employee_id is not null)
    or (scope = 'common'::knowledge_scope_enum and owner_employee_id is null)
    or (scope = 'project'::knowledge_scope_enum and owner_employee_id is null)
  );

commit;
