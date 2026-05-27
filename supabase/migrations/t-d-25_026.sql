-- T-D-25: legal_documents (E-026) — 法令ページ本文 (terms / privacy / 特商法)
--
-- 信頼源: 04_functional_breakdown/entities.json#E-026
-- 関連: F-LEGAL (terms_of_service / privacy_policy / 特定商取引法に基づく表記)、
--       consents.version の参照先 (どの版に同意したかを突き合わせる)
-- 依存: T-D-01 (set_updated_at())
--
-- 設計:
--   - 法令ページは公開コンテンツ (anon / authenticated とも閲覧可)。
--   - 版管理: (doc_type, version, locale) UNIQUE。is_current で現行版を 1 つ指定。
--   - 書き込みは service_role / admin のみ (authenticated は default-deny の write)。
--
-- Idempotency: CREATE IF NOT EXISTS + drop policy if exists。

begin;

create table if not exists public.legal_documents (
  id              uuid primary key default gen_random_uuid(),
  doc_type        text not null,
  version         text not null,
  locale          text not null default 'ja',
  title           text not null,
  body_md         text not null,
  effective_date  date not null,
  is_current      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint legal_documents_doc_type_valid
    check (doc_type in ('terms_of_service', 'privacy_policy', 'tokushoho')),
  constraint legal_documents_title_length
    check (char_length(title) between 1 and 200),
  constraint legal_documents_body_not_empty
    check (char_length(body_md) >= 1),
  constraint legal_documents_doc_type_version_locale_key
    unique (doc_type, version, locale)
);

comment on table public.legal_documents is
  'E-026 LegalDocument — 法令ページ本文 (terms/privacy/特商法)。公開閲覧可、版管理。';
comment on column public.legal_documents.is_current is
  '現行版フラグ。(doc_type, locale) ごとに 1 件のみ true (partial unique で担保)。';

-- (doc_type, locale) ごとに現行版は 1 つだけ
create unique index if not exists legal_documents_current_uidx
  on public.legal_documents (doc_type, locale)
  where is_current;

-- updated_at トリガ (T-D-01 set_updated_at() 再利用)
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'legal_documents_set_updated_at') then
    create trigger legal_documents_set_updated_at
      before update on public.legal_documents
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS: 公開閲覧 (anon/authenticated SELECT) のみ permissive policy を作る。
--   INSERT/UPDATE/DELETE は permissive policy を「作らない」ことで default-deny。
--   (RLS 有効 + 該当 policy 不在 = 拒否)。法令本文の更新は service_role (BYPASSRLS)
--   / admin 経路でのみ行う。
-- =============================================================================
alter table public.legal_documents enable row level security;

drop policy if exists legal_documents_public_read on public.legal_documents;
create policy legal_documents_public_read on public.legal_documents
  for select to anon, authenticated
  using (true);

commit;
