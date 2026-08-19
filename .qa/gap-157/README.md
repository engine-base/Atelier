# GAP-157: フェーズ切替をヘッダーへ集約 (全体切替) + 前フェーズ文脈の AI 注入

経営者フィードバック (2026-08-19):
「フェーズはヘッダーとかで画面切り替えるくらいでもいい。各タブの細々なところで
やるというよりも全体で切り替える感じ。しかも切り替えてもちゃんと他の前フェーズ
とかも把握してちゃんと依存とかもタスク分解も徹底できる状態で」

GAP-152 ではフェーズ選択と「確定」ボタンを進行タブの中 (FlowRail) に置いていた。
これを廃し、**ヘッダーの 1 か所** に集約した。

## 実装 (どこで動くか: SaaS クラウド側の UI + API。追加費用ゼロ)

- **ヘッダーのフェーズピル** (`components/layout/PhaseSwitcher.tsx`): プロジェクト
  文脈のとき常設。クリックで全フェーズ一覧 (件数つき) + 「確定して次フェーズへ」。
  凍結は赤枠の明示確認つき (GAP-152 の hard gate をここへ移設)。
- **全タブが追従** (`lib/currentPhase.ts`): 選択は localStorage
  `atelier_phase_sel_{projectId}` + `atelier-phase-changed` イベントで共有。
  進行 (FlowRail) / モック / タスクが同じ選択を見る。確定済みフェーズを選ぶと
  3 タブとも**そのフェーズのスナップショット (読み取り専用)** になる。
- **前フェーズ文脈の AI 注入** (`services/flow/phases.py: phase_history_block`):
  チャットの system prompt に、確定済みフェーズの「完了工程 / 成果物 (版・種類) /
  画面モック」と「これらは凍結済み。追加・変更は現在フェーズの作業。新しい
  タスク・依存は上記の確定内容を前提に分解すること」を毎回注入。
  → **フェーズを切り替えても AI が前フェーズを把握したまま依存・タスク分解できる**。

## 証拠 (実ブラウザ e2e / 実 API)

- `157-header-pill.png` — ヘッダーにフェーズピル (表示中: フェーズ2)
- `157-menu.png` — フェーズ一覧 (フェーズ1 ✓確定済み 成果物4·モック10 /
  フェーズ2 進行中 成果物3·モック1) + 確定メニュー
- `157-freeze-confirm.png` — 「確定すると成果物が凍結され、以後の追加・変更は
  次フェーズの作業になります」の赤枠確認 (この e2e では「やめる」で戻した)
- `157-snapshot-flow.png` / `157-snapshot-mocks.png` / `157-snapshot-tasks.png` —
  フェーズ1 を選択 → 進行・モック・タスクの 3 タブが同時にスナップショット表示
  (モックは「フェーズ1 ✓確定 のスナップショットを表示中」バッジ)
- `157-back-to-active.png` — フェーズ2 に戻すと全タブが現在フェーズへ復帰
- `curl-evidence.txt` — context-preview の system_prompt に
  「# 確定済みフェーズの内容 (凍結スナップショット — 依存・追加タスク分解の前提)」
  として実データ (お見積書(v3, estimate) / 料金ページ(v4) 等) が入っている実測

e2e スクリプト出力 (実測値):

```
PILL: フェーズ2
MENU: ["フェーズ1✓確定済み成果物4 · モック10 · タスク0","フェーズ2進行中成果物3 · モック1 · タスク0"]
PILL_AFTER: フェーズ1 ✓確定 (閲覧中)
FLOW_HAS_FROZEN_BANNER: true
MOCKS_SNAPSHOT_BADGE: 1
TASKS_PILL: フェーズ1 ✓確定 (閲覧中)
PILL_RESTORED: フェーズ2
```

## 自動テスト

- API: `tests/routes/test_flow.py` — phase_history_block が確定済みフェーズの
  工程・成果物 (版/種類) を含み、「現在フェーズの作業として扱い」の指示を出すこと
- Web: `tests/bundle-h/phase-switcher.test.tsx` (2) /
  `tests/bundle-h/flow-rail.test.tsx` (8, ヘッダー選択追従へ書き換え)
