-- T-D-25: シードデータ — 法令ページ (terms_of_service / privacy_policy / 特商法)
--
-- 信頼源: 04_functional_breakdown/entities.json#E-026 (legal_documents)
-- 依存: T-D-25 migration (t-d-25_026.sql で legal_documents 作成済)
--
-- 各 doc_type の初版 (locale=ja, is_current=true) を投入する。
-- ⚠️ body_md は初版ドラフト。確定文言は法務レビュー後に新 version 行で差し替える
--    (consents.version で同意済み版を突き合わせるため、旧版は残し is_current のみ更新)。
-- Idempotency: (doc_type, version, locale) UNIQUE への UPSERT (on conflict do update)。

begin;

insert into public.legal_documents
  (doc_type, version, locale, title, body_md, effective_date, is_current)
values
  (
    'terms_of_service', '2026-05-25', 'ja', '利用規約',
    E'# 利用規約\n\n本利用規約（以下「本規約」）は、ENGINE BASE（以下「当社」）が提供する Atelier（以下「本サービス」）の利用条件を定めるものです。\n\n## 第1条（適用）\n本規約は、ユーザーと当社との間の本サービスの利用に関わる一切の関係に適用されます。\n\n## 第2条（アカウント）\nユーザーは自己の責任においてアカウントを管理するものとします。\n\n## 第3条（禁止事項）\nユーザーは、法令または公序良俗に違反する行為、当社・第三者の権利を侵害する行為を行ってはなりません。\n\n## 第4条（データの取扱い）\n顧客データは既定では AI 学習に利用しません（オプトイン時のみ）。詳細はプライバシーポリシーに従います。\n\n## 第5条（免責）\n当社は、本サービスに起因してユーザーに生じた損害について、当社の故意または重過失による場合を除き責任を負いません。\n\n## 第6条（規約の変更）\n当社は必要と判断した場合、ユーザーへの通知の上で本規約を変更できるものとします。',
    date '2026-05-25', true
  ),
  (
    'privacy_policy', '2026-05-25', 'ja', 'プライバシーポリシー',
    E'# プライバシーポリシー\n\nENGINE BASE（以下「当社」）は、Atelier（以下「本サービス」）における個人情報の取扱いについて、以下のとおりプライバシーポリシーを定めます。\n\n## 1. 取得する情報\nアカウント情報（氏名・メールアドレス）、利用ログ、ユーザーが投入したプロジェクトデータ等。\n\n## 2. 利用目的\n本サービスの提供・改善、サポート対応、法令に基づく対応のため。\n\n## 3. AI 学習への不使用\n顧客データは既定では AI モデルの学習に使用しません。学習利用はユーザーの明示的なオプトインがある場合に限ります。\n\n## 4. 第三者提供\n法令に基づく場合を除き、本人の同意なく第三者に提供しません。\n\n## 5. データの保管\nデータは東京リージョンの Supabase（PostgreSQL）に保管され、テナント間はアクセス制御により分離されます。\n\n## 6. 開示・訂正・削除\nユーザーは自己の個人情報の開示・訂正・削除を請求できます。\n\n## 7. お問い合わせ\n本ポリシーに関するお問い合わせは info@engine-base.com まで。',
    date '2026-05-25', true
  ),
  (
    'tokushoho', '2026-05-25', 'ja', '特定商取引法に基づく表記',
    E'# 特定商取引法に基づく表記\n\n- **販売事業者**: ENGINE BASE\n- **運営統括責任者**: （担当者名）\n- **所在地**: 請求があったら遅滞なく開示します。\n- **連絡先**: info@engine-base.com\n- **販売価格**: 各プランの料金ページに表示する金額（消費税込）。\n- **商品代金以外の必要料金**: インターネット接続料金等はユーザー負担。\n- **支払方法**: クレジットカード等、料金ページに表示する方法。\n- **支払時期**: 申込時または各課金サイクルの初日。\n- **役務の提供時期**: 決済完了後ただちに利用可能。\n- **返品・キャンセル**: 役務の性質上、提供開始後の返金は原則承りません（法令で認められる場合を除く）。',
    date '2026-05-25', true
  )
on conflict (doc_type, version, locale) do update set
  title          = excluded.title,
  body_md        = excluded.body_md,
  effective_date = excluded.effective_date,
  is_current     = excluded.is_current,
  updated_at     = now();

commit;
