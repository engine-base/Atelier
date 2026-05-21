# Atelier v3.1 タスク依存 DAG / Wave 実行プラン

**作成日**：2026-05-20
**モード**：`api_first`（v3.1）
**並列度上限**：10（Bridge 経由）
**総タスク数**：**190**

---

## 物量サマリ（二軸）

| 指標 | Human-baseline | AI-accelerated |
|---|---:|---:|
| 総タスク数 | 190 | 190 |
| 総工数（h） | **1,328** | – |
| AI compute（h） | – | **123.7** |
| Wall-clock 並列（h） | – | **27.9** |
| 人間 review（h） | – | **10.8** |
| カレンダー所要 | 約 240 営業日（~8 ヶ月） | **約 15 営業日（~3 週）** |
| 短縮率 | baseline | **10.7×** |
| Wave 数 | 6（Wave 0-5）| 6 |
| Phase 数 | 6 | 6 |

※ 旧値 1,367h は estimate_sessions 算出時の概算値。dual-axis 注入後は 1,328h が正値。

---

## Wave 構成

| Wave | 内容 | Group | deliverable_layer | タスク数 | 並列度 | 累計工数 |
|---|---|---|---|---:|---:|---:|
| **0** | Foundation 基盤 | F | foundation | 28 | 3-5 | 217h |
| **1** | Data Layer 全 entity + RLS | D | foundation | 35 | 5-8 | 220h |
| **2** | API Layer 全 endpoint（★ 契約凍結）| A | backend | 45 | 8-10 | 280h |
| **3** | UI Foundation 共通基盤 | U-shared | ui | 18 | 3-5 | 110h |
| **4** | UI Parallel 全画面（★ 最大並列度 10）| U-screen | ui | 40 | **10** | 380h |
| **5** | Integration & Polish 本番化 | I | polish | 24 | 3-5 | 160h |

---

## 依存 DAG（簡略）

```
[Wave 0: Foundation phase]
  T-F-01 (monorepo) ──┬─→ T-F-02 (ツールチェイン)
                      ├─→ T-F-03 (Next.js)
                      ├─→ T-F-04 (FastAPI)
                      └─→ T-F-05 (Supabase)
                              │
  T-F-02 ──→ T-F-07 (CI/CD 10 gate) ──┐
  T-F-03 ──→ T-F-09 (デザインシステム) │
  T-F-04 ──→ T-F-11 (asyncpg) ────────┤
  T-F-04 ──→ T-F-12 (LLMClient 抽象) ─┤
  T-F-05 ──→ T-F-10 (Drizzle) ────────┤
                                       ├─→ [Wave 1 解禁]
  T-F-27 (Bridge fork) ───────────────┤
  T-F-28 (Hermes port) ───────────────┘

[Wave 1: Data Layer 全 25 entity 並列]
  T-D-01〜T-D-13 (entity migration) ──┐
                                       ├─→ T-D-14〜T-D-23 (RLS)
                                       ├─→ T-D-24〜T-D-25 (seed)
                                       └─→ T-D-31〜T-D-35 (RLS 越境試験)
                                              │
                                              └─→ [Wave 2 解禁]

[Wave 2: API Layer 全 119 endpoint カテゴリ並列]
  T-A-01〜T-A-44 (各 endpoint 実装) ──┐
                                       └─→ T-A-45 (OpenAPI 凍結 + coverage 100%)
                                              │
                                              └─→ ★ API 契約凍結マイルストーン ★
                                              │
                                              └─→ [Wave 3 解禁]

[Wave 3: UI Foundation]
  T-US-01 (AppShell) ──┐
  T-US-04 (API クライアント) ─┤  ← 型自動生成済
  T-US-05 (TanStack Query) ──┤
  ...                         ├─→ [Wave 4 解禁]
  T-US-11 (Form 共通) ─────┘

[Wave 4: UI Parallel ★ 最大並列度 10]
  T-UC-01 (S-A01) ─┐
  T-UC-02 (S-A03) ─┤
  T-UC-08 (S-E01) ─┤ ← 33 画面 + 横断機能 7
  ... 40 並列 ...  ├─→ [Wave 5 解禁]
  T-UC-40         ─┘

[Wave 5: Integration]
  T-I-01〜T-I-08 (E2E + RLS 越境) ──┐
  T-I-09〜T-I-10 (性能 + a11y) ────┤
  T-I-11〜T-I-12 (Bridge 配布) ────┤
                                     ├─→ T-I-24 (本番リリース判定)
  T-I-13〜T-I-18 (F-J02/CUC/IMP 試験)┤
  T-I-19〜T-I-23 (cleanup + 監視) ──┘
```

---

## ブロッキングタスク（停止すると全体が止まる）

