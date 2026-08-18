-- GAP-137: チャット PC 操作の成果物 (HTML) をツール内モックへ自動反映
--
--   1. chat_relay_chunks.kind に 'artifact' を追加
--      (content = JSON {"mock_id","screen_name","version"} — SSE がモック保存
--       カードとしてチャットに配信する)
--   2. mock_contents — DB 内蔵のモック HTML ストア。
--      Supabase Storage が未設定の環境 (ローカル開発など) でもモックの
--      保存・閲覧・改訂を成立させる。mocks.html_storage_path には
--      'mockdb://{content_id}' 形式で参照を置く (従来の '{bucket}/{object}'
--      形式と共存 — 閲覧 URL の解決が分岐する)。
--
-- 冪等: 再適用安全。

alter table public.chat_relay_chunks
  drop constraint if exists chat_relay_chunks_kind_valid;
alter table public.chat_relay_chunks
  add constraint chat_relay_chunks_kind_valid
  check (kind in ('delta', 'tool', 'artifact'));

create table if not exists public.mock_contents (
  id         uuid primary key default gen_random_uuid(),
  html       text not null,
  created_at timestamptz not null default now()
);

alter table public.mock_contents enable row level security;
-- default deny: API サーバーの service 経路のみが読み書きする。
-- 閲覧はトークン検証付き GET /mocks/{id}/content 経由 (mocks 側の認可で
-- 署名 URL を発行してから到達する)。authenticated へ直接 grant しない。
revoke all on public.mock_contents from anon, authenticated;
