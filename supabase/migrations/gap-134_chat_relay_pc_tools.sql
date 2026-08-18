-- GAP-134: Bridge 経路の PC 操作 (全ユーザーが自分の PC + 自分の Claude プランで実行)
--
-- すり合わせ確定 (2026-08-18 経営者): 標準構成は「各ユーザーの PC で動く
-- Bridge が本人のサブスクで LLM を実行し、PC 操作も本人の PC で行う」。
-- agent_sdk (サーバー内実行) は特殊形であり、relay (Bridge) が本流。
--
-- 追加:
--   1. chat_relay_jobs.tools_mode — off/approve/auto (GAP-129/130 と同一概念)
--   2. chat_relay_chunks.kind — delta (本文) / tool (ツール実況)
--   3. chat_relay_approvals — 承認カードの永続キュー。SSE (サーバー) と
--      Bridge (ユーザー PC) はプロセスが別なので、agent_sdk のような
--      プロセス内レジストリでは決定を届けられない → DB 経由で往復する。
--      フロー: Bridge が CLI の許可要求を受けて行を作る → SSE が pending を
--      検知して承認カードを配信 → ユーザーの決定 (POST /chat/pc-approvals/{id})
--      が行を更新 → Bridge がポーリングで決定を読み CLI に返す。
--
-- Idempotency: if not exists / drop-policy-if-exists で re-run 安全。

begin;

alter table public.chat_relay_jobs
  add column if not exists tools_mode text not null default 'off';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_relay_jobs_tools_mode_valid'
  ) then
    alter table public.chat_relay_jobs
      add constraint chat_relay_jobs_tools_mode_valid
      check (tools_mode in ('off', 'approve', 'auto'));
  end if;
end $$;

alter table public.chat_relay_chunks
  add column if not exists kind text not null default 'delta';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_relay_chunks_kind_valid'
  ) then
    alter table public.chat_relay_chunks
      add constraint chat_relay_chunks_kind_valid
      check (kind in ('delta', 'tool'));
  end if;
end $$;

create table if not exists public.chat_relay_approvals (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.chat_relay_jobs(id) on delete cascade,
  tool        text not null,
  summary     text not null,
  decision    text not null default 'pending',
  created_at  timestamptz not null default clock_timestamp(),
  decided_at  timestamptz,
  constraint chat_relay_approvals_decision_valid
    check (decision in ('pending', 'allow', 'deny', 'timeout'))
);

create index if not exists idx_chat_relay_approvals_job
  on public.chat_relay_approvals (job_id, created_at);

alter table public.chat_relay_approvals enable row level security;

drop policy if exists chat_relay_approvals_select_self on public.chat_relay_approvals;

-- SELECT: 親 job のリクエスト本人のみ (承認カードは本人の実行の話)。
-- INSERT (Bridge) / UPDATE (決定) は service 経路のみ — policy を作らない
-- (default deny)。決定 API はサーバー側で requested_by = 本人 を検証する。
create policy chat_relay_approvals_select_self on public.chat_relay_approvals
  for select
  to authenticated
  using (
    exists (
      select 1 from public.chat_relay_jobs j
      where j.id = chat_relay_approvals.job_id
        and j.requested_by = auth.uid()
    )
  );

commit;