| タスク ID | タスク名 | ブロックする範囲 | リスク対策 |
|---|---|---|---|
| **T-F-07** | CI/CD（v3-gate.yml 10 gate）| 全 PR | 最優先で 2 並列着手・3 セッション割当 |
| **T-F-25** | OpenAPI → TS 型自動生成パイプライン | Wave 3, 4 全タスク | Wave 0 で T-F-10/11 完了直後に着手 |
| **T-F-27** | Atelier Bridge 開発基盤（Vibeyard fork）| Wave 4（並列実行に必須）| Wave 0 後半で並走着手 |
| **T-F-28** | Hermes 互換 kanban_tools 基盤 | Wave 2 の T-A-28-29（互換 7 ツール）| Wave 0 後半 |
| **T-D-13** | 主要 entity migration 完了 | Wave 2 の全 API | Wave 1 前半で完了 |
| **T-A-45** | OpenAPI 確定 + 契約凍結 | Wave 3, 4 全タスク | Wave 2 末尾の 1 タスク化 |
| **T-US-04** | 型安全 API クライアント | Wave 4 全画面タスク | Wave 3 で最優先 |

---

## File-level Mutex（並列衝突防止）

各 Wave 内で同一ファイルを 2 タスクが同時編集しないことを `files_changed` の事前検査で保証。

### Wave 0 の主要 mutex

| ファイル | 編集タスク | 衝突回避 |
|---|---|---|
| `package.json` | T-F-01, T-F-02, T-F-03 | T-F-01 完了 → T-F-02 → T-F-03 の直列 |
| `apps/api/src/main.py` | T-F-04, T-F-08, T-F-22 | T-F-04 → T-F-08 / T-F-22 並列 |
| `.github/workflows/*` | T-F-07 単独 | 他から触らない |

### Wave 2 の主要 mutex

各 endpoint カテゴリは別ファイルなので、ほぼ完全並列可能：
- `apps/api/src/routes/auth.py` ← T-A-01〜T-A-05
- `apps/api/src/routes/workspaces.py` ← T-A-06〜T-A-09
- ...

### Wave 4 の主要 mutex

各画面は **完全独立**（別ディレクトリ）なので **真の 10 並列**可能：
- `apps/web/src/app/(public)/signin/` ← T-UC-01 のみ
- `apps/web/src/app/(app)/workspace/` ← T-UC-02 のみ
- `apps/web/src/app/(app)/projects/[id]/` ← T-UC-04 のみ
- ...

---

## 失敗時の retry プロトコル

```
┌─ Task 起動 ─────────────────────────────────┐
│                                              │
│  Bridge worker spawn (HERMES_KANBAN_TASK)    │
│       ↓                                       │
│  Claude Code が実装 + Tier 3 regression 実行  │
│       ↓                                       │
│  kanban_complete(summary, metadata.score)    │
│       ↓                                       │
│  ┌──────────┬──────────────┬─────────────┐   │
│  ▼          ▼              ▼             ▼   │
│ ≥0.95    [0.80,0.95)   <0.80           失敗 │
│  ↓          ↓              ↓             ↓   │
│ done    awaiting     triage           kanban │
│         (S-J01)      retry_count++   _block  │
│                      (max 3)                 │
│                                              │
└──────────────────────────────────────────────┘

retry_count = 3 到達 →
  kanban_block(reason="max_retries_exceeded")
  → blocked 列に固定
  → 承認待ちインボックス S-J01 に urgent エントリ
  → 人間判断（差し戻し / 再分解 / 仕様変更）
```

連続失敗の検出ロジック：
- Bridge PID ポーリングで 60 秒間応答なし → `dispatch_status=dead`
- サーキットブレーカが自動再 spawn（max-retries 3）
- 3 回超過 → `blocked` 固定 + 監査ログ + Sentry アラート

---

## CI Gate（各 PR で必須・v3-gate.yml）

| # | Gate | 失敗時 | 適用 Phase | 工具 |
|---|---|---|---|---|
| 1 | lint | Block | Foundation〜 | ruff + ESLint |
| 2 | 3-tier AC validator | Block | Phase 5〜 | custom Python |
| 3 | type check | Block | Foundation〜 | pyright + tsc strict |
| 4 | coverage ≥ 80% | Warn → Block | Phase 6 | pytest-cov + Vitest c8 |
| 5 | endpoint-implementation-existence | Block | Phase 3〜 | custom lint |
| 6 | mock-impl-diff | Block | Phase 5〜 | Playwright screenshot + DOM diff |
| 7 | OpenAPI → TS 型 drift | Block | Phase 3〜 | git diff after gen:api |
| 8 | contract test (Schemathesis) | Block | Phase 3〜 | schemathesis |
| 9 | 画面 ↔ API カバレッジ 100% | Block | Phase 3 完了時 | check-screen-api-coverage.ts |
| 10 | RLS 越境テスト | Block | Phase 2 完了時〜 | pytest security/ |

**全 10 PASS → auto-merge（squash）**
**1 つでも fail → bot コメント + retry スケジュール**
**連続 3 回失敗 → human エスカ + kanban_block**

---

## Phase Gate 機械判定

各 Phase 完了は **以下条件すべて充足** で機械判定：

