-- GAP-138: チャット以外の LLM 実行 (モック生成/改訂 等) も Bridge (本人の
-- Claude サブスク) に中継できるようにする。
--
-- chat_relay_jobs.thread_id を nullable に緩和する — thread 無しの
-- 「システムジョブ」(モック生成など) を同じキューで運べる。requested_by は
-- 従来どおり必須で、user トークンの Bridge は本人のジョブのみ pick する
-- (GAP-122 の分離はそのまま効く)。
--
-- 冪等: 再適用安全。

alter table public.chat_relay_jobs
  alter column thread_id drop not null;
