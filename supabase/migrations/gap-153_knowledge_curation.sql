-- GAP-153: ナレッジ自動キュレーション (経営者すり合わせ 2026-08-18)
--
--   「ユーザー提案のフローはしない。ナレッジは管理側かもしくは運営として
--    裏で AI を走らせて自動で分ける感じ。その中でセキュリティも担保する」
--
-- 設計:
--   - 運営側のバッチ (運営の API キー費用) が全テナントの良いナレッジを走査し、
--     LLM で「全社的に有用か」を判定 + 固有情報を除去 (匿名化) した提案を作る。
--   - 提案は knowledge_curations に貯まり、運営 admin の承認で初めて
--     platform ナレッジ (全アカウント共有) になる — 自動公開はしない。
--   - セキュリティ担保は二重: ① LLM の匿名化 ② 決定的リークスキャン
--     (元テナントの社名/プロジェクト名/氏名/メール等が残っていたら機械的に
--     rejected_security へ落とす — LLM を信用しない)。
--   - RLS は default deny (ポリシー無し) — 読めるのは service 経路 (運営 admin
--     ルータ) のみ。テナントには誰の提案かはもちろん存在自体を見せない。

create table if not exists public.knowledge_curations (
  id                  uuid primary key default gen_random_uuid(),
  source_node_id      uuid not null references public.knowledge_nodes(id) on delete cascade,
  source_account_type text not null,
  source_account_id   uuid not null,
  proposed_title      text not null,
  proposed_content_md text not null default '',
  proposed_category   text not null default '',
  proposed_tags       text[] not null default '{}',
  reason              text not null default '',
  security_notes      text,
  status              text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'rejected_security', 'skipped')),
  model               text,
  published_node_id   uuid references public.knowledge_nodes(id) on delete set null,
  reviewed_by         uuid references public.users(id) on delete set null,
  reviewed_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (source_node_id)
);

comment on table public.knowledge_curations is
  'GAP-153: 運営 AI による全テナント横断ナレッジの匿名化キュレーション提案。承認で platform ナレッジ化。';

create index if not exists knowledge_curations_status_idx
  on public.knowledge_curations (status, created_at desc);

-- default deny: RLS 有効 + ポリシー無し = authenticated からは一切不可視
alter table public.knowledge_curations enable row level security;
