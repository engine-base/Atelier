-- GAP-193: 取りこぼした自動実行を「黙って消さない」。
--
-- 経営者質問「これは何？ 日次ダイジェストの遡り生成」への回答と対応。
--
-- これまでの実態:
--   見張り役 (PC / クラウド) は「発火時刻を過ぎた行」を拾って **1 回だけ** 実行し、
--   次回時刻を **今から見た次の定刻** へ進めていた。つまり PC を 3 日止めていた場合、
--   起動時に走るのは 1 回だけで、**間の 2 日分は黙って消えていた**。
--   実行履歴にも「飛ばした」記録が無いので、人が気づく手段が無かった。
--
-- ここで直すこと: **飛ばした回数を必ず実行履歴に残す**。
--
-- ⚠️ 「遡って作り直す」は入れていない (意図的)。
--   daily_digest / weekly_burndown 等の集計は SQL が `now() - interval '24 hours'`
--   のように **現在時刻に固定** されているため、3 回走らせても
--   「同じ今日の内容」が 3 個できるだけで、3 日分にはならない。
--   本当に遡るには各 action が「いつ時点で集計するか」を受け取れる必要があり、
--   6 種の runner と集計 SQL の作り替えになる。動かないスイッチは出さない。
alter table public.cron_run_history
  add column if not exists skipped_occurrences integer not null default 0;

comment on column public.cron_run_history.skipped_occurrences is
  'GAP-193: この実行の前に飛ばした定刻の回数 (0 = 取りこぼしなし)。'
  ' PC 停止などで消えた回数を人が気づけるようにするための記録。';

create index if not exists cron_run_history_skipped_idx
  on public.cron_run_history (schedule_id, started_at desc)
  where skipped_occurrences > 0;
