-- GAP-159: 出力デザインテンプレの「運営既定」+ 種類の整理 (経営者指示 2026-08-19)
--
--   「見積もり、提案書、請求書、契約書、NDA、要件定義書、アーキ設計書、
--    デザイン仕様書、テスト仕様書、納品書・完了報告 で十分」
--   「変更加えれる前提で、初めのデフォルトはこちらの管理側で設定しているものでいい」
--   「管理側でデフォルトを決めるが、そこでも変更・更新・追加などできる状態に」
--
-- 設計:
--   - workspace_id を nullable にし、is_platform_default = true の行を「運営既定」とする
--     (全テナントが read 可・書き込みは運営 admin の service 経路のみ)
--   - 各 WS は既定を継承し、自分で作った版があればそちらが優先 (WS 版 > 既定)
--   - 「既定に戻す」は削除ではなく、既定 HTML を中身とする WS の新版を積む
--     (履歴不滅の原則を維持)

alter table public.output_design_templates
  add column if not exists is_platform_default boolean not null default false;

alter table public.output_design_templates
  alter column workspace_id drop not null;

alter table public.output_design_templates
  drop constraint if exists output_design_templates_scope_ck;
alter table public.output_design_templates
  add constraint output_design_templates_scope_ck check (
    (is_platform_default and workspace_id is null)
    or (not is_platform_default and workspace_id is not null)
  );

-- 運営既定は種類ごとに版連鎖 (workspace_id が NULL のため既存 unique が効かない)
create unique index if not exists output_design_templates_platform_uq
  on public.output_design_templates (stage, version)
  where is_platform_default;

create index if not exists output_design_templates_platform_idx
  on public.output_design_templates (stage, version desc)
  where is_platform_default;

-- 種類の整理: 経営者指定の 10 種以外は廃止 (未リリースのため行ごと削除)
delete from public.output_design_templates
where stage not in (
  'estimate','proposal','invoice','contract','nda',
  'requirements','architecture','design','verification','delivery'
);

-- RLS: 運営既定は全テナントが閲覧できる (書き込みは service 経路のみ = ポリシー無し)
drop policy if exists design_templates_select_member on public.output_design_templates;
create policy design_templates_select_member on public.output_design_templates
  for select to authenticated
  using (
    is_platform_default
    or workspace_id in (select public.current_user_workspaces())
  );

drop policy if exists design_templates_insert_member on public.output_design_templates;
create policy design_templates_insert_member on public.output_design_templates
  for insert to authenticated
  with check (
    not is_platform_default
    and workspace_id in (select public.current_user_workspaces())
  );

comment on column public.output_design_templates.is_platform_default is
  'GAP-159: true = 運営 (プラットフォーム) 既定デザイン。全テナントが継承し、WS 版があればそちらが優先。';
