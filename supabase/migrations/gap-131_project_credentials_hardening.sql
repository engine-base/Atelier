-- GAP-131: project_credentials の列レベル保護 (BYOK t-d-95 と同じパターン)
--
-- 背景: RLS を通過した authenticated セッションは encrypted_value (ciphertext)
-- を SELECT できてしまう。鍵が無ければ復号はできないが、BYOK に存在する
-- 「ciphertext すら API 越しに出さない」防御層が vault に無いのは不均衡だった。
--
-- 設計:
--   - encrypted_value は authenticated/anon から SELECT 不可にする。
--   - 一覧/詳細 API が使う非機密列のみ列レベル grant で開ける。
--   - reveal は service セッション (role を下げない接続) だけが ciphertext を
--     読める。可視性チェック (RLS) → ciphertext 取得 (service) の 2 段構成は
--     src/services/project_credentials/__init__.py::reveal_credential が担う。
--   - INSERT/UPDATE/DELETE は従来どおり RLS policy で制御 (全列可 =
--     暗号文の書き込みは可能。RETURNING id は id の SELECT 権限で賄う)。
--
-- Idempotency: revoke/grant は再実行安全。

begin;

revoke select on public.project_credentials from authenticated, anon;
grant select (id, project_id, name, kind, last4, created_by,
              created_at, updated_at, deleted_at)
  on public.project_credentials to authenticated;

comment on column public.project_credentials.encrypted_value is
  'Fernet 暗号化済 ciphertext。GAP-131 で authenticated から列レベル revoke 済 — '
  'reveal API の service セッションのみが読める。平文は保存も応答もしない。';

commit;
