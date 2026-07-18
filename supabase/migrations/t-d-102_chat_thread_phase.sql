-- T-D-102: chat_threads.phase_id (S-E01 スレッド一覧の工程グルーピング)
--
-- 信頼源: 06_mockups/chat/S-E01-thread.html
--   スレッド一覧は「機能分解工程（現在）/ デザイン工程（完了）/ 工程横断」のように
--   工程ごとにグルーピングされるが、chat_threads に工程の紐付けが無く
--   フロントが配線できなかった (design-audit ラウンド S-E01 で判明した gap)。
-- 設計:
--   - nullable FK。null = 工程横断スレッド (ジャービスのサマリー等)
--   - phase 削除時は set null (スレッドは工程横断へ降格、履歴保持)
--   - S-F01 議論中タブの工程別フィルタにも使う

begin;

alter table public.chat_threads
  add column if not exists phase_id uuid references public.phases(id) on delete set null;

comment on column public.chat_threads.phase_id is
  'スレッドが属する工程。null = 工程横断 (S-E01 グルーピング / S-F01 議論中タブ)';

create index if not exists chat_threads_phase_idx
  on public.chat_threads (phase_id, updated_at desc)
  where deleted_at is null;

commit;
