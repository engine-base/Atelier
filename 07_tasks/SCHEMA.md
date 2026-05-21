# Atelier タスク分解 スキーマ仕様 v1.0

作成日：2026-05-19 ／ オーナー：高本まさと

## 1. 目的

工程 6（モック）までで確定した全成果物（要件・アーキ・デザイン・機能分解・モック）を、
**1〜2 日粒度の実装タスク** に分解する。各タスクは AI 社員（ソー / ヴィジョン / 他）が
ローカル Claude Code（Bridge 経由）で自走できる粒度・情報量を保証する。

## 2. タスク 1 件のスキーマ

```jsonc
{
  // ========== 識別 ==========
  "id": "T-014",                              // T-NNN 連番
  "title": "ログイン画面（S-A01）の実装",      // 業務語・日本語
  "description": "...",                       // 何をするかの 1-3 行説明

  // ========== 分類 ==========
  "category": "auth",                         // entities.json / features.json と整合
  "type": "screen",                           // foundation / screen / feature / verification / infrastructure / migration
  "phase": 2,                                 // 1-9 (本ロードマップの段階)
  "priority": "high",                         // critical / high / medium / low
  "estimated_hours": 14,                      // 1-24 整数

  // ========== 担当 ==========
  "assigned_employee_id": "thor",             // jarvis / tony / natasha / steve / peter / strange / wanda / thor / vision / tchalla
  "lifecycle_stage": "triage",                // Hermes 6 列: triage / ready / in_progress / blocked / awaiting / done

  // ========== 紐付け（仕様徹底の核） ==========
  "links": {
    "screen_id": "S-A01",                     // null 可
    "mock_path": "06_mockups/auth/S-A01-signin.html",
    "feature_ids": ["F-001", "F-LEGAL-004"],
    "entity_ids": ["E-001", "E-025"],
    "spec_html_path": "07_tasks/specs/T-014-spec.html",
    "ac_html_path": "07_tasks/acceptance-criteria/T-014.html",
    "adr_refs": ["ADR-001", "ADR-018"]
  },

  // ========== 依存関係 ==========
  "dependencies": ["T-001", "T-010"],         // 完了が必要
  "prerequisites": ["T-001", "T-010"],        // 同上（明示）
  "blocks": ["T-020", "T-026"],               // このタスクが完了しないと開始できない後続

  // ========== ファイル予測（衝突回避用） ==========
  "files_changed_predicted": [
    "apps/web/src/app/(public)/signin/page.tsx",
    "apps/web/src/modules/auth/sign-in-form.tsx"
  ],

  // ========== 受入条件（3 段階） ==========
  "acceptance_criteria_summary": {
    "tier1_structural": 3,                    // 構造（画面・要素の存在）
    "tier2_functional": 4,                    // 機能（想定どおり動くか）
    "tier3_regression": 5,                    // 再発防止（既存機能の維持）
    "total": 12
  },

  // ========== 検証ループ（F-J02） ==========
  "verification": {
    "auto_approve_threshold": 0.95,           // スコア 0.95 以上で自動承認
    "human_approval_threshold": 0.80,         // 0.80-0.94 で人間判断
    "max_retries": 3
  },

  // ========== 起源・系譜 ==========
  "origin_type": "initial_decomposition",     // initial_decomposition / refactor / scope_change_auto / manual_added
  "parent_task_id": null,
  "created_at": "2026-05-19T00:00:00+09:00",
  "auto_advance_allowed": true
}
```

## 3. 仕様徹底（Coverage）の検証ルール

```
✅ 全 40 機能（features.json）の各 ID が、最低 1 タスクの feature_ids[] に含まれる
✅ 全 33 画面（screens.json）の各 ID が、screen 型タスクの screen_id に含まれる
✅ 全 25 エンティティ（entities.json）の各 ID が、最低 1 タスクの entity_ids[] に含まれる
   - うち主要テーブルは「migration / RLS / API」の 3 種すべてでカバー
✅ 全 18 ADR が、最低 1 タスクの adr_refs[] に含まれる
✅ 全 9 工程（phase 1-9）にタスクが存在する
✅ 全タスクの dependencies / prerequisites / blocks が実在する task_id を参照
✅ 依存グラフに循環がない（NetworkX で topological_sort 可能）
```

