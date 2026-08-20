-- GAP-190: スレッドごとに「同じ Claude セッション」で走らせる。
--
-- 経営者確認 (2026-08-20):
--   「そのセッション内ではずっと同じターミナルのセッションとして走れるという
--     認識だよね？ それだと色々上記の問題も治ると思っているけど」
--   → 実 CLI で成立を確認済み:
--       ① --session-id 指定 → 別プロセスで --resume すると会話が引き継がれる
--       ② セッションは ~/.claude/projects/<cwd を - に置換>/<id>.jsonl の
--          実ファイルとして残る (プロセス死・PC 再起動を跨いで残る)
--
-- これまでの実態: 毎回まっさらな `claude -p` を起動し、会話の中身はサーバーが
-- DB 履歴 + ローリング要約から組み直して**毎回送り直していた**。
--   - Claude Code 側のセッション状態 (TODO・作業途中) が毎ターン消える
--   - 履歴を毎回送るので、利用者のプラン枠を余分に消費する
--
-- ここで用意するもの:
--   1. スレッドが「どの PC の、どのセッション」を使っているか
--   2. ジョブに載せる「使ってほしいセッション ID」と、
--      再開できなかったときのための「履歴を畳んだプロンプト」
--   3. Bridge が実際に使ったセッション ID と、再開できたかの報告

alter table public.chat_threads
  add column if not exists claude_session_id uuid,
  add column if not exists claude_session_worker_id text,
  add column if not exists claude_session_used_at timestamptz;

comment on column public.chat_threads.claude_session_id is
  'GAP-190: このスレッドが使う Claude セッション ID。null = まだ無い。';
comment on column public.chat_threads.claude_session_worker_id is
  'GAP-190: そのセッションが存在する PC (Bridge worker)。'
  ' セッションは PC ローカルなので、別 PC で開いたら新しいセッションになる。';
comment on column public.chat_threads.claude_session_used_at is
  'GAP-190: 最後にそのセッションで実行した時刻。';

alter table public.chat_relay_jobs
  -- サーバーが「これを使ってほしい」と渡すセッション ID (Bridge は再開可能なら使う)
  add column if not exists session_id uuid,
  -- 再開できなかったときに使う、履歴を畳んだプロンプト。
  -- 再開できたときは prompt (新しい発言だけ) で足りる = プラン枠の節約になる。
  add column if not exists prompt_full text,
  -- Bridge が実際に再開できたか (報告)。null = 未報告 / セッション非対象のジョブ
  add column if not exists resumed boolean;

comment on column public.chat_relay_jobs.session_id is
  'GAP-190: 使ってほしい Claude セッション ID。Bridge は PC 上に実体があれば --resume する。';
comment on column public.chat_relay_jobs.prompt_full is
  'GAP-190: 再開できなかった場合に使う「履歴を畳んだ」プロンプト。'
  ' 再開できた場合は prompt (新しい発言のみ) を使うので送信量が減る。';
comment on column public.chat_relay_jobs.resumed is
  'GAP-190: Bridge が実際にセッションを再開できたか。嘘をつかず実測値を記録する。';
