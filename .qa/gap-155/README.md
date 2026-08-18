# GAP-155: 同時編集ガード + 差分ビュー + 復元 — 「誰がどう変えたかわかって戻せる」

経営者すり合わせの決定:
- 「デザインは複数人同時だと怖くないか」
- 「ブランチはちょっとな。誰がどう変えたかわかって戻せたらいいレベル。モック以外もね」

## 発見した実バグ (DB 実確認)

`mocks` に (project, 画面, version) の一意制約が**無かった**。2 人が同時に改訂すると
「v4 が 2 つ」できる余地があり、後勝ちが先勝ちの変更を含まない lost update が
黙って起きうる状態だった。`workflow_outputs` も同様。

## 実装 (どこで動くか: すべて SaaS クラウド側 — API + DB。費用は運営のインフラ費のみ、LLM 不使用)

1. **一意制約** `supabase/migrations/gap-155_version_guard.sql`
   - `mocks (project_id, screen_name, version) where deleted_at is null`
   - `workflow_outputs (project_id, stage, coalesce(meta->>'file_name',''), version) where deleted_at is null`
   - 既存重複は version を +1 で退避してから制約 (データは消さない)
2. **人間の改訂の衝突 = 409 で誠実に** (黙って積み直さない)
   - mocks: `create_version` / `duplicate` / `revise` → `MockVersionConflict` → 409
   - outputs: `insert_version` (revise / fix-proposal 承認 / restore) → `OutputVersionConflict` → 409
   - Web は SSE error / 409 detail のサーバ文言をそのまま表示
3. **Bridge 取り込みはリトライで吸収** (新規ファイル由来 — lost update の意味論が無い)
   - `ingest_html_artifact` / `ingest_html_output` / `ingest_file_artifact`: savepoint +
     IntegrityError → version 採り直し 3 回
4. **差分 (サーバ計算 unified diff — 実 HTML 2 版から difflib)**
   - `GET /mocks/{id}/diff/{other_id}` / `GET /outputs/{id}/diff/{other_id}`
   - 別チェーン 409 / バイナリ (filedb) 409 (テキスト化偽装しない) / RLS 不可視 404
   - スタジオ: バージョン履歴の各旧版に「差分」→ 色分けモーダル (+n/−n 行)
   - S-G01: 「前版との差分」ボタン → 同モーダル (共有 UI `components/VersionDiff.tsx`)
5. **復元 (履歴は消さない)**
   - `POST /outputs/{id}/restore`: 旧版の本文を新版として積む (meta: author=restore,
     restored_from_version)。最新版の復元は 409。モックは既存の「複製」が同機能。
   - S-G01: 旧版表示中のみ「この版を復元」
6. **付随是正 (同じ配線の穴)**: mockdb:// 成果物の anchors / revise / fix-proposal が
   storage 署名直行で 503 になっていた → mockdb 対応ローダーに統一し、mockdb 由来の
   改訂は mockdb へ保存 (GAP-138 の mocks revise と同型)

## 証拠

- `e2e-api-evidence.txt` — 実 DB の一意 index / **並列 curl 2 本の実レース (201 vs 409)** /
  料金ページ v3→v4 の実差分 (GAP-147 で実際に入ったフォント変更が見える) /
  御見積書 v1→v2 差分 + v1 復元 (201, v3) + 最新版復元 409 / anchors 200
- `gap155-diff-modal.png` — スタジオの差分モーダル (v3→v4, +6/−0, 緑=追加行)
- `gap155-output-diff.png` — S-G01 の差分モーダル (v1→v2, 赤=削除/緑=追加)
- `gap155-output-restore-btn.png` — 旧版 v1 表示中の「この版を復元」
- `shot-gap155.mjs` / `shot-gap155-outputs.mjs` — 撮影スクリプト (Playwright, 実ブラウザ)

## テスト (すべて実 Postgres)

- `tests/routes/test_mocks.py::TestGap155VersionGuard` (4)
  - **本物の 2 セッション同時 create_version → 後着が MockVersionConflict**
  - **本物の 2 セッション同時 ingest → 後着はリトライで v2 取得 (エラーにしない)**
  - diff 実コンテンツ検証 + 別チェーン 409 + RLS 404 / route 409 マッピング
- `tests/routes/test_outputs.py::TestGap155OutputsDiffRestore` (3)
  - diff→restore→identical 往復 / 最新版復元 409 / バイナリ diff 409 / 本文なし復元 409 /
    mockdb anchors 200 (是正の regression)
- web: `uc13` +3 (差分モーダル / 409 誠実表示 / revise conflict のサーバ文言),
  `uc12` +3 (前版との差分 / 復元→遷移 / 復元 409)
- 実行: API 47 passed (mocks/outputs/mock_generate/chat_artifacts/flow),
  web uc12+uc13 44 passed, ruff / pyright / tsc / next lint クリーン
