-- 0001_pgvector.sql (T-F-14)
--
-- Atelier RAG / 議事録検索 / task 類似性判定で利用する pgvector 拡張を
-- 有効化し、共通 helper を定義する。
--
-- 適用方法 (ローカル):
--   supabase db reset            -- migrations 全 reapply
--   supabase migration up        -- 増分のみ適用
--
-- 適用方法 (本番):
--   supabase db push             -- linked project に適用
--
-- 関連:
-- - apps/api/src/embeddings/voyage.py の DEFAULT_DIMENSIONS = 1024 と一致させる
-- - Wave 1 の T-A-XX で memos.embedding / tasks.embedding 列を VECTOR(1024) 型で追加

-- =============================================================================
-- 1. pgvector 拡張の有効化
-- =============================================================================
-- Supabase は extensions schema に pgvector を提供している。
-- public schema には置かず extensions schema 配下に保つ (Supabase ベストプラクティス)。
create extension if not exists vector with schema extensions;

-- =============================================================================
-- 2. embedding 用の domain と helper
-- =============================================================================
-- Voyage AI voyage-3-large は 1024 次元を返す。型を固定して invariant 化する。
-- (将来 voyage-3-lite (512-dim) を併用する場合は別カラム or 別テーブルで管理)
do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'voyage_embedding'
  ) then
    create domain public.voyage_embedding as extensions.vector(1024);
  end if;
end $$;

comment on domain public.voyage_embedding is
  'Voyage AI voyage-3-large の 1024-dim embedding 用 domain。T-F-14 で導入。';

-- =============================================================================
-- 3. cosine 類似度検索の helper (将来の RAG 用)
-- =============================================================================
-- IVFFlat / HNSW インデックスは Wave 1 で実テーブル (memos / tasks) に対して
-- 個別に作成する。本 migration では拡張と domain のみ用意する。
--
-- 例 (Wave 1 で行う):
--   create index memos_embedding_idx on memos
--     using hnsw (embedding extensions.vector_cosine_ops);
