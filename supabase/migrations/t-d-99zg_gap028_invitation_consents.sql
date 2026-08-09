-- GAP-028: S-L02 クライアントサインインの同意 2 種をサーバー永続化する。
--
-- これまで同意 (利用規約/プライバシー/越境 + 機密保持) は UI ゲートのみで、
-- サーバーには記録が残らなかった (通常ユーザーの consents は user_id 前提の
-- ため client には使えない)。client_invitation 単位で「いつ同意したか」を
-- タイムスタンプで永続する (法務証跡 — 初回同意時刻を保持し、以後の再サイン
-- インで上書きしない)。
--
-- 冪等: if not exists で再適用可能。

alter table public.client_invitations
  add column if not exists legal_consented_at timestamptz,
  add column if not exists confidential_consented_at timestamptz;

comment on column public.client_invitations.legal_consented_at is
  'GAP-028: 利用規約・プライバシーポリシー・越境同意への初回同意時刻 (S-L02 サインイン時に記録、上書きしない)';
comment on column public.client_invitations.confidential_consented_at is
  'GAP-028: 機密保持同意への初回同意時刻 (S-L02 サインイン時に記録、上書きしない)';
