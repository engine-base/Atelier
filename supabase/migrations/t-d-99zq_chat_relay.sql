-- T-D-99ZQ: chat_relay_jobs / chat_relay_chunks — GAP-114 (チャットのローカル実行リレー)
--
-- 信頼源: docs/gap-tracker.md#GAP-114
--   「S-E01 チャットの LLM 実行を、各ユーザーの PC で稼働する Bridge に中継し、
--    その PC の Claude ログイン (= 本人の月額プラン) で実行できるようにする」
-- 流れ:
--   1. chat_sse (ATELIER_LLM_PROVIDER=relay) が jobs に queued を enqueue
--   2. ユーザー PC の Bridge が POST /chat-relay/pick で claim (queued→running)
--   3. Bridge がローカル `claude -p` の text delta を chunks へ逐次 POST
--   4. complete/fail で jobs.status を確定、SSE 側は chunks を poll して中継
--
-- RLS: 本人 (requested_by) のみ SELECT 可。INSERT/UPDATE/DELETE の policy は
--   置かない (default deny) — 書き込みは API サーバーの service session と
--   Bridge 経由 (BridgeAuth + service session) のみ。
--
-- Idempotency: create-table-if-not-exists / drop-policy-if-exists → create。

begin;

create table if not exists public.chat_relay_jobs (
  id             uuid primary key default gen_random_uuid(),
  thread_id      uuid not null references public.chat_threads(id) on delete cascade,
  requested_by   uuid not null references public.users(id) on delete cascade,
  status         text not null default 'queued',
  system_prompt  text not null,
  prompt         text not null,
  result_error   text,
  worker_id      text,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  constraint chat_relay_jobs_status_valid
    check (status in ('queued', 'running', 'done', 'error', 'expired'))
);

create index if not exists idx_chat_relay_jobs_pick
  on public.chat_relay_jobs (status, created_at);
create index if not exists idx_chat_relay_jobs_thread
  on public.chat_relay_jobs (thread_id);

create table if not exists public.chat_relay_chunks (
  job_id     uuid not null references public.chat_relay_jobs(id) on delete cascade,
  seq        integer not null,
  content    text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (job_id, seq)
);

alter table public.chat_relay_jobs enable row level security;
alter table public.chat_relay_chunks enable row level security;

drop policy if exists chat_relay_jobs_select_self on public.chat_relay_jobs;

-- SELECT: リクエスト本人のみ (自分のチャット実行の状態確認用)
create policy chat_relay_jobs_select_self on public.chat_relay_jobs
  for select
  to authenticated
  using (auth.uid() = requested_by);

drop policy if exists chat_relay_chunks_select_self on public.chat_relay_chunks;

-- SELECT: 親 job のリクエスト本人のみ
create policy chat_relay_chunks_select_self on public.chat_relay_chunks
  for select
  to authenticated
  using (
    exists (
      select 1 from public.chat_relay_jobs j
      where j.id = chat_relay_chunks.job_id
        and j.requested_by = auth.uid()
    )
  );

-- INSERT/UPDATE/DELETE: policy なし = default deny。
-- enqueue は API の service session、claim/chunks/complete は BridgeAuth 経由の
-- service session のみが実行する。

commit;
