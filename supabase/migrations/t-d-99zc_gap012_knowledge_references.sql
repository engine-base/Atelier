-- GAP-012: ナレッジ参照元 (バックリンク) の永続化
--
-- これまで RAG hit (chat_sse の rag_hit_ids) は SSE メタデータとして揮発しており、
-- S-K01 の「バックリンク」(何がこのナレッジを参照したか) を実データで描画できなかった。
-- 実参照経路 (チャット応答での RAG 消費) が発生するたびに referrer を upsert し、
-- GET /knowledge/{id}/references で逆引きする。referrer_type は将来の
-- task / decision (ADR) / feature 参照も同型で受けられるよう check で許容しておく
-- (書込元が実装されるまで当該 type の行は生まれない — 偽装挿入はしない)。
--
-- Idempotency: create if not exists / drop policy if exists → create。

begin;

create table if not exists public.knowledge_references (
  id uuid primary key default gen_random_uuid(),
  knowledge_id uuid not null references public.knowledge_nodes(id) on delete cascade,
  referrer_type text not null
    check (referrer_type in ('chat_thread', 'task', 'decision', 'feature')),
  referrer_id uuid not null,
  context text not null default '',
  reference_count integer not null default 1,
  last_referenced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (knowledge_id, referrer_type, referrer_id)
);

create index if not exists knowledge_references_knowledge_idx
  on public.knowledge_references (knowledge_id, last_referenced_at desc);

alter table public.knowledge_references enable row level security;

drop policy if exists knowledge_references_select on public.knowledge_references;
drop policy if exists knowledge_references_insert on public.knowledge_references;
drop policy if exists knowledge_references_update on public.knowledge_references;

-- バックリンクの可視性 = 対象ナレッジの可視性 (knowledge_nodes の RLS を
-- サブクエリ経由でそのまま継承。authenticated セッションではサブクエリにも
-- knowledge_nodes の policy が適用される)。
create policy knowledge_references_select on public.knowledge_references
  for select
  to authenticated
  using (knowledge_id in (select id from public.knowledge_nodes));

-- 書込 (chat_sse の RAG 消費時 upsert) も「自分に見えるナレッジ」に限定。
create policy knowledge_references_insert on public.knowledge_references
  for insert
  to authenticated
  with check (knowledge_id in (select id from public.knowledge_nodes));

create policy knowledge_references_update on public.knowledge_references
  for update
  to authenticated
  using (knowledge_id in (select id from public.knowledge_nodes));

commit;
