-- GAP-144: スキル本文 (SKILL.md) の DB 層秘匿
--
-- skills は「運営 admin が準備し、各ユーザーは装着済みスキルの効果だけを受ける」
-- 設計 (T-A-49)。API 応答は SkillLiteResponse (name/version/description のみ) だが、
-- RLS skills_select_all (using true) は行レベル制御であり列は隠せないため、
-- 本番 (Supabase Auth 発行 JWT = PostgREST でも有効) ではユーザーが DB を直叩き
-- すると content_md (スキル本文) / allowed_* (運用設定) を読めてしまう。
--
-- 対処: authenticated / anon の表全体 grant を剥がし、authenticated には
-- カタログ表示に必要な軽量列のみ列単位で grant し直す (GAP-131 vault と同手法)。
-- API 内部の本文読取 (チャット注入 / モック生成注入 / admin 閲覧) は
-- service_role 経由に変更済のため影響しない。

revoke select, insert, update, delete on public.skills from anon;
revoke select, insert, update, delete on public.skills from authenticated;

grant select (id, name, version, description, is_active, created_at, updated_at)
  on public.skills to authenticated;
