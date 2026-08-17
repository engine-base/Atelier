-- T-D-99ZS: bridge_user_tokens + bridge_workers.user_id — GAP-122 (ワンクリック Bridge 接続)
--
-- 信頼源: docs/gap-tracker.md#GAP-122
--   「各ユーザーが自分の Bridge 接続トークンを画面から発行・失効でき、
--    Bridge アプリがそのトークンで本人のチャット中継だけを実行する」
--
-- 設計:
--   - token は raw を保存しない (sha256 hash のみ — client_invitations と同方針)
--   - user トークンの権限は v1 ではチャット中継 (chat-relay) + presence (ping) のみ。
--     タスク実行系 (kanban/*) はインスタンス トークン限定 (過剰権限の防止)
--   - chat-relay pick は user トークンのとき requested_by = 本人 の job だけを
--     確保する (他人のプロンプトが他人の PC に流れない — R-T08 系の分離)
--   - bridge_workers.user_id で presence を本人に紐付け (null = インスタンス worker)
--
-- RLS: bridge_user_tokens は本人のみ SELECT。書き込みは API の service session のみ。
-- Idempotency: create-table-if-not-exists / drop-policy-if-exists → create。

begin;

create table if not exists public.bridge_user_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  token_hash    text not null unique,
  label         text not null default 'Bridge',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create index if not exists idx_bridge_user_tokens_user
  on public.bridge_user_tokens (user_id, created_at desc);

comment on table public.bridge_user_tokens is
  'GAP-122: ユーザー別 Bridge 接続トークン (raw 非保存 — sha256 hash のみ)';

alter table public.bridge_user_tokens enable row level security;

drop policy if exists bridge_user_tokens_select_self on public.bridge_user_tokens;

-- SELECT: 本人のみ (一覧表示用。token_hash 列は API 応答に含めない)
create policy bridge_user_tokens_select_self on public.bridge_user_tokens
  for select
  to authenticated
  using (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE: policy なし = default deny (API service session のみ)。

alter table public.bridge_workers
  add column if not exists user_id uuid references public.users(id) on delete cascade;

comment on column public.bridge_workers.user_id is
  'GAP-122: user トークンで ping した worker の持ち主 (null = インスタンス worker)';

commit;
