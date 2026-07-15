# 実DB検証 実行記録（human-grade-qa full / 2026-07-04）

## 実行環境（証拠）
- Docker Desktop 起動 → `supabase db start`（supabase_db_atelier **healthy**, 127.0.0.1:54322）
- migration は CLI 命名規則（`<timestamp>_name.sql`）不一致で skip されるため、**CI Gate #10 と同方式**で
  `ls supabase/migrations/*.sql | sort` の全 **34本を psql で手動適用 → 全成功**（public 25テーブル）
- 接続: `ATELIER_TEST_PG_URL=postgresql+asyncpg://supabase_admin:postgres@127.0.0.1:54322/postgres`
  （`postgres` ユーザだと supabase イメージで `auth.users` の owner でなく 18 ERROR → superuser で解消）

## 結果（実測・全 API テストスイート = 実 Postgres + RLS + JWT）
| 区分 | 件数 |
|---|---|
| **PASS** | **627** |
| FAIL | 27 |
| ERROR | 7 |

従来この 600+ 件の PG 統合/RLS テストは **ローカル/CI とも PG 不在で全 SKIP**（一度も実行されたことがない）。
今回が初の実走であり、以下の**実バグ/乖離**が初めて露見した。

## 検出した実バグ（クラス別・証拠 = 上記実走の DB エラー）
1. **migration 欠落（zero-state 型 / P0）**: `public.mcp_tokens`・`public.byok_api_keys` の **DDL がリポジトリに一切存在しない**。
   → MCP トークン・BYOK キー機能は fresh 環境にデプロイ不能（test_mcp_tokens ×6 / test_byok_keys ×6 / rls t-i-06,08 が該当）。
2. **RLS ↔ INSERT 乖離（systemic class / P1）**: `cron_schedules` への insert が
   `new row violates row-level security policy` （test_cron ×5）。RLS policy と service/fixture の書込前提が不一致。
3. **CHECK 制約 ↔ fixture 乖離（P1）**: `knowledge_nodes_scope_owner_consistency` 違反
   （test_knowledge_scope_tree ×7）。scope/owner の整合仕様とテストデータが乖離。
4. その他: rls t-i-05/07, t-d-36_vault, test_skills, test_chat_sse, test_auth 各1（多くは 1〜3 の波及）。

## 未実施のまま残るもの（正直な内訳）
- ブラウザ実操作（Chrome での 393 TC 実走）: **planned のまま**。web+API 同時起動と storage
  （`supabase start` の storage コンテナ unhealthy）が未解決のため。
- G3 実副作用（S-M01 の実 storage/Whisper）: storage 未起動のため **BLOCKED**。

## 環境への副作用（開示）
- port 54322 競合のため **Build-Factory プロジェクトのローカル supabase を停止**した
  （データは docker volume にバックアップ済み。該当プロジェクトの dir で `supabase start` すれば復元）。
- `supabase_db_atelier` は起動したまま（再検証用）。停止は `supabase stop`。

---

## 改訂 v2（同日・修正後の決定走行）

初検出バグを全修正し、**クリーンDB（全TRUNCATE + auth.users削除）→ フル2連走 = 661 passed / 0 failed / 0 error**。

### 加えた修正（PR: fix/realdb-schema-drift）
| # | クラス | 修正 |
|---|---|---|
| 1 | migration欠落(P0) | `t-d-94_e021_mcp_tokens.sql`（DDL+workspace RLS）/ `t-d-95_e022_byok_api_keys.sql`（DDL+self RLS+**encrypted_key 列レベルGRANT保護**） |
| 2 | RLS欠落(P0) | `t-d-96_ta40_cron_schedules_rls.sql`（default_deny撤去+member CRUD/delete=owner限定） |
| 3 | CHECK制約バグ(P0) | `t-d-97_ta47_knowledge_scope_constraint.sql`（enum'project'追加時に緩和し忘れた scope_owner_consistency を是正） |
| 4 | RLS違反→500 | knowledge create_node に narrow catch（member の platform 書込 → 403） |
| 5 | loop跨ぎengine再利用 | `_service_session_factory`×4（auth/skills/client_signin/admin_knowledge route）を **event loop キー付き cache** に（asyncpg は loop 跨ぎ不可） |
| 6 | テスト分離違反 | test_ctx01 が **import 時に os.environ.pop** し全テストの LLM env を破壊 → monkeypatch fixture 化（chat_sse の full 実行時 flake の根因） |
| 7 | staleフィクスチャ | t-i-05('internal'→'internal_product') / t-i-06(stage→lifecycle_stage, category/type/estimated_hours 追加, token_hash ユニーク化) / t-i-07(role enum, name/department 追加, ws名長) / t-d-36_vault(owner membership を trigger と重複回避) / t-i-08(**byok_keys→byok_api_keys へ正史化**+列保護アサート追加) / knowledge search の data ラップ |

