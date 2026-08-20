-- GAP-189: 実行の制御 — 中断・実行中の追い足し指示・繋ぎ直し
--
-- 経営者指摘:
--   「中断とか入ってないけど、これ Claude だとできるけど」
--   「止まっても裏のターミナルは変わらないんでしょ？ だったら続けてとかで
--     自動で後ろは繋がるよね？」
--
-- 直す前の実態:
--   1. 中断できない — 停止ボタンが無く、走り出したら終わるまで待つしかない
--   2. 実行中に何も送れない — 入力欄が disabled。割り込みも追い足しもできない
--   3. 繋ぎ直せない — assistant の返答は SSE の generator を抜けた後に保存する
--      作りだったので、生成中にブラウザを閉じると **PC は最後まで仕事をして
--      chunk も DB に残っているのに、その回の答えがスレッドから消える**
--
-- ここでは 3 つに必要な DB を用意する。

-- ── 1. 中断 ────────────────────────────────────────────────────────
-- 'cancelled' は終端状態。人が止めた、が確定した印。
alter table public.chat_relay_jobs
  drop constraint if exists chat_relay_jobs_status_valid;
alter table public.chat_relay_jobs
  add constraint chat_relay_jobs_status_valid
  check (status in ('queued', 'running', 'done', 'error', 'expired', 'cancelled'));

-- いつ止めろと言われたか。Bridge はこれを見て PC 上の claude を実際に kill する
-- (クラウド側の status を落とすだけだと、本人の PC では走り続けてしまう)。
alter table public.chat_relay_jobs
  add column if not exists cancel_requested_at timestamptz;

comment on column public.chat_relay_jobs.cancel_requested_at is
  'GAP-189: 中断要求の時刻。Bridge がポーリングして PC 上の子プロセスを kill する。';

-- ── 3. 繋ぎ直し ────────────────────────────────────────────────────
-- 返答をどの chat_messages 行として保存したか。**ブラウザではなくサーバーが**
-- ジョブ確定時に保存し、この列に控える。二重保存の防止 (冪等) を兼ねる。
alter table public.chat_relay_jobs
  add column if not exists assistant_message_id uuid
  references public.chat_messages(id) on delete set null;

comment on column public.chat_relay_jobs.assistant_message_id is
  'GAP-189: このジョブの返答を保存した chat_messages.id。'
  ' 画面が閉じても答えが消えないよう、保存はサーバー側のジョブ確定に紐づける。';

-- スレッドの「今走っているもの」を引くための部分インデックス。
create index if not exists idx_chat_relay_jobs_active
  on public.chat_relay_jobs (thread_id, created_at desc)
  where status in ('queued', 'running');

-- ── 2. 実行中の追い足し指示 ────────────────────────────────────────
-- 実行中に送られた指示を**受け取った瞬間に永続化**する。ブラウザが落ちても
-- 消えない。今の実行が終わったら順に消費する (取りこぼさない)。
create table if not exists public.chat_queued_messages (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid not null references public.chat_threads(id) on delete cascade,
  requested_by uuid not null references public.users(id) on delete cascade,
  content      text not null,
  attachments  jsonb not null default '[]'::jsonb,
  tools_mode   text not null default 'off',
  created_at   timestamptz not null default now(),
  consumed_at  timestamptz,
  constraint chat_queued_messages_content_len
    check (char_length(content) >= 1 and char_length(content) <= 20000),
  constraint chat_queued_messages_tools_mode_valid
    check (tools_mode in ('off', 'approve', 'auto'))
);

comment on table public.chat_queued_messages is
  'GAP-189: 実行中に送られた追い足し指示。受領時点で保存し、実行終了後に順に消費する。';

create index if not exists idx_chat_queued_messages_pending
  on public.chat_queued_messages (thread_id, created_at)
  where consumed_at is null;

alter table public.chat_queued_messages enable row level security;

-- 本人の待ち行列だけが見え、本人だけが積める・取り消せる (R-T08 系の分離)。
drop policy if exists chat_queued_messages_select_self on public.chat_queued_messages;
create policy chat_queued_messages_select_self on public.chat_queued_messages
  for select
  to authenticated
  using (auth.uid() = requested_by);

drop policy if exists chat_queued_messages_insert_self on public.chat_queued_messages;
create policy chat_queued_messages_insert_self on public.chat_queued_messages
  for insert
  to authenticated
  with check (auth.uid() = requested_by);

drop policy if exists chat_queued_messages_delete_self on public.chat_queued_messages;
create policy chat_queued_messages_delete_self on public.chat_queued_messages
  for delete
  to authenticated
  using (auth.uid() = requested_by);
