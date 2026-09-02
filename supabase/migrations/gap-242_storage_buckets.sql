-- GAP-242: API が使う Supabase Storage のバケットを migration で作る。
--
-- 実測 (2026-09-02 本番): チャット添付 (POST /chat/attachments/upload-url) と議事録
-- (POST /meetings/upload-url) が **502 STORAGE_ERROR**。Storage API へ public 経路で
-- 触っても全バケットが "Bucket not found"。どの migration も deploy も storage.buckets
-- に行を入れておらず、**バケットは「ダッシュボードで手で作る」前提のまま本番へ出ていた**。
-- ローカル / CI は署名 URL を発行しない (storage_unconfigured) 経路で緑になるため、
-- 本番で初めて出る壊れ方。
--
-- 対象 (API のコードから確定 — 追加するときはここにも足す):
--   chat-attachments  services/chat            ATTACHMENT_BUCKET
--   outputs           services/outputs/revise  成果物 HTML
--   mocks             services/mocks/revise    モック HTML
--   avatars           services/ai_employees    ICON_BUCKET (ai-employees/{id}/…)
--   meetings          services/meetings        STORAGE_BUCKET 既定値 (音声/議事録の元ファイル)
--   transcripts       services/meetings/worker transcripts/queued|results/{id}.json
--   reference-uploads routes/references        REFERENCE_BUCKET (スタジオの参考資料)
--
-- すべて private (public=false)。読み書きは service_role の署名 URL 経由のみなので
-- storage.objects の RLS policy は不要 (anon / authenticated から直接は触れない)。
--
-- 冪等: on conflict (id) do nothing。既にダッシュボードで作ってあっても壊さない。
-- 汎用 PostgreSQL (CI Gate #14 / ローカル) には storage スキーマが無いので、その場合は
-- 何もしない (plpgsql は到達しない文を解析しないため、参照エラーにならない)。

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'GAP-242: storage.buckets が無い環境 (Supabase 以外) のため skip';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values
    ('chat-attachments', 'chat-attachments', false),
    ('outputs', 'outputs', false),
    ('mocks', 'mocks', false),
    ('avatars', 'avatars', false),
    ('meetings', 'meetings', false),
    ('transcripts', 'transcripts', false),
    ('reference-uploads', 'reference-uploads', false)
  on conflict (id) do nothing;
end
$$;