### 注記（R-T08）
t-d-94/95/96 は新規 RLS ポリシーを含む。CI Gate #10（RLS isolation matrix）+ 実PG の rls/ テスト全PASSで機械検証済みだが、**規約上は経営者レビュー対象**。

---

## 改訂 v3（実機フルスイープ・全26画面 / 2026-07-06）

実 DB + API(uvicorn) + web(next dev) + **実 Chrome** で全26画面を操作スイープ。**実バグ6件を検出→修正→実機で貫通再確認→マージ（#250）**。

### 検出・修正した実バグ（すべて単体テスト緑では出ない型）
| # | 画面 | バグ | 型 |
|---|---|---|---|
| 2 | S-C01→C02 | 社員クリックが persona名 を id として遷移し詳細取得 500（テストがバグを期待値化） | 鉄則5 |
| 3 | S-I01 | 再生ボタンが 422。契約上 optional の requestBody を route が必須化 | 契約乖離 |
| 4 | S-J01/UC36 | approval kind が実 enum と全不一致で全行「タスク」表示 | G1 enum整合 |
| 5 | S-J01/UC36 | status フィルタ無しで承認/却下済みが一覧・通知に残留 | 意図とAPI既定の乖離 |
| 6 | S-K01 | page が workspaceId 未配線で恒久 zero-UUID 照会=常に空 | 未配線プレースホルダ |
| 7/8 | middleware | S-L01が client ガードに巻き込まれ社内到達不能 / **S-L02 自身がガード対象で自己無限リダイレクト＝ポータル全滅(P0)** | 到達性 |

（#1 は前回 diff: /search 500 → #249）

