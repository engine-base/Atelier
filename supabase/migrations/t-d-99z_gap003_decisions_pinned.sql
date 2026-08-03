-- GAP-003: 確定事項のピン留め (S-E01 主力決定カードの「ピン留め済み」)
-- 冪等: 再適用しても安全。RLS は既存 decisions ポリシー (update は member) を継承する。

alter table public.decisions
  add column if not exists pinned boolean not null default false;

comment on column public.decisions.pinned is
  'ピン留め (GAP-003)。一覧でピン留めが先頭に来る。PATCH /decisions/{id} で切替';
