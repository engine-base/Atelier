# T-UC-14 audit — S-I01 タスクボード（6 列 + 再生バー）UI 実装

## メタ
- task_id: T-UC-14
- group: U-screen (UI)
- phase: 5_ui_parallel / wave: 4
- assignee: wanda（デザイン）+ thor（実装）
- estimate_hours: 18
- branch: claude/T-UC-14
- legacy_task_id: なし（v3.1 で大幅再設計）

## 背景・目的

タスクボード S-I01 の Next.js 実装。Hermes 6 列モデル（準備中 / 着手可 / 実装中 / 要対応 / 承認待ち / 完了）でタスクをカンバン表示。**再生バー**から複数選択 → 一括 dispatch、**Bridge 接続状態**の常時表示。Atelier の中核 UI。

## 紐付け

- **screen_ids**: S-I01
- **feature_ids**: F-018, F-DISP01, F-BRIDGE01
- **entity_ids**: E-012 (tasks), E-013 (task_executions)
- **mock_path**: `06_mockups/task/S-I01-kanban.html`
- **spec_links**:
  - `06_mockups/task/S-I01-kanban.html` (構造 + 振る舞いの正本)
  - `07_api_design/openapi.yaml` (使用 API)
  - `07_api_design/screen-api-coverage.json#S-I01`
  - `04_functional_breakdown/screens.json#S-I01` (lifecycle_mapping)
- **使用 API**（screen-api-coverage.json から）:
  - GET `/projects/:id/tasks` — 6 列形式取得
  - GET `/projects/:id/bridge/status` — Bridge 接続状態
  - POST `/projects/:id/tasks` — タスク追加
  - POST `/tasks/:id/play` — 個別再生
  - POST `/tasks/bulk/play` — 一括再生
- **depends_on**:
  - T-US-01 (AppShell), T-US-02 (Navigation), T-US-04 (型安全 API クライアント)
  - T-US-05 (TanStack Query), T-US-07 (通知ベル・Realtime)
  - T-A-24 (タスク再生 API), T-A-25 (一括再生 API), T-A-30 (Bridge 状態 API)

## 実装仕様

### Input (URL params)
```
/projects/:projectId/tasks
?group_by=feature|screen|employee|phase (default: feature)
?view=kanban|list|graph (default: kanban)
```

### Components
- `<TaskBoardPage>` — ページ本体（Server Component で初期データ fetch）
- `<RoleCard>` — 役割カード（3 ポイント説明）
- `<PlayBar>` — 再生バー（選択件数 / 並列枠 / 大ボタン）
- `<Toolbar>` — 表示/分類切替
- `<Legend>` — 6 レーン色凡例
- `<KanbanGroup>` — カテゴリ別グループ
- `<KanbanLane>` — 6 レーン（triage/ready/in_progress/blocked/awaiting/done）
- `<TaskCard>` — タスクカード（hover で個別再生ボタン）
- `<RunningBar>` — 実装中アニメ（CSS animation）

### State
- Selected tasks: client state (`useState<Set<UUID>>`)
- Tasks data: TanStack Query (5s refetch + Realtime subscribe)
- Bridge status: TanStack Query (10s refetch)

### 主要振る舞い
1. カードクリックで選択トグル → 再生バーが件数・合計工数を更新
2. カード hover で「▶」個別再生ボタン表示
3. 「選択を再生」クリック → POST `/tasks/bulk/play` → 楽観更新 → toast
4. ドラッグ＆ドロップで Lane 間移動（v2 で実装、v1 は read-only）
5. Bridge 接続状態が offline なら再生ボタン disabled + Tooltip
6. 実装中タスクは走査アニメ + 進捗テキスト
7. 並列枠超過時は queue_position 表示

## Tier 1: Structural（mock-impl-diff gate で検証）

- [ ] **AC-S1**: STATE-DRIVEN: While S-I01 page is rendered, the system shall display 4 sections matching mock: role card / play bar / toolbar / kanban board.
- [ ] **AC-S2**: UBIQUITOUS: All headings and labels match mock exactly: 「タスクボード — AI 社員に作業を任せる場所」/「準備中」「着手可」「実装中」「要対応」「承認待ち」「完了」
- [ ] **AC-S3**: UBIQUITOUS: Lane colors match mock: triage=#94A3B8, ready=on-surface-variant, impl=primary, blocked=#DC2626, wait=secondary, done=tertiary.
- [ ] **AC-S4**: UBIQUITOUS: KPI in play bar matches mock: 選択件数 / 合計見積 / 並列実行枠ゲージ.
- [ ] **AC-S5**: UBIQUITOUS: `data-bf-screen-id="S-I01"` meta attribute exists on main element.
- [ ] **AC-S6**: STATE-DRIVEN: While viewport >= 1100px, lanes use 6-column grid; below 1100px, 2-column.

## Tier 2: Functional（EARS 形式）

