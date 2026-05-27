-- T-A-13: users.ai_learning_opt_out (アカウント単位 AI 学習オプトアウト)
--
-- 信頼源: 07_api_design/openapi.yaml#User.ai_learning_opt_out (既定 true) + F-LEGAL-011
-- 背景: openapi の User schema は ai_learning_opt_out を持つが DB users 列が無かった。
--   アカウント単位の AI 学習 OFF を保存するため列を追加 (既定 true=学習しない)。
--   更新は既存の users_update_self policy (self のみ) で enforce される。
-- Idempotency: add column if not exists。
begin;
alter table public.users
  add column if not exists ai_learning_opt_out boolean not null default true;
comment on column public.users.ai_learning_opt_out is
  'F-LEGAL-011 アカウント単位 AI 学習オプトアウト (既定 true=学習に使わない)';
commit;
