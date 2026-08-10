-- GAP-018: S-N01 商談ドラフトの未実装機能群のバックエンド。
--
-- ① workflow_stage_enum に sales 専用 doc_type (contract / nda / invoice) を追加
--    (モックの 業務委託契約 / NDA / 請求書 タブの実体。canonical 9 工程には含めない
--    — sales-docs API のみが扱う)。
-- ② sales_doc_sends — メール送信履歴 (モックの送信履歴カードの実体)。
--    dry_run (メール未設定環境) を偽装せず列で明示する。
-- ③ knowledge_references.referrer_type に 'sales_doc' を追加
--    (生成トレース: ドラフトが参照した実ナレッジの記録)。
--
-- 冪等: if not exists / constraint 再作成で再適用可能。

alter type workflow_stage_enum add value if not exists 'contract';
alter type workflow_stage_enum add value if not exists 'nda';
alter type workflow_stage_enum add value if not exists 'invoice';

create table if not exists public.sales_doc_sends (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.workflow_outputs(id) on delete cascade,
  to_email text not null check (char_length(to_email) between 3 and 320),
  subject text not null,
  dry_run boolean not null default false,
  sent_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists sales_doc_sends_doc_idx
  on public.sales_doc_sends (doc_id, created_at desc);

alter table public.sales_doc_sends enable row level security;

do $$ begin
  create policy sales_doc_sends_member_select on public.sales_doc_sends
    for select to authenticated
    using (
      exists (
        select 1 from public.workflow_outputs o
        join public.projects p on p.id = o.project_id
        join public.workspace_memberships m on m.workspace_id = p.workspace_id
        where o.id = sales_doc_sends.doc_id and m.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy sales_doc_sends_member_insert on public.sales_doc_sends
    for insert to authenticated
    with check (
      exists (
        select 1 from public.workflow_outputs o
        join public.projects p on p.id = o.project_id
        join public.workspace_memberships m on m.workspace_id = p.workspace_id
        where o.id = sales_doc_sends.doc_id and m.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;

alter table public.knowledge_references
  drop constraint if exists knowledge_references_referrer_type_check;
alter table public.knowledge_references
  add constraint knowledge_references_referrer_type_check
  check (referrer_type = any (array[
    'chat_thread'::text, 'task'::text, 'decision'::text, 'feature'::text,
    'sales_doc'::text
  ]));
