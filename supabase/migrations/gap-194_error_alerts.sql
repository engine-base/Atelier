-- GAP-194: エラーが起きたときに「通知する」(GAP-182 の記録の続き)。
--
-- これまでの実態:
--   GAP-182 で public.error_log に記録はされるようになったが、**誰にも届かない**。
--   運営が S-T05 を開きに行かない限り、本番が壊れていても気づけない。
--   docs/gap-backlog.md にも「今は『見に行けば分かる』段階」と書いてあった。
--
-- 設計の要点:
--   ① 同じ不具合で何百通も送らない — fingerprint 単位に「最後に送った時刻」を持ち、
--      冷却時間 (既定 60 分) の間は送らない。件数だけ数えて次回にまとめる。
--   ② 送った事実を DB に残す — 「送ったつもり」を作らない。配送失敗も残す。
--   ③ 通知の失敗で通知ループを起こさない — 配送処理自体のエラーは
--      kind='AlertDeliveryFailed' として記録し、通知対象から除外する。
--   ④ テナントからは見えない (error_log と同じく policy を与えない)。

create table if not exists public.error_alerts (
  fingerprint       text primary key,
  first_seen_at     timestamptz not null default now(),
  last_notified_at  timestamptz,
  notified_count    integer not null default 0,
  --  これまでの通知に含めたエラーの累計件数 (「何件分を伝えたか」)。
  reported_errors   integer not null default 0,
  last_status       text not null default 'pending'
                      check (last_status in ('pending', 'sent', 'failed', 'skipped')),
  last_detail       text
);

comment on table public.error_alerts is
  'GAP-194: エラー通知の送信状態 (fingerprint 単位)。同じ不具合を何百通も送らないための冷却記録。';
comment on column public.error_alerts.reported_errors is
  'これまでの通知に含めたエラーの累計件数。次回は last_notified_at 以降の増分だけを伝える。';
comment on column public.error_alerts.last_status is
  'sent=配送成功 / failed=配送失敗 (次回再試行) / skipped=送信先未設定 / pending=未送信。';

create index if not exists error_alerts_last_notified_idx
  on public.error_alerts (last_notified_at desc nulls first);

alter table public.error_alerts enable row level security;
-- policy を 1 つも作らない = authenticated からは読めない。運営 admin (service 経路) のみ。
