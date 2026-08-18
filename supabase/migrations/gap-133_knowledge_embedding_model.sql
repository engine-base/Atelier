-- GAP-133: knowledge_nodes.embedding_model — 埋め込みモデルの空間タグ
--
-- 背景: 埋め込みプロバイダを Voyage 専属から「Voyage / ローカル (fastembed)」の
-- 抽象化に拡張する。モデルが違えばベクトル空間が違うため、どのモデルで
-- 埋め込んだ行かを記録し、検索は**同一モデルの行だけ**を対象にする
-- (異モデル混在の cosine 比較は無意味なスコアを返す — 黙って混ぜない)。
--
-- 値の例: 'voyage-3-large' / 'local:intfloat/multilingual-e5-large'
-- モデル切替後の移行は apps/api/scripts/reembed_knowledge.py で全件再埋め込み。
--
-- Idempotency: add column if not exists + 冪等 backfill。

begin;

alter table public.knowledge_nodes
  add column if not exists embedding_model text;

comment on column public.knowledge_nodes.embedding_model is
  'GAP-133: embedding を生成したモデルの空間タグ。検索は同一タグの行のみ対象。';

-- backfill: 既存の埋め込み済み行は全て Voyage (T-F-14 以来の唯一のプロバイダ)
update public.knowledge_nodes
  set embedding_model = 'voyage-3-large'
  where embedding is not null and embedding_model is null;

-- 同一モデル内の近傍検索を速くする部分 index (モデル別に絞ってから距離順)
create index if not exists knowledge_nodes_embedding_model_idx
  on public.knowledge_nodes (embedding_model)
  where embedding is not null and deleted_at is null;

commit;
