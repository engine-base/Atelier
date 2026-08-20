-- GAP-186: 議事録から抽出した項目を「確認して採用」→ 要件・タスク・決定に反映する。
--
-- 経営者指示「1,2 だね」の ①:
--   議事録の解析結果 (GAP-184 で 9 セクションに厚くした) を、人が確認して
--   採用したものだけプロジェクトの実データへ落とす。
--
-- **自動反映はしない** (GAP-156 と同じ方針)。AI の抽出をそのまま正にすると、
-- 聞き間違い・言い過ぎがプロジェクトの要件として固定されてしまう。
--
-- この表は「何を採用したか」の台帳。役割は 2 つ:
--   1. 二重採用の防止 (同じ項目を 2 回押しても増えない)
--   2. 追跡 — この要件・タスクがどの議事録の何行目から来たか辿れる
create table if not exists public.meeting_adoptions (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.external_uploads(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  -- 議事録側の種別: requirement / action / decision / open_question
  kind        text not null,
  -- 議事録側の項目を一意に指す安定キー (種別 + 正規化した見出し)
  item_key    text not null,
  -- 反映先: task / decision
  target_type text not null,
  target_id   uuid not null,
  adopted_by  uuid references public.users(id) on delete set null,
  adopted_at  timestamptz not null default now(),
  constraint meeting_adoptions_kind_valid
    check (kind in ('requirement', 'action', 'decision', 'open_question')),
  constraint meeting_adoptions_target_valid
    check (target_type in ('task', 'decision')),
  constraint meeting_adoptions_item_key_len
    check (char_length(item_key) >= 1 and char_length(item_key) <= 400)
);

comment on table public.meeting_adoptions is
  'GAP-186: 議事録の抽出項目のうち人が採用したものの台帳。'
  ' 二重採用の防止と「この要件はどの議事録から来たか」の追跡を担う。';

-- 同じ議事録の同じ項目は 1 度だけ採用できる (二重押しで増えない)。
create unique index if not exists meeting_adoptions_item_uq
  on public.meeting_adoptions (meeting_id, kind, item_key);

create index if not exists meeting_adoptions_project_idx
  on public.meeting_adoptions (project_id, adopted_at desc);

create index if not exists meeting_adoptions_target_idx
  on public.meeting_adoptions (target_type, target_id);

alter table public.meeting_adoptions enable row level security;

-- 可視性はプロジェクト所属で決まる (議事録・タスク・決定と同じ境界)。
drop policy if exists meeting_adoptions_select_member on public.meeting_adoptions;
create policy meeting_adoptions_select_member on public.meeting_adoptions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = meeting_adoptions.project_id
        and m.user_id = auth.uid()
    )
  );
