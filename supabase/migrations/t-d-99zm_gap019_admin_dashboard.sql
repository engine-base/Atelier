-- GAP-019: S-T01 運営ダッシュボードの未描画セクション群のバックエンド。
--
-- ① admin_goals — 事業 KPI 目標の記録 (ミッションヒーローの実体。目標値は
--    運営が明示的に記録する — システムが数値を創作しない)。
-- ② beta_feedback — ベータ FB 収集 (認証ユーザーが投稿、運営が resolve)。
-- ③ acquisition_records — 取得チャネルの記録 (チャネル別集計の実データ源)。
-- ④ admin_costs — 運営側コストの記録 (月次。実請求額を運営が記録する)。
--
-- いずれも運営 (platform admin) 専用データ。RLS は有効化のみ (authenticated
-- への policy を置かない = deny)。アクセスは API の is_admin ゲート +
-- service session (RLS bypass) 経由に限定する (S-T02 skills と同じ構造)。
-- beta_feedback の投稿のみ認証ユーザー本人が API 経由で行う (service session)。
--
-- 冪等: if not exists で再適用可能。

create table if not exists public.admin_goals (
  id uuid primary key default gen_random_uuid(),
  goal_key text not null unique,
  title text not null check (char_length(title) between 1 and 200),
  target_count integer not null check (target_count > 0),
  deadline date not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.admin_goals enable row level security;

create table if not exists public.beta_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  email text not null default '',
  category text not null default 'other'
    check (category in ('bug', 'feature', 'praise', 'other')),
  content text not null check (char_length(content) between 1 and 4000),
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists beta_feedback_status_idx
  on public.beta_feedback (status, created_at desc);
alter table public.beta_feedback enable row level security;

create table if not exists public.acquisition_records (
  id uuid primary key default gen_random_uuid(),
  channel text not null
    check (channel in ('referral', 'sns', 'personal', 'other')),
  note text not null default '',
  occurred_on date not null default current_date,
  created_at timestamptz not null default now()
);
create index if not exists acquisition_records_occurred_idx
  on public.acquisition_records (occurred_on desc);
alter table public.acquisition_records enable row level security;

create table if not exists public.admin_costs (
  id uuid primary key default gen_random_uuid(),
  month date not null,
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '',
  amount_yen integer not null check (amount_yen >= 0),
  created_at timestamptz not null default now()
);
create index if not exists admin_costs_month_idx
  on public.admin_costs (month desc, created_at);
alter table public.admin_costs enable row level security;
