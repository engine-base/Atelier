-- GAP-021: S-A03「プラン」タブ (Stripe テストモード課金) + ワークスペースアイコン。
--
-- ① workspaces.icon — 絵文字または 1〜3 文字の短い表示文字 (null = 従来どおり頭文字表示)。
--    列自体は t-d-01 で存在するが、用途を「絵文字/短文字」に確定し、
--    API 検証 (最大 8 バイト・制御文字禁止) と揃う CHECK を配置する。
-- ② workspace_billing — Stripe 連携の課金状態 (workspace 1:1)。
--    RLS: メンバー select のみ。書き込みはサーバー (service session / RLS bypass) 限定
--    — checkout 照会 / webhook だけが更新経路 (偽の課金成功を UI から作れない)。
--
-- 冪等: if not exists / DO ブロックで再適用可能。

-- =============================================================================
-- ① workspaces.icon
-- =============================================================================
alter table public.workspaces add column if not exists icon text;

comment on column public.workspaces.icon is
  'ワークスペースアイコン: 絵文字または 1〜3 文字 (最大 8 バイト)。null = 名前の頭文字を表示';

-- 既存の自由入力データ (Lucide 名 / URL 想定時代) が居ても migration を落とさないよう
-- 8 バイト超の残存値は null に戻してから制約を張る (アイコン未設定 = 頭文字表示に退行)。
update public.workspaces
  set icon = null
  where icon is not null and (octet_length(icon) not between 1 and 8);

do $$ begin
  alter table public.workspaces
    add constraint workspaces_icon_length
    check (icon is null or octet_length(icon) between 1 and 8);
exception when duplicate_object then null; end $$;

-- =============================================================================
-- ② workspace_billing (E-002 拡張: Stripe 課金状態)
-- =============================================================================
create table if not exists public.workspace_billing (
  workspace_id           uuid primary key
                           references public.workspaces(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text,
  plan                   text not null default 'free'
                           constraint workspace_billing_plan_check
                           check (plan in ('free', 'pro')),
  status                 text not null default 'inactive',
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);

comment on table public.workspace_billing is
  'GAP-021 課金状態 (workspace 1:1)。行なし = free (誠実既定)。'
  '書き込みは service session のみ (checkout 照会 / Stripe webhook)。';
comment on column public.workspace_billing.status is
  'Stripe subscription status (active / trialing / past_due / canceled …)。行作成前は inactive';

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'workspace_billing_set_updated_at') then
    create trigger workspace_billing_set_updated_at
      before update on public.workspace_billing
      for each row execute function public.set_updated_at();
  end if;
end $$;

alter table public.workspace_billing enable row level security;

-- R-T08: メンバーのみ select。insert/update/delete の policy は張らない
-- (authenticated からの書き込みは常に拒否 = サーバー service session 専用)。
do $$ begin
  create policy workspace_billing_member_select on public.workspace_billing
    for select to authenticated
    using (
      exists (
        select 1 from public.workspace_memberships m
        where m.workspace_id = workspace_billing.workspace_id
          and m.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;