- [ ] **AC-F1**: EVENT-DRIVEN: When user clicks a task card, the system shall toggle its selection and update play bar count + total estimate.
- [ ] **AC-F2**: EVENT-DRIVEN: When user clicks "選択を再生" button with N selected, the system shall call POST /tasks/bulk/play with N task_ids, show optimistic UI update, and toast success/error.
- [ ] **AC-F3**: EVENT-DRIVEN: When user hovers a task card in 着手可 lane, the system shall show individual play button.
- [ ] **AC-F4**: EVENT-DRIVEN: When user clicks individual play button, the system shall call POST /tasks/:id/play and show toast on success.
- [ ] **AC-F5**: STATE-DRIVEN: While Bridge status is offline, the system shall disable all play buttons and show tooltip "Atelier Bridge をローカルで起動してください".
- [ ] **AC-F6**: STATE-DRIVEN: While task is in_progress, the card shall display animated scanning bar + 進捗 (Xh / Yh).
- [ ] **AC-F7**: STATE-DRIVEN: While task is in blocked lane, the card shall display 赤ボーダー + 再試行回数 + 理由.
- [ ] **AC-F8**: EVENT-DRIVEN: When dispatcher returns 503 PARALLEL_LIMIT_REACHED with queue_position, the system shall display "並列枠満杯 · 順番待ち N 番目" badge on the task.
- [ ] **AC-F9**: EVENT-DRIVEN: When Realtime broadcasts task update (lifecycle_stage change), the system shall move the card to new lane within 1 second.
- [ ] **AC-F10**: UNWANTED: If user role is viewer, all play buttons shall be hidden.
- [ ] **AC-F11**: UNWANTED: If 1 つでも実装中タスクを選択しようとした場合, the system shall not allow selection (disabled visually).

## Tier 3: Regression

- [ ] **AC-R1**: Playwright E2E `apps/web/tests/e2e/tasks/kanban.spec.ts` PASS (>= 10 cases)
  - happy path: select → play → toast
  - individual play, bulk play, Bridge offline disabled
  - viewport responsive (1280 / 768 / 375)
  - lifecycle stage transitions visible
  - keyboard navigation (tab / enter / space)
- [ ] **AC-R2**: Vitest unit `apps/web/tests/unit/tasks/` PASS (>= 8 cases)
- [ ] **AC-R3**: tsc strict 0 errors
- [ ] **AC-R4**: ESLint PASS (no `any`, no unused imports)
- [ ] **AC-R5**: coverage >= 80% on `src/app/(app)/tasks/`, `src/modules/tasks/`
- [ ] **AC-R6**: **mock-impl-diff gate PASS**（Playwright screenshot vs mock HTML の DOM 構造一致）
- [ ] **AC-R7**: axe a11y check 0 violations (WCAG 2.2 AA)
- [ ] **AC-R8**: Lighthouse performance score >= 80 (CWV LCP/INP/CLS)
- [ ] **AC-R9**: audit_md_validator PASS
- [ ] **AC-R10**: type drift check PASS（types.ts と実装で型不一致なし）

## エラーケース

| ケース | 入力 | 期待動作 | 検証 |
|---|---|---|---|
| 認証切れ | 401 from API | Sign-in 画面へ redirect | AC-F1 |
| viewer role | role=viewer | play 群全 hidden | AC-F10 |
| Bridge offline | bridge.connected=false | play disabled + tooltip | AC-F5 |
| 並列枠満杯 | 503 PARALLEL_LIMIT_REACHED | queue badge 表示 | AC-F8 |
| 依存未完 | 409 DEPENDENCIES_NOT_MET | 警告 modal + 詳細 | エラー UI |
| ネットワークエラー | fetch failed | 再試行ボタン付き banner | -|

## ファイル変更予測

```
apps/web/src/app/(app)/projects/[id]/tasks/page.tsx       (new)
apps/web/src/modules/tasks/KanbanBoard.tsx                (new)
apps/web/src/modules/tasks/PlayBar.tsx                    (new)
apps/web/src/modules/tasks/TaskCard.tsx                   (new)
apps/web/src/modules/tasks/RunningBar.tsx                 (new)
apps/web/src/modules/tasks/use-tasks.ts                   (new, TanStack Query)
apps/web/src/modules/tasks/use-bridge-status.ts           (new)
apps/web/src/modules/tasks/use-bulk-play.ts               (new)
apps/web/src/modules/tasks/types.ts                       (new, re-export from api types)
apps/web/tests/e2e/tasks/kanban.spec.ts                   (new, 10+ E2E cases)
apps/web/tests/unit/tasks/TaskCard.test.tsx               (new, 5+ unit cases)
apps/web/tests/unit/tasks/use-tasks.test.ts               (new, 3+ unit cases)
```

## アクセスポリシー必須（フロント側のチェック・最終的には API/RLS で強制）

- `tasks:member_select`（一覧取得）
- `tasks:member_update`（再生・状態変更）

## リスクフラグ

- [x] **粒度大**: 18h → 2-3 セッション推奨（コンポーネント分割：基本構造 / 状態管理 / Realtime 統合）
- [x] **画面複雑度最高**: 動的状態が多い（選択・hover・Realtime push）
- [x] **mock-impl-diff gate 厳格**: モック S-I01-kanban.html と DOM 完全一致必須
- [x] **Realtime 依存**: Supabase Realtime subscription 必須

## 完了判定

- [ ] 全 Tier 1-3 AC PASS
- [ ] mock-impl-diff gate PASS（スクリーンショット比較）
- [ ] a11y axe 0 violations
- [ ] PR レビュー通過（ワンダ + ソー）

**Decision**: DONE | BLOCKED | GAP