### 実機PASS（証拠=network/DB/画面遷移）
signup(local)→signin→cookie→redirect復帰 / 認証ガード / zero-state空UI(K02含む) / B01一覧→行クリック(死リンク#245修正済)→B02 KPI=DB実数 / C01組織図(部門別)→C02編集→PATCH→**DB反映** / I01再生→**202→列移動** / I02全6タブ(実行履歴=実データ) / I03 SSE(snapshot/end受信) / F01ノード+エッジ / F02状態select→PATCH→**DB反映** / J01承認→decide 200→**DB approved→一覧から消滅** / O01トグル→PATCH→**DB enabled=f** / K01ツリー表示(修正後) / UC36 pending通知+既読localStorage / UC37/38/39 / A03保存→**PATCH+ai-learning 2API発火** / G01(409)・H01(503)のdesignedエラー表示 / M01フォーム / L01招待一覧(修正後) / **L02 token→L03 клиентポータル貫通(修正後・権限バッジ表示)** / UC40検索(修正後ヒット)

### 残 BLOCKED（環境要因・正直に）
- storage 実表示（G01/H01 iframe・M01 実アップロード→Whisper）: supabase storage コンテナ unhealthy。解除=storage 起動+bucket 作成
- 負荷・スケール（第9軸）と RLS 越境のブラウザ実走: 未実施（RLS は pytest 実PG で全PASS済み）

### 既知の軽微残（起票対象）
- T-UC-38 の説明文言が「所属する プロジェクト を切り替えます」（正: ワークスペース）

## 改訂 v4（storage 実表示 BLOCKED 解除 / 2026-07-06）
- supabase フルスタック（storage healthy）起動に成功（前回 unhealthy は他プロジェクト常駐コンテナとの競合状況下のみ）。
- **S-H01 / S-G01: 署名URL→iframe 実表示を実機PASS**（bucket 作成+実ファイル配置、content-url 200、iframe に実コンテンツ描画）。
- **実バグ#9 検出→修正**: meetings upload-url の storage 署名 POST が Content-Type: json + 空 body で storage-api(Fastify) に 400 で全滅 → `json={}` 送信で解消。**署名URL への実 PUT 200（実オブジェクト作成）まで貫通**。モックでは原理的に不可視（G3 実プロバイダ検証の的中）。
- UC38 文言修正（nav.workspaces 追加、picker/説明文をワークスペースに）。
- 残 BLOCKED: transcribe の実 Whisper（外部 API キー、designed 503/424 表示は確認済み）／負荷・スケール第9軸。

## 改訂 v5（結果列の正本反映 / 2026-07-06）
- 鉄則3 に従い、実機で証拠を取った TC のみ screens/*.md の結果列を PASS 化し、2系統 xlsx を再生成。
- **実測内訳: PASS 130 / planned 263 / 全 393**（クライアント版: 完了127/363）。
- PASS の根拠クラス: 全26画面の表示+到達性（フルスイープ v3）/ 主要インタラクション・書込→DB反映（v3-v4 の実機貫通）/ a11y（vitest-axe 18画面 0 critical-serious）/ designed エラー表示（G01 409・H01 503）。
- **planned 263 の主な内訳（未実施を偽らない）**: レスポンシブ4幅 / フィールド単位バリデーション / 画面別 403 権限表示 / 楽観更新ロールバック（実機。ユニットでは検証済） / loading skeleton（大半） / 視覚忠実度 段2 スクショ突合 / 負荷・スケール第9軸。

## 改訂 v6（Playwright E2E 導入・レスポンシブ26画面消化 / 2026-07-06）
- Playwright ハーネス新設（apps/web/playwright.config.ts + tests/e2e/responsive.e2e.ts、*.e2e.ts で vitest と分離、cookie 直付け認証）。
- **レスポンシブ: 全26画面 × 320/768/1024/1440 を実ブラウザで実走 → 26/26 PASS**。
- **実バグ#10 検出→修正**: S-K01 の3ペイン固定 grid（18rem+20rem）が 320px で **338px 横オーバーフロー** → モバイル1カラム/lg以上3ペインに。
- 実測内訳: **PASS 156 / planned 237 / 全393**。

## 改訂 v7（403 sweep + rollback 実機 / 2026-07-06）
- Playwright error-paths.e2e.ts: **権限403を20画面**で route-interception 実走（拒否/エラー表示・白画面/500なし）、**楽観ロールバック実機3種**（O01トグル/F02select/J01承認: 422→楽観反映復元+alert）→ 23/23 PASS。
- **実バグ#11 検出→修正**: S-B01 が 403 時に API 生 detail「forbidden」をそのまま表示（e.message 直出し）→ ユーザー向け固定文言化。
- S-M01 は初期 GET を持たないため 403 行は対象外（備考参照）。

## 改訂 v8（loading skeleton 実機消化 / 2026-07-07）
- Playwright loading.e2e.ts: API GET を 1.2s 遅延注入し、**20画面全てで取得完了前に role=status / 読み込み中 が表示**されることを実機検証 → 20/20 PASS（バグなし。#241 の loading 一括対応の実機裏付け）。

## 改訂 v9（フィールドバリデーション実機 / 2026-07-07）
- validation.e2e.ts: S-A01 新規登録の zod 3種（確認不一致/同意なし/メール形式 a@b）を実 UI で発火し文言表示を検証、S-L02 トークン未入力（zod min10 が弾き API 未呼び出し・遷移なし）→ 4/4 PASS。

## 改訂 v10（負荷・スケール第9軸 実測 / 2026-07-07）
- vanilla PG に generate_series で **10万 tasks / 2万 knowledge / 100 WS×500 projects** をシードし実測。
- p95 実測: /tasks 76ms・/dashboard 11ms・/projects 7ms・/search 647ms（全て閾値内）。20並列(初期規模) p95=0.35s・エラー率0%。200並列はエラー0%だが単一worker で p95 13s（水平スケール前提の実証・グレースフル劣化）。
- **EXPLAIN が Seq Scan 2件を検出 → t-d-98_load_indexes.sql**（tasks(project_id,updated_at) 複合 partial + pg_trgm GIN×6）→ tasks 33ms→**0.054ms**、search SQL 57ms→**1.5ms**（Index Scan 化を EXPLAIN で確認）。
- 規模整合: RLS 越境 0 / dashboard 集計 50002 = count(*) 一致。
- 残: L-006 上限到達挙動（レート制限の実到達）は未実施。

## 改訂 v11（L-006 レート上限実装+実到達 / 2026-07-08）
- **契約乖離を検出→解消**: openapi の x-rate-limit 宣言 5 endpoint（signin 5/min/ip・play 10/min/user・knowledge/search 60・logs/stream 60・chat/stream 30）に対し汎用レート制限が未実装、かつ 4 endpoint は 429 応答も未宣言だった。
- 実装: src/rate_limit.py（プロセス内 sliding-window・単一worker構成で正確・水平スケール時は Redis 差し替えを明記）+ 5 route へ依存適用 + openapi へ 429 追加 + sync-types。テストは conftest の ATELIER_RATE_LIMIT_DISABLED=1 で保護し、専用テスト6本が有効化して検証。
- **L-006 実到達 PASS**: play 11連打 → 10×404 → 11回目 **429 + Retry-After: 60**（live curl 実測）。api 668 passed。

## 改訂 v12（planned=0 到達・最終決着 / 2026-07-14）
**実測内訳: PASS 378 / BLOCKED 13 / planned 0 / 全391**（前回比: 総数 393→391 = T-UC-36 の「既読ロールバック/API失敗」2行を削除。既読は localStorage のみで API が存在せず、生成テンプレの過剰適用だったため改訂で対象外化）。

### 最終ラウンドで実走した検証（E2E 第5-6弾 + pytest）
- final-sweep.e2e.ts: **5xx エラー表示 20画面 / 空データ 20画面 / F5状態永続 26画面 / axe 実ブラウザ 26画面** = 90 tests
- targeted.e2e.ts: A01初期値 / A03初期値・zod・rollback / C02 zod・422 / H01ビューポート切替 / **K02 実promote→DB昇格・却下dismiss・422復元** / **L01 発行→反映・失効・422** / L02 無効・期限切れtoken / L03 loading・空・403・5xx(client) / M01 file input / UC-37 readonly・101字・rollback / UC-38/39 picker実切替 / UC-40 5xx・403 = 17 tests
- pytest: **search RLS 越境**（別WSユーザーで 0 hit・実PG）

### 最終ラウンドで検出→修正した実バグ（累計16件）
- **#13 S-I03 実行ログが実質不可視**: `bg-on-surface` が未定義クラスで背景透過 → クリーム地にクリーム文字（コントラスト 1.09）。`bg-surface-fg` へ修正（admin s_t01-06 の同型も一掃）
- **#14 A03 AI学習チェックの意味反転（プライバシー重大）**: 「有効化する」チェックが optOut に直バインド+初期値 true → 既定で ON 表示・操作の意味が逆転。optIn 意味論へ修正（絶対ルール#6）
- **#15 S-K02 hydration mismatch**: cookie 読みを render 中に実行 → effect 化
- **#16 color-contrast serious**: J01 承認ボタン（teal×白 2.48→container対）/ B02 タイルラベル（4.05→ラベル中立色・数値のみtone色）/ I03 listitem 構造（role=log の位置）

### BLOCKED 13行の内訳（全て理由+解除条件付き）
- S-I03 ×5: SSE/bridge worker 依存（snapshot/end 実配信は v3 実機PASS済）
- S-M01 ×8: 実 Whisper 外部APIキー依存（upload-url→実PUT 200 までは PASS済）

## 改訂 v13（第10軸 AI実動マトリクス新設 / 2026-07-14）
- **重要な訂正（過大解釈の防止）**: これまでの green（api 669 / E2E 180 / planned=0）は全て「AI の器」の検証であり、**実プロバイダーでの AI 実動（応答品質・tool使用・状態耐性・bridge実行）は一度も検証していない**。fake LLM green を AI 検証と数えない（スキル第10軸の鉄則）。
- human-grade-qa スキルを skill-creator で更新し **第10軸 ai-runtime-matrix（プロバイダー×ツール×出力×状態）** を新設。本プロジェクトの棚卸し+マトリクス 23行を `.qa/test-specs/ai-runtime-matrix.md` に作成。
- 全行 **BLOCKED（解除条件: ANTHROPIC_API_KEY / VOYAGE_API_KEY 設定・bridge 起動）**。fallback は実装なしのため N/A 1行（明記）。
- 実測内訳（画面正本と合算）: 画面 391行=PASS 378/BLOCKED 13 ＋ **AI 23行=BLOCKED 22/N-A 1**。

## 改訂 v14（第10軸 初の実プロバイダー実走: AI-002 PASS + バグ#17 / 2026-07-15）
- **AI-002（キー無効 401 経路）を実 Anthropic で実走し PASS**（キー無しで実走可能な唯一の行）:
  - 不正キー+fake OFF で API 起動 → chat stream 実行 → **実 Anthropic 到達**（`request_id: req_011Cd35r…` が evidence）
  - SSE は `context → start → error` の順で全イベント JSON well-formed・接続は正常クローズ
  - stream 呼び出しは 1 回のみ（**リトライ暴走なし**）・空 assistant 行 0（**半端保存なし**）
  - UI は role=alert + Toast で明示エラー表示（Playwright 実ブラウザ、証拠 `.qa/evidence/ai-002-ui-error.png`）
- **実バグ#17 検出→修正（情報露出）**: chat_sse の except 節が `str(exc)[:300]` を SSE error content として
  そのままクライアントへ流し、UI に生のプロバイダーエラー（`request_id` 等の内部情報）が表示されていた。
  → ユーザー向けは定型文「AI 応答の取得に失敗しました。…」に統一し、詳細は server log
  （`chat stream LLM failure (thread=…)`）へ。修正後に SSE + 実ブラウザで再検証済（chat SSE suite 実PG 8 passed）。
- **AI-040/041 の記載を実コードで訂正**: apps/bridge の dispatcher は **T-F-27 の型+空骨格のみで実体未実装**
  （`claimNext` が TODO(T-F-28)）。「未起動」ではなく「実装未着手」が正確。解除条件に T-F-28 完了を追加。
- 集計: 画面 391行=PASS 378/BLOCKED 13 ＋ AI 23行=**PASS 1**/BLOCKED 21/N-A 1。
- 残り 21 行の解除条件は変わらず: `apps/api/.env` に ANTHROPIC_API_KEY（+VOYAGE_API_KEY）。
  設定され次第、安い順（output→tool→state→provider）に実走（概算 $1〜3）。

## 改訂 v15（棚卸しの実配線検証で 3 件の事実訂正 + 一括実走ハーネス整備 / 2026-07-15）
- **事実訂正①（tool 軸）**: `web_search`（src/tools/web_search.py, T-F-21）は**定義のみで chat 経路未配線**。
  `build_web_search_tool` の本番呼び出し元がゼロ（chat_sse の実 stream は `tools=` を渡さない）。
  → AI-010〜013 の 4 行は「キー待ち」ではなく「配線が存在しない＝テスト以前」に訂正。
- **事実訂正②（状態機構）**: **src/llm/ レイヤ全体（client/caching/compress/batch/openai）が本番経路から未使用**。
  import 元は各自の単体テストのみで、chat_sse は AsyncAnthropic を直呼びしている。
  → AI-032（compress 発火）・AI-033（cache）は発火し得ない/経路が存在しないため同様に訂正。
  （chat の長文脈は chat_sse 内の `_fold_older_history` 簡易要約が実担当）
- **事実訂正③（行数）**: マトリクスは grep 実カウントで**全 24 行**（従来記載 23 行は誤集計）。
  正: **PASS 1 / BLOCKED 22 / N-A 1**。BLOCKED 22 = キーのみで実走可 13 行 + 実装未着手 9 行。
- **一括実走ハーネス `scripts/qa/ai_matrix_runner.py` を整備**: キー実走可能 13 行
  （AI-001/003/004/005/020/021/022/023/030/031/034/035/036）を 1 コマンドで実走し、
  行ごとの不変条件 assert（日本語/非echo/well-formed/injection 非漏えい/並行混線ゼロ/
  中断後の残骸ゼロ等）と evidence JSONL+サマリ md を自動保存する。
  fake LLM ON・キー未設定では実行拒否（fake green 禁止をコードで強制、拒否動作は実確認済）。
- **CI 修復**: auto-merge workflow が checkout 無しの `gh pr view/merge` で毎回
  `not a git repository` 失敗していたバグを修正（GH_REPO 明示、PR #265 マージ済）。
- 含意: 「AI が汎用的にどんな状態でも動く」の完全証明には、キー設定に加えて
  **web_search/caching/compress の配線タスク（tickets.json 起票）** と T-F-28（bridge）実装が必要。
