-- GAP-177: 議事録の構造化解析を「本人の Claude サブスク」で行えるようにする。
--
-- 解析は文字起こしの後段バッチで走る。実行を本人の PC の Bridge に移すと、
-- バッチが回った瞬間に本人の PC が落ちていれば解析できない。従来の作りでは
-- その行は parsed_at が入って「完了」扱いになり、**二度と解析されない**。
-- (= 運営 API キーをやめた途端に「解析が永久に欠ける」劣化になる)
--
-- そこで「解析だけ保留中」を表せる列を足す。null = 保留なし。
-- 値が入っている行はバッチが後から解析だけ再実行する (Whisper は再実行しない)。
alter table public.external_uploads
  add column if not exists analysis_pending_since timestamptz;

comment on column public.external_uploads.analysis_pending_since is
  'GAP-177: 構造化解析だけが未完了 (本人の Bridge 未接続等)。null = 保留なし。'
  ' 値があると worker が解析のみ再実行する (文字起こしは再実行しない)。';

-- 再試行対象の抽出用。保留がある行だけを見るので部分インデックスにする。
create index if not exists external_uploads_analysis_pending_idx
  on public.external_uploads (analysis_pending_since)
  where analysis_pending_since is not null;