## 4. AI 社員と担当タスク種別

| ID | AI 社員 | 担当 |
|---|---|---|
| `jarvis` | ジャービス（COO） | 工程承認・3 択判断統括 |
| `tony` | トニー（CTO） | アーキ設計・基盤系タスク |
| `natasha` | ナターシャ（要件部長） | 要件タスク・F-CUC01 |
| `steve` | スティーブ（戦略・コミュ部長） | 議事録・提案・コメント返信 |
| `peter` | ピーター（タスク部長） | task-decomposition 実行 |
| `strange` | ストレンジ（DB 部長） | DB スキーマ・RLS・migration |
| `wanda` | ワンダ（デザイン部長） | デザイン・モック・UI 実装 |
| `thor` | ソー（実装部長） | 画面実装・API 実装 |
| `vision` | ヴィジョン（検証部長） | F-J02 検証・テスト |
| `tchalla` | ティチャラ（ナレッジ部長） | ナレッジ整理・横断抽出・納品 |

## 5. type（タスク種別）の分類

| type | 内容 | 平均見積 |
|---|---|---|
| `infrastructure` | CI/CD・ホスティング・観測 | 4-8h |
| `foundation` | 共通基盤・LLMClient 抽象化・design system 統合 | 6-12h |
| `migration` | DB スキーマ作成・マイグレーション | 4-8h |
| `screen` | 画面（モック S-XXX）の実装 | 8-16h |
| `feature` | 純粋なバックエンド機能（F-XXX）の実装 | 6-14h |
| `verification` | 検証ロジック・自動テスト基盤 | 4-10h |

## 6. ファイル構成

```
07_tasks/
├── SCHEMA.md                              ← この文書
├── tasks.json                             ← 全タスクの正本
├── tasks-summary.html                     ← 人間可読の一覧
├── coverage-matrix.html                   ← カバレッジ徹底レポート
├── dependency-graph.html                  ← 依存関係可視化
├── decision_log.json                      ← 分解時の判断記録
├── task-decomposition-report.md           ← 全体サマリ
├── specs/                                 ← 各タスク用 spec HTML
│   ├── T-001-spec.html
│   └── ...
└── acceptance-criteria/                   ← 各タスクの 3-tier AC HTML
    ├── T-001.html
    └── ...
```


## v3.1-dual: 二軸時間表示の必須フィールド（2026-05-20 追加）

全 task object に以下のフィールドを必須化：

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `estimate_hours_human` | number | ✓ | 人間 1 人逐次の参考工数（h） |
| `estimate_hours_ai` | number | ✓ | Claude+Bridge 単体の compute 時間（h） |
| `wall_clock_h_ai` | number | ✓ | AI compute + human_review の合計 wall-clock（h） |
| `ai_acceleration_factor` | number | ✓ | 短縮率（category別: infra 15× / db,backend 12× / frontend,test 10× / 致命級 4-5×） |
| `human_review_h` | number | ✓ | 経営者/AI社員 vision の review 時間（h） |
| `estimate_method` | enum | ✓ | `category-multiplier` / `research-based` / `expert` / `reference` |
| `estimate_confidence` | enum | ✓ | `high` / `medium` / `low` |

集計フィールド（`summary`）にも以下を必須化：
- `total_estimate_hours_human`
- `total_estimate_hours_ai_compute`
- `total_wall_clock_h_ai_parallel`
- `human_review_total_h`
- `ai_acceleration_factor_overall`
- `calendar_days_ai` / `calendar_days_human`
- `wave_wall_clock_h_ai`（Wave 別 wall-clock 内訳）

### Validator 動作
- 片方のフィールドのみ → `axis_missing` で reject
- 短縮率 < 1.0 or > 30 → `unrealistic_factor` 警告
- 致命級タスクで `human_review_h = 0` → `review_h_missing` 警告