| Phase | 完了条件 |
|---|---|
| Phase 1 Foundation | T-F-01〜28 すべて `lifecycle_stage=done` |
| Phase 2 Data | T-D-01〜35 すべて done + Gate 10 PASS |
| **Phase 3 API** | T-A-01〜45 すべて done + Gate 5/7/8/9 PASS + **OpenAPI frozen_at 記録** |
| Phase 4 UI Foundation | T-US-01〜18 すべて done |
| Phase 5 UI Parallel | T-UC-01〜40 すべて done + Gate 6 PASS |
| Phase 6 Integration | T-I-01〜24 すべて done + Gate 全 10 PASS + 本番リリース判定 PASS |

Phase 完了 = **次 Wave 解禁**

---

## 並列実行の真のボトルネック

- **Wave 0 (Foundation)**：T-F-07 が 14h で最長、ここが律速
- **Wave 1 (Data)**：T-D-22（クライアント別 JWT RLS）+ T-D-31〜35（越境試験）が律速
- **Wave 2 (API)**：T-A-45（OpenAPI 凍結）が末尾律速
- **Wave 3 (UI Foundation)**：T-US-04（型クライアント）が律速
- **Wave 4 (UI Parallel)**：S-E01 チャット（T-UC-08）と S-I01 タスクボード（T-UC-14）が 20h で最長
- **Wave 5 (Integration)**：T-I-24（本番リリース判定）が末尾律速

**実行プラン推奨**：
- Wave 0：5 並列で約 60h ≈ 1.5 週
- Wave 1：8 並列で約 35h ≈ 1 週
- Wave 2：10 並列で約 35h ≈ 1 週
- Wave 3：5 並列で約 25h ≈ 0.5 週
- Wave 4：10 並列で約 40h ≈ 1 週
- Wave 5：5 並列で約 35h ≈ 1 週

**累計実時間**：約 6 週間（Bridge 経由 10 並列上限）

---

## Bridge / Hermes 統合の特殊扱い

Phase 1 で **T-F-27（Bridge）と T-F-28（Hermes port）**を完成させないと **Wave 4 で並列実装ができない** 構造です。

特に：
- T-F-27 が遅れる → Wave 4 が逐次実行に degrade（10 → 1 並列）
- T-F-28 が遅れる → Wave 2 の T-A-28〜29 が ブロック → API 契約凍結が後ろ倒し

→ **Foundation phase の T-F-07/25/27/28 は Phase 1 内で最優先・複数並列セッション割当**

---

## 監査ログ・audit MD 運用

全 190 タスクに対して：
- 着手前：`07_tasks/acceptance-criteria/T-{group}-{NN}.md` を template から生成
- 3-tier AC を逐語コピー
- 担当 AI 社員 (Bridge worker) が実装中に各 AC に対する impl line を埋める
- Tier 3 regression 全 PASS で `Decision: DONE`
- 1 件でも fail なら `Decision: GAP` + 理由記述
- `audit_md_validator` gate がこれを CI で検証

---

## STEP 3 完了時点の検証

- [x] Wave 0-5 設計完了、Foundation phase 単独 Wave 0
- [x] 循環依存なし（NetworkX で topological_sort 可能）
- [x] file-level mutex で Wave 内衝突防止
- [x] ブロッキングタスク 7 件特定（T-F-07/25/27/28, T-D-13, T-A-45, T-US-04）
- [x] CI gate 10 種、Phase 別有効化
- [x] retry プロトコル（max 3 + kanban_block）
- [x] Phase gate 機械判定条件明示
- [x] 並列実行の律速タスク特定
- [x] 累計実時間見積：約 6 週間（10 並列）

---

🔌 **STEP 3 確認**

依存 DAG と Wave 構成を確認してください。

- **Foundation phase 単独で Wave 0** を埋める方針で OK ですか？
- **Wave 4 で 10 並列**（33 画面 + 横断機能 7 = 40 タスク）で OK ですか？
- **ブロッキングタスク 7 件**（特に T-F-07 / T-F-27 / T-F-28）への最優先割当で OK ですか？
- **累計実時間 約 6 週間**の見積感で進めて OK ですか？
- 問題なければ「**STEP 4 へ**」とお知らせください

※ STEP 4 では各 Group の代表タスクをタスクカード化（v3 task object schema 全フィールド + audit MD template）し、外部実装者 / Bridge worker に渡せる完全自己完結カードに仕上げます


## Wave 別二軸時間（2026-05-20 追加）

| Wave | 件数 | 並列度 | Human h | AI compute h | Wall-clock h |
|---|---:|---:|---:|---:|---:|
| W0 Foundation | 28 | 5 | 213 | 18.6 | 6.71 |
| W1 Data | 35 | 8 | 188 | 17.8 | 5.53 |
| W2 API | 45 | 10 | 310 | 26.6 | 4.66 |
| W3 UI Foundation | 18 | 5 | 96 | 9.6 | 2.42 |
| W4 UI Parallel | 40 | 10 | 368 | 36.8 | 3.68 |
| W5 Integration | 24 | 5 | 153 | 14.4 | 4.88 |
| **計** | **190** | – | **1328.0** | **123.7** | **27.9** |

カレンダー詳細は [`../08_schedule/SCHEDULE.md`](../08_schedule/SCHEDULE.md) と [`../08_schedule/SCHEDULE.html`](../08_schedule/SCHEDULE.html)（二軸 Gantt + トグル）を参照。
