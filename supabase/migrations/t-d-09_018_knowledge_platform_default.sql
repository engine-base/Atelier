-- T-D-09 拡張: knowledge_nodes に「運営デフォルト(platform)」+「visible_in_tree」を追加
--
-- 信頼源: 04_functional_breakdown/entities.json E-018
-- 背景: 運営(プラットフォーム)が用意するデフォルトナレッジを全テナント横断で参照させたい。
--   ただしテナントのナレッジツリーには表示せず、RAG 検索でのみ参照される。
--
-- 設計:
--   - account_type に 'platform' を追加。account_id は運営 sentinel（アプリ層で固定 UUID）。
--   - visible_in_tree (default true)。運営デフォルトは false でツリー非表示・RAG では参照可。
--   - RLS: platform ナレッジは全 authenticated が SELECT 可（参照）。書込は service_role のみ
--     （既存 knowledge_service_role_all が担保）。
--
-- Idempotency: ADD VALUE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / drop+create policy。

-- 1) account_type enum に 'platform' を追加（トランザクション外・冪等）
alter type public.knowledge_account_type_enum add value if not exists 'platform';

-- 2) visible_in_tree 列 + platform 参照 RLS（トランザクション内）
begin;

alter table public.knowledge_nodes
  add column if not exists visible_in_tree boolean not null default true;

comment on column public.knowledge_nodes.visible_in_tree is
  'false=ナレッジツリー非表示だが RAG 検索では参照される（運営デフォルトナレッジ用）。';

-- platform ナレッジは全テナントが RAG 参照可（読み取り専用）
drop policy if exists knowledge_platform_read on public.knowledge_nodes;
create policy knowledge_platform_read on public.knowledge_nodes
  for select
  to authenticated
  using (account_type = 'platform');

commit;
