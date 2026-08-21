-- GAP-202: 「届いた？」と聞きに行くのをやめ、届いた瞬間に知らせてもらう。
--
-- これまで: チャットが本人の PC (Bridge) の実行を待っている間、サーバーは
--   0.25 秒ごとに DB へ 3 クエリ (chunk / 状態 / 承認) を投げ続けていた。
--   待っている人数ぶん積み上がるので、**待機人数がそのままサーバー負荷**に
--   なっていた (GAP-201 の実測: 400 人待機で飽和)。
--
-- これから: 書き込んだ側が `pg_notify` で知らせる。SSE 側は寝て待つ。
--   NOTIFY は **commit 時に配送される** ので「まだ見えないのに起こされる」
--   ことがない。同一トランザクション内の同じ (channel, payload) は
--   Postgres 側で 1 通に畳まれるため、chunk を 20 行まとめて入れても 1 通。
--
-- **アプリではなく trigger に置く理由**: 書き込み経路は chunk 追記・状態更新・
--   承認・期限切れ・中断と複数あり、アプリ側に置くと「1 か所書き忘れて
--   そのチャットだけ固まる」が起きる。DB に置けば経路を増やしても漏れない。

create or replace function public.chat_relay_notify() returns trigger
language plpgsql
as $$
declare
  target uuid;
begin
  -- chat_relay_jobs は自分の id、それ以外は job_id が待っている相手。
  if tg_table_name = 'chat_relay_jobs' then
    target := coalesce(new.id, old.id);
  else
    target := coalesce(new.job_id, old.job_id);
  end if;

  if target is not null then
    perform pg_notify('chat_relay', target::text);
  end if;
  return null;  -- after trigger なので戻り値は使われない
end;
$$;

comment on function public.chat_relay_notify() is
  'GAP-202: chat relay の更新を待っている SSE を起こす (payload = job_id)。';

-- ① 本文・ツール実況・成果物の追記
drop trigger if exists chat_relay_chunks_notify on public.chat_relay_chunks;
create trigger chat_relay_chunks_notify
  after insert on public.chat_relay_chunks
  for each row execute function public.chat_relay_notify();

-- ② 実行状態の変化 (running → done / error / expired / cancelled)。
--    status が変わったときだけ起こす (無関係な更新で起こさない)。
drop trigger if exists chat_relay_jobs_notify on public.chat_relay_jobs;
create trigger chat_relay_jobs_notify
  after update on public.chat_relay_jobs
  for each row
  when (old.status is distinct from new.status)
  execute function public.chat_relay_notify();

-- ③ 承認カードの発行と、その決着
drop trigger if exists chat_relay_approvals_notify on public.chat_relay_approvals;
create trigger chat_relay_approvals_notify
  after insert or update on public.chat_relay_approvals
  for each row execute function public.chat_relay_notify();
