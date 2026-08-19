# GAP-153: ナレッジ自動キュレーション — 運営 AI 裏走・匿名化・全アカウント共有

経営者すり合わせ (2026-08-18):
「ユーザー提案のフローはしない。ナレッジは管理側かもしくは運営として裏で AI を
走らせて自動で分ける感じ。その中でセキュリティも担保する的な」

## 実装 (どこで動くか・誰の費用か)

- **運営側バッチ** (SaaS クラウド、運営の ANTHROPIC_API_KEY 費用 — テナントの
  サブスクは使わない): 全テナントの良質ナレッジ (使用回数≥3 or 確信度≥0.7、
  scope=common) を走査し、LLM が①全社的に有用か判定 ②固有情報 (社名/氏名/顧客名/
  金額/連絡先/URL/ID) を除去した一般化本文に書き直す。運営キー未設定は誠実に 503。
- **セキュリティ担保 (二重・LLM を信用しない)**:
  1. LLM の匿名化 (プロンプト契約)
  2. **決定的リークスキャン** — 元テナントの workspace 名/全プロジェクト名/
     メンバー氏名/メールアドレスを DB から取得して機械照合 + email/電話番号/URL の
     正規表現検出。1 件でも残れば rejected_security (公開候補から機械的に排除)。
     さらに**承認の瞬間にも再スキャン** (走査後にテナント情報が変わっても捕捉)。
- **承認ゲート**: 自動公開はしない。knowledge_curations (RLS default deny —
  テナントには存在自体が不可視) に貯まり、運営 admin が S-T06 で承認して初めて
  platform ナレッジ (is_anonymized=true, approved_by 記録) として全アカウント共有。
  既存 RAG は platform を全テナント横断参照するため、承認の瞬間から各社の AI が使う
  (embedding は GAP-133 の自動バックフィルが付与)。
- **API**: POST /admin/knowledge/curation/run (limit)、GET /admin/knowledge/curation
  ?status=、POST …/{id}/approve・/reject。1 ソース = 1 キュレーション (再走で重複しない)。
- **UI (S-T06)**: 「今すぐ走らせる」(実測統計表示) + 承認待ち/セキュリティ除外/
  公開済みタブ + 匿名化済み本文プレビュー + 出所 (運営監査用) + 承認/却下。

## 証拠 (実 e2e)

- `e2e-api-evidence.txt` — バッチ実測 {scanned:2, proposed:1, rejected_security:1}。
  **リークスキャンが実際に workspace 名 (e2e137-ws)・プロジェクト名 (E2E137)・
  メール形式・URL を検出**して除外 / 非 admin 403 / 承認後の platform 行
  (is_anonymized=t, approved_by 記録) / authenticated ロールから curations が
  一切読めない (RLS default deny) の実測
- `gap153-queue.png` — 承認キュー (匿名化済み本文 + 出所 + 判定理由)
- `gap153-approved.png` / `gap153-security.png` — 承認通知 / セキュリティ除外タブ
- `shot-gap153.mjs` — 撮影スクリプト

## テスト (実 Postgres)

- `tests/routes/test_admin_knowledge.py` +3:
  - 裏走バッチ: 有用→pending 提案 / **原文引き写し (leaky) をリークスキャンが
    社名・メール・URL で機械検出**して rejected_security / 非 admin 403 / 再走重複なし
  - 承認 → platform 公開 (is_anonymized/approved_by 検証)・処理済み 409・
    **承認直前の再スキャンで混入を 409 + rejected_security に落とす**
  - 運営キー未設定 503 (勝手に空実行しない)
- web `curation-queue.test.tsx` +2: キュー表示/承認 API/実測統計/503 honest 表示
- 回帰: admin_knowledge + knowledge 系 44 PASS、ruff/pyright/tsc/lint クリーン
