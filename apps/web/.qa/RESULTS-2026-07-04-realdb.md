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
