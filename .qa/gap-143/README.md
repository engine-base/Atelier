# GAP-143: デザインノート (DESIGN.md 相当) + ワンダへのペルソナ/スキル自動注入 + 好みの自動蓄積

## 何が欠けていたか (経営者指摘)

- 「DESIGN.md は design-md というスキルとか、ナレッジとして好み・傾向を把握する感じにしているはずだけど違うのか？」
- 「誰にどのスキルをどの時に読ませるかを自動的にさせる必要もあるね。スキルは格納しているでしょ？？」

実態: スキル格納 (skills テーブル) と AI 社員ごとの装着スキル注入 (_load_persona_and_skills)
は**チャットのみ**に配線されており、ワンダのモック生成/改訂 (generate.py / revise.py) は
素の system prompt で動いていた。Open Design の DESIGN.md に相当する
「プロジェクト常設のデザイン決定 + 使うほど蓄積される好み」も存在しなかった。

## 実装 (どこで動くか / 誰の費用か)

すべて **SaaS クラウド側 (FastAPI on Fly.io)** の配線。LLM 実行は llm_chain 経由で
**relay = 指示した本人の PC の Bridge = 本人の Claude サブスク** が最優先 (追加費用なし)。

1. **デザインノート** (`apps/api/src/services/mocks/design_note.py` 新規)
   - `projects.settings.design_note` (jsonb — 追加マイグレーション不要) に最大 2000 字
   - GET/PUT `/projects/{project_id}/design-note` (RLS 可視のみ、audit log 付き)
   - S-H01 モック一覧に「デザインノート」エディタ (MockListContainer)
2. **全生成・改訂への自動注入** (`build_design_context`)
   - ノート →「# このプロジェクトのデザインノート (必ず従うこと)」ブロック
   - workspace の design 部門 AI 社員 (= ワンダ) のペルソナ + 装着スキル SKILL.md を
     チャットと同一機構 (_load_persona_and_skills) で system prompt に前置
   - generate.py / revise.py の両方に配線 → 「誰に (design 部門社員)・いつ (全生成/改訂)・
     どのスキルを読ませるか」が自動化された
3. **好みの自動蓄積** (`apply_design_note_learning` + fire-and-forget scheduler)
   - 生成/改訂の指示から恒久的な決定 (色/フォント/余白/トーン等) だけを LLM が既存
     ノートへ統合。一時的な指示 (誤字修正等) は追記しない
   - 失敗・空・過大・変化なしは保存しない (ノートを壊さない)。応答はブロックしない

## 実バグ修正 (このゲートで発見)

1. **学習ジョブが 1 件も走らない**: `llm_complete(actor_id="system")` としていたため、
   relay 経路の `chat_relay_jobs.requested_by` (uuid not null) への cast が落ちて
   ジョブ自体が enqueue されず、silent fail していた。学習の actor を指示した本人に
   変更 (本人の Bridge / 本人のサブスクで実行 — 費用モデルとも整合)。
2. **relay off モードの間欠 exit=1**: `--max-turns 1` でもモデルが自発的に Read 等の
   ツールを呼ぶと stop_reason=tool_use で is_error になり claude が exit 1 していた
   (再現ログ取得済)。off モードの CLI 引数に `--tools ''` を追加して全ツールを無効化。
3. **Bridge 子プロセスへの CLAUDE_\* 漏れ**: sanitizedChildEnv が `CLAUDECODE` /
   `CLAUDE_*` を落としていなかった (親が Claude Code セッション内のとき子の挙動が
   変わり得る)。prefix ごと drop に拡張。

## E2E 証跡 (実 Bridge + 実 claude + relay)

- `e2e-design-note.txt`: ノート (紺 #1e3a5f / #f59e0b) を保存 → **実生成が実際に紺を採用**
  (USES_NAVY/USES_ACCENT True, PROVIDER relay)。改訂も V2_USES_SERIF + V2_KEEPS_NAVY True。
  前半の 502 は上記バグ 2 の再現記録 (修正前)。
- `e2e-learning.txt`: 修正後の本命。改訂指示「見出しは Noto Serif JP」→ 201 (16s, v4,
  provider=relay) → fire-and-forget 学習ジョブが本人の Bridge で完走し、ノートに
  「- 見出しフォントは Noto Serif JP を使用」が**自動追記** (LEARNED_FONT_RULE: True)。
  一時的でない決定だけが 1 行増え、既存 3 行は保持。
- `relay-jobs.txt`: chat_relay_jobs の実行証跡 — 改訂ジョブ (system_prompt 先頭が
  デザインノート注入ブロック) と学習ジョブ (updater prompt) が requested_by=本人 uuid で
  ともに done。

## テスト

- API: tests/routes/test_mock_generate.py (design-note CRUD/注入/学習/変化なしスキップ) 含む
  61 passed (test_mocks / test_mock_generate / test_mocks_content_url / test_chat_artifacts /
  test_tasks)。ruff / pyright 0 error。
- Bridge: 115 passed (--tools '' と CLAUDE_* sanitize の回帰テスト含む)。
- Web: uc13 22 passed (デザインノートエディタ含む)。
