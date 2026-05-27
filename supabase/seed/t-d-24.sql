-- T-D-24: シードデータ — AI 社員 10 名 + skill templates
--
-- 信頼源: 06_mockups/employee/S-C01-org.html (運営側で固定された AI 社員 10 名構成) +
--          04_functional_breakdown/entities.json (E-008 AiEmployeeTemplate / E-009 Skill)
-- 依存: T-D-03 (skills / ai_employee_templates / ai_employees 作成済)
--
-- 構成 (mockup 準拠、追加・削除不可の固定 10 名):
--   executive        : jarvis (COO・全社統括)
--   sales            : tony (部長), natasha (メンバー)
--   product          : steve (部長), peter (メンバー)
--   architecture     : strange (部長)
--   design           : wanda (部長)
--   dev_qa           : thor (部長), vision (メンバー)
--   cross_functional : tchalla (ナレッジ統括)
--
-- skill スラッグも mockup の各社員カード記載に準拠。
-- Idempotency: skills は (name, version)、templates は (default_name, version) の
--   UNIQUE 制約に対する UPSERT (on conflict do update) で再実行安全。
-- system_prompt / specialty は seed 用の確定文 (列が NOT NULL のため必須)。

begin;

-- =============================================================================
-- 1) skill templates (E-009) — mockup 記載スラッグ
-- =============================================================================
insert into public.skills (name, version, description, content_md, is_active) values
  ('task-management',        '1.0.0', 'タスク管理・進捗統括',           '# task-management\n全社のタスクと進捗を統括するスキル。', true),
  ('weekly-review',          '1.0.0', '週次レビュー',                   '# weekly-review\n週次の進捗・バーンダウンをレビューする。', true),
  ('sales-email',            '1.0.0', '営業メール作成',                 '# sales-email\n商談・フォローの営業メールを作成する。', true),
  ('proposal',               '1.0.0', '提案書作成',                     '# proposal\n顧客向け提案書を作成する。', true),
  ('estimate',               '1.0.0', '見積作成',                       '# estimate\n工数・費用の見積を作成する。', true),
  ('business-contract',      '1.0.0', '契約書レビュー',                 '# business-contract\n業務委託・取引基本契約をレビューする。', true),
  ('nda-review',             '1.0.0', 'NDA レビュー',                   '# nda-review\n秘密保持契約をレビューする。', true),
  ('hearing',                '1.0.0', 'ヒアリング',                     '# hearing\n顧客要望をヒアリングし整理する。', true),
  ('requirements-definition','1.0.0', '要件定義',                       '# requirements-definition\n機能・非機能要件を定義する。', true),
  ('task-decomposition',     '1.0.0', 'タスク分解',                     '# task-decomposition\n要件を実装タスクへ分解する。', true),
  ('acceptance-criteria',    '1.0.0', '受入条件定義',                   '# acceptance-criteria\n3-tier 受入条件を定義する。', true),
  ('architecture-design',    '1.0.0', 'アーキテクチャ設計',             '# architecture-design\nシステム全体のアーキテクチャを設計する。', true),
  ('api-design',             '1.0.0', 'API 設計',                       '# api-design\nOpenAPI 契約を設計する。', true),
  ('design-md',              '1.0.0', 'デザイン仕様',                   '# design-md\nデザインシステム仕様を作成する。', true),
  ('ui-mockup',              '1.0.0', 'UI モック作成',                  '# ui-mockup\n画面 HTML モックを作成する。', true),
  ('brand-voice',            '1.0.0', 'ブランドボイス',                 '# brand-voice\nブランドのトーン&ボイスを定義する。', true),
  ('distributed-dev',        '1.0.0', '分散開発統括',                   '# distributed-dev\n並列タスク実行を統括する。', true),
  ('tdd-workflow',           '1.0.0', 'TDD ワークフロー',               '# tdd-workflow\nテスト駆動開発を進める。', true),
  ('verification-loop',      '1.0.0', '検証ループ',                     '# verification-loop\n受入検証ループを回す。', true),
  ('quality-gate',           '1.0.0', '品質ゲート',                     '# quality-gate\nリリース品質ゲートを判定する。', true),
  ('knowledge-organize',     '1.0.0', 'ナレッジ整理',                   '# knowledge-organize\n横断ナレッジを整理する。', true),
  ('industry-extract',       '1.0.0', '業界傾向抽出',                   '# industry-extract\n業界傾向を抽出する。', true),
  ('cross-learning',         '1.0.0', '横断学習',                       '# cross-learning\nプロジェクト横断で学習する。', true)
