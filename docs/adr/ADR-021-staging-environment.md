# ADR-021: staging 環境の定義（本番と同じ migration / deploy で作る別インスタンス）

- **Status**: Accepted（2026-09-02 経営者が A を承認。`selected-stack.json` の `environments.staging.decision = approved`）
- **Date**: 2026-09-02
- **Decider**: 経営者 + 実装 AI
- **Category**: infrastructure / quality
- **Related**: GAP-246, GAP-241〜245, `.claude/rules/common/test-ladder.md` §5, `docs/staging-setup.md`

## 文脈

2026-09-02 に本番を実際のお客さんとして使って、5 件の不具合が出た（保存先バケット未作成 / AI の無言終了 /
Bridge 終了後 90 秒の誤表示 / モード切替の無視 / 退会後もセッション有効）。5 件とも **ローカル環境では緑**で、
本番で初めて壊れた。ローカルは認証がスタブ・保存先が「未設定」経路・Bridge が動作する Mac、という
本番と違う前提で動いていたからだ。

テスト・ラダー（CLAUDE.md ルール 21〜22）では、ブラウザ通し・ジャーニー・AI 実動（L1〜L3）は
**本番同等の staging で流し、本番はスモーク（L4）だけ**と決めた。その staging が Atelier には無い。

## 決めること

staging を「どの DB・どの認証・どの保存先・どの API/Web で」実現するか。**構成は決め打ちしない**。
条件は 4 つ（test-ladder.md §5 / architecture-design v3.2）:

1. **本番と同じ migration / deploy / プロビジョニングコード**で作れる（ダッシュボードの手作業に依存しない）
2. 本番と**同じ種類の依存**（DB・認証・ストレージ・キュー・外部プロバイダのテストモード）を持つ
3. **データ方針**（使い捨て / 匿名化コピー）と、破壊的テストが許される範囲が明文化されている
4. **費用と誰が用意するか**が決まっている

## 選択肢

| | A. 本番と同じ SaaS の別インスタンス | B. Supabase Branching（Pro） | C. セルフホスト（Docker 1 台） |
|---|---|---|---|
| DB / 認証 / 保存先 | Supabase **別プロジェクト**（Free, Tokyo） | Supabase Pro のブランチ DB（PR ごと自動） | Postgres + GoTrue + storage-api を自前 |
| API | Fly.io 別 app `atelier-api-staging`（nrt, auto-stop） | 同左 | 同じ Fly 1 台に同居 |
| Web | Vercel Preview（`staging` ブランチ、API 先を staging へ） | 同左 | 同左 |
| 条件 1 | ○ deploy.yml の `environment=staging` で同じ手順 | ○ | △ compose を別途保守 |
| 条件 2 | ○ Supabase Auth / Storage / RLS が実物 | ○ | × 認証・保存先が別物 → GAP-242 型を検出できない |
| 条件 3 | 使い捨て（seed + QA アカウント）。破壊テスト全面可 | 同左（ブランチ破棄で消える） | 同左 |
| 条件 4 費用 | **約 $0/月**（Free 枠。1 週無活動で休止 → 外形監視で防ぐ） | **$25/月〜** + ブランチ従量 | $0〜5/月 |
| 条件 4 用意する人 | 経営者: Supabase プロジェクト + Fly app + GitHub secrets 2 つ（約 1 時間） | 経営者: Pro 契約 + Branching 有効化 | 実装者 |
| 弱点 | 休止対策が要る / 本番と同じ手動 deploy | 費用 | 本番と乖離する |

## 推奨

**A を今すぐ。有料化（Pro）のタイミングで B へ移行。**

- 4 条件を満たす中で唯一 $0。
- GAP-241〜245 の 5 件を再現できる依存（Supabase Auth・Storage・RLS・Fly の auto-stop・Vercel の SSR）が**すべて実物**で入る。
- C は「本番だけ壊れる」を潰すという目的に反する（認証・保存先が別物）ので不採用。

## 決定（承認後に記入）

- 採用: **A**（本番と同じ SaaS の別インスタンス）
- 承認日: 2026-09-02
- 用意した資源: Supabase project ref ____ / Fly app ____ / Vercel preview URL ____

## 結果・影響

- `03_architecture/selected-stack.json` に `environments.{local, staging, production}` を追加（staging は `decision: proposed` で起票済み）。
- `.github/workflows/deploy.yml` に `environment` 入力（production | staging）を追加し、**同じ手順**で staging へ deploy できるようにする。secrets は `STAGING_DATABASE_URL` / `STAGING_FLY_APP_NAME`。
- 外部リソースはコードで作る（G-11）: バケット = `supabase/migrations/gap-242_storage_buckets.sql`、法務文書・AI 社員テンプレ = `supabase/seed/`、認証設定（Site URL / Redirect URLs）= `supabase config push`（手順書に記載）。
- staging が無い間、L1〜L3 の行は **BLOCKED（理由: staging 未整備）** として正本に残す。ローカルで緑にして PASS と書かない。
- 用意手順: `docs/staging-setup.md`。
