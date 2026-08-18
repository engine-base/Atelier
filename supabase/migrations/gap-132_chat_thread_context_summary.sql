-- GAP-132: chat_threads にローリング要約の保存列を追加
--
-- 背景: 「これまでの経緯」は毎ターン全件を再走査して文字数で切り捨てていた
-- (content[:120] + char_budget 先頭落とし)。スレッド序盤の決定事項・前提が
-- 真っ先に消える実害があった。
--
-- 設計 (ローリング要約):
--   - context_summary: LLM が畳み込んだ「これまでの経緯」の要約本文
--   - context_summary_upto: 要約に反映済みの最新メッセージの created_at。
--     これ以降の溢れ分だけを次回の要約更新で畳み込む (毎ターン全件再走査を
--     やめる)。更新は応答完了後の非同期タスク (体感遅延ゼロ)。
--     失敗時は旧要約 + 従来の切り捨て版が自動フォールバックになる。
--
-- Idempotency: add column if not exists で re-run 安全。

begin;

alter table public.chat_threads
  add column if not exists context_summary text,
  add column if not exists context_summary_upto timestamptz;

comment on column public.chat_threads.context_summary is
  'GAP-132: ローリング要約 (LLM 生成)。F-CTX01 の「これまでの経緯」に使う。';
comment on column public.chat_threads.context_summary_upto is
  'GAP-132: 要約に反映済みの最新 chat_messages.created_at。以降の溢れ分だけを次回畳み込む。';

commit;