on conflict (name, version) do update set
  description = excluded.description,
  content_md = excluded.content_md,
  is_active  = excluded.is_active,
  updated_at = now();

-- =============================================================================
-- 2) AI 社員テンプレート (E-008) — 固定 10 名
--    default_skills は上で seed した skills を name で逆引きして配列化。
-- =============================================================================
insert into public.ai_employee_templates
  (default_name, default_display_name, default_icon, department, role, version,
   default_skills, default_knowledge_cats, system_prompt, specialty, is_active)
values
  ('jarvis','ジャービス','J','executive','coo',1,
   (select coalesce(array_agg(id), '{}'::uuid[]) from public.skills where name in ('task-management','weekly-review')),
   array['management'],
   'あなたは Atelier の COO ジャービスです。全社のタスク・進捗を統括し、経営判断を補佐します。',
   '全社統括・進捗管理', true),

  ('tony','トニー','T','sales','lead',1,
   (select coalesce(array_agg(id), '{}'::uuid[]) from public.skills where name in ('sales-email','proposal','estimate')),
   array['sales'],
   'あなたは営業・契約部の部長トニーです。提案・見積・営業コミュニケーションを主導します。',
   '営業・提案・見積', true),

  ('natasha','ナターシャ','N','sales','member',1,
   (select coalesce(array_agg(id), '{}'::uuid[]) from public.skills where name in ('business-contract','nda-review')),
   array['legal','sales'],
   'あなたは営業・契約部のナターシャです。契約書・NDA のレビューを担当します。',
   '契約・法務レビュー', true),

  ('steve','スティーブ','S','product','lead',1,
   (select coalesce(array_agg(id), '{}'::uuid[]) from public.skills where name in ('hearing','requirements-definition')),
   array['product'],
   'あなたはプロダクト企画部の部長スティーブです。ヒアリングと要件定義を主導します。',
   'ヒアリング・要件定義', true),

  ('peter','ピーター','P','product','member',1,
   (select coalesce(array_agg(id), '{}'::uuid[]) from public.skills where name in ('task-decomposition','acceptance-criteria')),
   array['product'],
   'あなたはプロダクト企画部のピーターです。タスク分解と受入条件定義を担当します。',
   'タスク分解・受入条件', true),

  ('strange','ストレンジ','D','architecture','lead',1,
   (select coalesce(array_agg(id), '{}'::uuid[]) from public.skills where name in ('architecture-design','api-design')),
   array['architecture'],
   'あなたは設計部の部長ストレンジです。アーキテクチャと API 契約を設計します。',
   'アーキテクチャ・API 設計', true),

  ('wanda','ワンダ','W','design','lead',1,
   (select coalesce(array_agg(id), '{}'::uuid[]) from public.skills where name in ('design-md','ui-mockup','brand-voice')),
   array['design'],
   'あなたはデザイン部の部長ワンダです。デザインシステム・UI モック・ブランドボイスを担当します。',
   'デザイン・UI・ブランド', true),

  ('thor','ソー','T','dev_qa','lead',1,
   (select coalesce(array_agg(id), '{}'::uuid[]) from public.skills where name in ('distributed-dev','tdd-workflow')),
   array['development'],
   'あなたは開発・検証部の部長ソーです。分散開発と TDD ワークフローを統括します。',
   '分散開発・TDD', true),

  ('vision','ヴィジョン','V','dev_qa','member',1,
   (select coalesce(array_agg(id), '{}'::uuid[]) from public.skills where name in ('verification-loop','quality-gate')),
   array['qa'],
   'あなたは開発・検証部のヴィジョンです。検証ループと品質ゲートを担当します。',
   '検証・品質ゲート', true),

  ('tchalla','ティチャラ','T','cross_functional','lead',1,
   (select coalesce(array_agg(id), '{}'::uuid[]) from public.skills where name in ('knowledge-organize','industry-extract','cross-learning')),
   array['knowledge'],
   'あなたは全社横断のナレッジ統括ティチャラです。ナレッジ整理・業界傾向抽出・横断学習を担当します。',
   'ナレッジ統括・横断学習', true)
on conflict (default_name, version) do update set
  default_display_name   = excluded.default_display_name,
  default_icon           = excluded.default_icon,
  department             = excluded.department,
  role                   = excluded.role,
  default_skills         = excluded.default_skills,
  default_knowledge_cats = excluded.default_knowledge_cats,
  system_prompt          = excluded.system_prompt,
  specialty              = excluded.specialty,
  is_active              = excluded.is_active,
  updated_at             = now();

commit;
