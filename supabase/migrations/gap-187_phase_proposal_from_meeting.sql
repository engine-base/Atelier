-- GAP-187: 議事録からフェーズを提案する（経営者指示「1,2 だね」の ②）。
--
-- これまでの提案 (GAP-150) は「既存フェーズとタスクの状況」だけを見ていた。
-- 打合せで決まったこと・出た要件・未決事項こそが「次に何を確定すべきか」の
-- 一番の材料なのに、それが提案の根拠に入っていなかった。
--
-- 提案がどの打合せ由来かを残す。理由:
--   1. 画面で「この提案は 8/20 の打合せから」と出せる（根拠を隠さない）
--   2. 同じ打合せから何度も提案を作っていないかを人が確かめられる
alter table public.phase_proposals
  add column if not exists source_meeting_id uuid
  references public.external_uploads(id) on delete set null;

comment on column public.phase_proposals.source_meeting_id is
  'GAP-187: この提案の根拠になった議事録 (null = 既存フェーズ状況からの提案)。';

create index if not exists phase_proposals_source_meeting_idx
  on public.phase_proposals (source_meeting_id)
  where source_meeting_id is not null;
