-- GAP-027②: クライアント招待の使用回数 (アクセスカウント)
--
-- これまで used_at (初回使用日) 単発のみで、S-L01 モックの「使用回数」列を
-- 実データで描画できなかった。client_signin (招待トークン引き換え) の成功
-- ごとに use_count をインクリメントする。
--
-- backfill は偽装せず実データから: audit_logs の client.signin イベント
-- (client_signin が 1 成功 = 1 行書いている) を invitation 別に集計する。
--
-- Idempotency: add column if not exists + backfill は use_count=0 の行のみ。

begin;

alter table public.client_invitations
  add column if not exists use_count integer not null default 0;

comment on column public.client_invitations.use_count is
  'ポータルサインイン成功回数 (GAP-027②)。client.signin audit と同時に増分';

-- 実 audit ログからの backfill (初回適用時のみ意味を持つ。use_count が
-- 既に進んでいる行は触らない)
update public.client_invitations ci
set use_count = sub.cnt
from (
  select target_id, count(*) as cnt
  from public.audit_logs
  where action = 'client.signin' and target_type = 'client_invitation'
  group by target_id
) sub
where sub.target_id = ci.id and ci.use_count = 0;

commit;
