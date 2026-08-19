# GAP-152: 段階的フェーズ — 確定=凍結・追加は次フェーズ・フェーズ切替

経営者すり合わせ (2026-08-18):
「スナップショットもだし、段階的にフェーズとして進める。成果物は確定的になれば
それ以上の追加はつけられない。追加は次フェーズ（フェーズ2以降）でやる。
プロジェクト内でも切り替えられたら。追加の見積もりを分けて考慮できるし、
開発も追加分の依存やタスクを分けて考えられる」

## 実装 (どこで動くか: すべて SaaS クラウド側 — API + DB。LLM 不使用で費用ゼロ)

- **delivery_phases 新設** (`gap-152_delivery_phases.sql`): 納品単位のフェーズ1..N。
  既存 `phases` テーブルは「工程 (hearing/要件定義…)」の意味で使用中のため別テーブル。
  active はプロジェクトにちょうど 1 つ (partial unique)。既存全プロジェクトに
  フェーズ1 を backfill し、既存のモック/成果物/タスク/フローを帰属させる。
- **確定 (freeze)** `POST /projects/{id}/delivery-phases/{phase_id}/freeze`:
  confirm 必須 (hard gate と同じ明示承認)。frozen 化と同時に次フェーズを active
  で作成し、**フロー (工程) の新しい 1 周を即時初期化** — project_flow_stages の
  一意キーを (project, phase, stage) に変更してフェーズごとに周回。
- **スナップショット (凍結)**: 新規行 (モック/成果物/タスク/取り込み/改訂新版/復元)
  は**常に active フェーズにスタンプ** — 確定フェーズには構造的に何も足せない。
  確定フェーズの行への破壊操作 (モックのメタ更新/削除/破棄) は 409
  「「フェーズ1」は確定済みのため変更できません」。改訂・復元は許可するが
  新版は次フェーズの追加作業として積まれる (見積の追加分の分離もこれで自動)。
- **切替**: `GET /flow?phase=` で過去フェーズの周回 (当時の完了状態) を閲覧。
  `GET /mocks|/outputs|/tasks?delivery_phase_id=` でフェーズ別に絞り込み。
- **UI (S-E01 進行)**: フェーズバー (フェーズ1 ✓確定 / フェーズ2) + 「フェーズを
  確定…」→ 赤の明示承認パネル (凍結件数の実数表示) → 確定通知。確定フェーズを
  選ぶと読み取り専用スナップショット (完了/スキップ/差し戻し/確定ボタン非表示 +
  凍結バナー)。モック一覧 (S-H01) にフェーズ絞り込みセレクト。
- **チャット注入**: flow_context_block が「現在は第 N フェーズ・過去フェーズは
  凍結・追加要望は現在フェーズとして扱う」を全社員の system prompt に注入。
  フェーズ2 以降の工程スレッドは「見積（フェーズ2）」のように周回を区別。

## 証拠 (実 e2e — 実データの e2e プロジェクトで UI から確定まで実行)

- `gap152-phase-bar.png` — 進行タブのフェーズバー (フェーズ1 のみ + 確定 CTA)
- `gap152-freeze-confirm.png` — 明示承認パネル「成果物（14 件）が凍結され…」(実数)
- `gap152-after-freeze.png` — 確定通知 + フェーズ1✓確定 / フェーズ2 バー
- `gap152-frozen-view.png` — フェーズ1 スナップショット (凍結バナー + 読み取り専用)
- `e2e-api-evidence.txt` — curl 実測: フェーズ一覧実数 (mocks10/outputs4/工程1/7) /
  凍結モック破棄 409 / 凍結モックの複製→新版がフェーズ2 に入る / フェーズ2 絞込 /
  二重確定 409
- `shot-gap152.mjs` — 撮影スクリプト (Playwright 実ブラウザ)

## テスト (実 Postgres)

- `tests/routes/test_flow.py` +2:
  - `test_gap152_phase_lifecycle_freeze_and_new_round` — 自動作成 / confirm 403 /
    確定→frozen+次フェーズ+新周回即初期化 / ?phase= で当時の状態閲覧 /
    操作は active 周回 / 二重確定 409 / 他プロジェクト 404
  - `test_gap152_stamping_filters_and_frozen_guard` — mocks/tasks/outputs の
    active スタンプ / 凍結ガード 409 (discard/patch/delete) / 新版・復元が
    次フェーズへ / 3 一覧のフェーズフィルタ / チャット文脈へのフェーズ注入
- web `flow-rail.test.tsx` +2: 確定の明示承認フロー / 凍結ビューの読み取り専用
- 回帰: flow/mocks/outputs/tasks/mock_generate/chat_artifacts/workflow 95 PASS
  (GAP-155 の一意制約がテストヘルパーの同一画面二重 seed を暴露 → 一意化で修正)、
  web flow-rail 9 + uc13 29 PASS、ruff / pyright / tsc / next lint クリーン
