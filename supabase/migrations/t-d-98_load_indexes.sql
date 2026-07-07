-- T-D-98: 負荷・スケール第9軸の実測 (10万 tasks / 2万 knowledge) で特定した index 補完
--
-- 実測 (apps/web/.qa/RESULTS-2026-07-04-realdb.md v10):
--   - GET /tasks?project_id の order by updated_at limit が Parallel Seq Scan
--     (10万行で 33ms — 100万行ではリニア劣化する)
--   - GET /search の ILIKE '%q%' が Seq Scan (98,891 rows filtered / 57ms)
-- 対処: 一覧用の複合 partial index + pg_trgm GIN (ILIKE を index scan 化)。
-- RLS ポリシーへの変更は無し (純 index / R-T08 非該当)。冪等。

begin;

create extension if not exists pg_trgm with schema extensions;

-- tasks 一覧 (project 内 updated_at desc ページング)
create index if not exists idx_tasks_project_updated
  on public.tasks (project_id, updated_at desc)
  where deleted_at is null;

-- 横断検索 (T-UC-40 /search) の ILIKE 対象列
create index if not exists idx_tasks_title_trgm
  on public.tasks using gin (title extensions.gin_trgm_ops);
create index if not exists idx_tasks_description_trgm
  on public.tasks using gin (description extensions.gin_trgm_ops);
create index if not exists idx_projects_name_trgm
  on public.projects using gin (name extensions.gin_trgm_ops);
create index if not exists idx_knowledge_title_trgm
  on public.knowledge_nodes using gin (title extensions.gin_trgm_ops);
create index if not exists idx_knowledge_content_trgm
  on public.knowledge_nodes using gin (content_md extensions.gin_trgm_ops);
create index if not exists idx_ai_employees_display_name_trgm
  on public.ai_employees using gin (display_name extensions.gin_trgm_ops);

commit;
