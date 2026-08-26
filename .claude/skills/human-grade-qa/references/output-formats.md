# Output Formats — 3 形式で出力する

QA 結果は **AI が機械処理する形式** と **人間が読む形式** の両方で出す。
1 つの正本（state.json）から md と html を派生させる。

## ファイル全体像

```
.qa/
├── plans/<plan-id>/
│   ├── test-plan.md              # 人間用マスター計画（承認用）
│   ├── plan.json                 # 機械用：TC 一覧と前提（state の初期値）
│   ├── research.md               # 調査ノート
│   └── feature-specs/
│       ├── F-01-auth.md
│       └── ...
├── runs/<run-id>/
│   ├── state.json                # ★ 唯一の正本（実行進捗 / 各 TC の PASS/FAIL）
│   ├── overview.md               # 人間用サマリ
│   ├── features/
│   │   └── F-01-auth.md          # 人間用詳細ログ
│   ├── failures.md               # 失敗の再現手順集
│   ├── screenshots/...
│   └── artifacts/...
└── reports/<report-id>/
    ├── final.md                  # 人間用最終レポート（PR / Slack に貼る）
    ├── final.html                # ★ 人間用：ブラウザで見るダッシュボード
    └── final.json                # ★ 機械用：CI / 別ツールから読む集計
```

## state.json — 機械可読の正本

これが **「テスト済みかどうかの単一の真実」**。実行中も常に最新化する。
SKILL/他スキル/CI/別エージェントはこれだけ読めば現状が分かる。

```json
{
  "schema_version": "1.0",
  "run_id": "2026-06-03-1130-full",
  "project": "moon-shot",
  "mode": "full",
  "started_at": "2026-06-03T11:30:00+09:00",
  "ended_at": null,
  "status": "in_progress",
  "totals": { "planned": 31, "executed": 18, "pass": 16, "fail": 1, "skip": 1 },
  "features": [
    {
      "id": "F-01",
      "name": "認証",
      "status": "passed",
      "totals": { "planned": 12, "pass": 12, "fail": 0, "skip": 0 },
      "cases": [
        {
          "id": "TC-F01-01",
          "title": "正常ログイン",
          "category": "正常",
          "severity": "P0",
          "status": "passed",
          "started_at": "2026-06-03T11:31:02+09:00",
          "ended_at": "2026-06-03T11:31:18+09:00",
          "duration_ms": 16000,
          "evidence": {
            "screenshots": ["screenshots/F-01/TC-F01-01-03-after-submit.jpg"],
            "network": "artifacts/F-01/TC-F01-01.har",
            "db_checks": ["select count(*) ... => 1"],
            "console": "artifacts/F-01/TC-F01-01-console.txt"
          },
          "failure": null,
          "human_verified": false,
          "notes": ""
        },
        {
          "id": "TC-F01-07",
          "title": "セッション切れ後の API 呼び出し",
          "status": "failed",
          "severity": "P1",
          "failure": {
            "summary": "401 期待が 500 で白画面",
            "repro_steps": [
              "ログイン",
              "DevTools で session cookie 削除",
              "保存ボタン押下"
            ],
            "expected": "401 → /login にリダイレクト",
            "actual": "500、空白画面",
            "hypothesis": "src/api/foo.ts:42 で 401 を catch していない",
            "workaround": "リロードでログイン画面に戻る",
            "screenshots": ["screenshots/F-01/TC-F01-07-fail.jpg"]
          }
        }
      ]
    }
  ],
  "human_handoffs": [
    { "id": "H-01", "title": "実 iPhone Touch ID", "status": "pending", "requested_at": null }
  ],
  "assumptions": [
    { "id": "A-01", "text": "Next.js 15 cookies() の await 漏れ無し", "verified": false }
  ]
}
```

ステータス語彙（固定）:
- TC: `planned` / `running` / `passed` / `failed` / `skipped` / `blocked` / `flaky`
- run 全体: `draft` / `approved` / `in_progress` / `paused` / `completed` / `aborted`

### 証拠必須ルール（捏造PASS防止・最重要）

- `status="passed"` の TC は **`evidence` に実体が必須**: `screenshots`（1 件以上）/ `db_checks`（1 件以上）/
  `network`（非空）のいずれか。 `templates/state.schema.json` が `if status=passed then evidence`
  を強制するため、証拠ゼロの passed は **スキーマ違反**。
