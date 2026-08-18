-- GAP-145: 成果物の全形式対応 (画像 / PPTX / PDF / Excel / 動画 等)
--
-- GAP-137/139 の成果物取り込みは HTML 限定だった (経営者指摘「なんで PPTX や
-- MP4、画像等できないのか」)。実行エンジン (本人 PC の Bridge + claude CLI)
-- は同じなので、HTML 以外のファイルも拾って保管・配信できるようにする。
--
-- バイナリ実体は本テーブル (RLS default deny — service 経路のみ) に置き、
-- workflow_outputs.html_path に 'filedb://{id}' を記録する (mockdb:// と同じ
-- 「DB 内蔵ストア + 自己署名 URL 配信」方式 — Storage 未設定環境でも動く)。
-- html_path 列は歴史的名称で、実態は「主要成果物のパス」(コメントで固定)。

create table if not exists public.artifact_files (
  id         uuid primary key default gen_random_uuid(),
  data       bytea not null,
  mime       text not null,
  file_name  text not null,
  byte_size  integer not null check (byte_size >= 0),
  created_at timestamptz not null default now()
);

comment on table public.artifact_files is
  'GAP-145: チャット成果物のバイナリ実体 (filedb://)。読み書きは service 経路のみ。';
comment on column public.workflow_outputs.html_path is
  '主要成果物のパス (歴史的に html_path)。supabase storage パス / mockdb://{id} (HTML) / filedb://{id} (バイナリ)。';

alter table public.artifact_files enable row level security;
revoke all on public.artifact_files from anon, authenticated;