- `status="failed"` の TC は `failure` オブジェクト必須（症状・再現・仮説）。
- 証拠ゼロの passed＝**未証明PASS**。 `scripts/audit_evidence.sh` が検出し、
  `render_report.sh` は 1 件でもあれば判定を **BLOCK（信頼不可）** に落とし、`final.json` の
  `unproven_passes[]` と `final.html` の警告バナーに列挙する。
- 「コードを読んで動くはず」で passed にするのは捏造。 実行して証拠を残せないなら `planned` のまま。

## plan.json — 計画段階の機械可読

state.json と同じスキーマだが `status="draft"` で TC は全部 `planned`。
ユーザ承認で `approved` に遷移し、`runs/<run-id>/state.json` にコピーして実行開始。

## 実行中の更新規則

- 1 TC 完了ごとに state.json を **アトミックに** 書き換える（tmp → rename）
- 同時に `features/<feature>.md` を追記
- ホットリロード用に `state.json` の `mtime` だけ見れば変化検出できる

## final.json — 完了時の集計

run 終了時 / レポート発行時に派生:

```json
{
  "schema_version": "1.0",
  "report_id": "2026-06-03-final",
  "run_id": "2026-06-03-1130-full",
  "verdict": "warning",
  "totals": { "planned": 31, "pass": 28, "fail": 2, "skip": 1 },
  "blockers": ["TC-F02-04"],
  "coverage": {
    "正常": { "planned": 8, "pass": 8 },
    "異常": { "planned": 6, "pass": 5, "fail": 1 },
    "バリデーション": { "planned": 9, "pass": 9 },
    "境界": { "planned": 4, "pass": 3, "skip": 1 },
    "権限": { "planned": 3, "pass": 3 },
    "復帰": { "planned": 1, "pass": 0, "fail": 1 }
  },
  "human_handoffs_pending": 1
}
```

`final.json` には `unproven_passes[]`（証拠なき passed の一覧）も含まれる。 非空なら
`verdict` は必ず `block`（信頼不可）。

verdict: `pass` / `warning` / `block`

## final.html — 人間用ダッシュボード

ブラウザで開いて読む単一ファイル HTML。依存ゼロ（fetch しない）。
**state.json / final.json を `<script type="application/json">` で埋め込む** ので、HTML 1 枚で全部見える。

最低限のレイアウト:

- ヘッダ: project / run_id / mode / verdict バッジ（緑/黄/赤）
- サマリブロック: 大数字で PASS / FAIL / SKIP
- カバレッジマトリクス: 機能 × カテゴリの表（セル = PASS 数 / 計画数、色分け）
- 機能アコーディオン: 機能ごと TC 一覧、行クリックで再現手順 + スクショ展開
- 失敗ハイライトセクション: 重要度順に並ぶ
- ヒト依頼セクション: pending を上に
- フィルタ: 「FAIL だけ」「P0 だけ」「特定機能」

雛形は `templates/final.html.tpl`（後述）。スクショは `<img src="../screenshots/...">` で相対参照。

## 「テスト済み確認」のクエリパス

ユーザ「F-02 のバリデーションは全部終わってる？」→ AI:

```bash
jq '.features[] | select(.id=="F-02") | .cases[] | select(.category=="バリデーション") | {id, status}' \
  .qa/runs/<run-id>/state.json
```

ユーザ「失敗してるやつだけ見せて」→ HTML を開く、または:

```bash
jq '.features[].cases[] | select(.status=="failed")' .qa/runs/<run-id>/state.json
```

これで **どこまで終わって何が落ちているか** が機械でも人間でも常に分かる。

## CI / 他スキルからの読み取り

- 終了コード判定: `final.json#verdict == "pass"` を CI gate に
- 別スキル（実装 fix → 再 QA）は `failures.md` を読まずに `state.json` を読む
- Slack / PR コメントには `final.md` の冒頭 5 行 + `final.html` リンク

## 不変条件

- state.json と md/html は **state.json が正本**。md/html は派生。手で md/html を書き換えない
- 再実行（resume）するときは state.json の `planned` / `failed` だけ拾って続行
- スキーマ変更時は `schema_version` を上げる
