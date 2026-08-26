# Workflow — 詳細フロー

SKILL.md の 4 STEP を実行レベルにブレイクダウンしたもの。

## 0. 起動時チェック

- ユーザ発話からモードを判定（full / diff / feature / regression）
- 曖昧なら 1 行で確認: 「全体？ それとも差分だけ？」
- カレントディレクトリがプロジェクトルートか確認（`package.json` / `pyproject.toml` / `Cargo.toml` 等の存在）
- 既存 `.qa/` の有無を確認 → あれば過去の `failures.md` を読み込み（再発防止用）

## 1. プロジェクトスキャン

`scripts/scan_project.sh` を実行して以下を抽出:

- 主要 dev script (`package.json#scripts`)
- フレームワーク種別の推定
- ルーティング: `src/router/**`, `pages/**`, `app/**`, `routes/**`, FastAPI `app.include_router`, Express `app.use`, Rails `routes.rb`
- API: `routes/*.py`, `handlers/*.go`, `controllers/*.rb`, OpenAPI yaml
- 認証: `middleware/*auth*`, `*authMiddleware*`, `passport`, `next-auth`, `clerk`, `supabase-auth`
- DB スキーマ: `migrations/**`, `prisma/schema.prisma`, `db/schema.rb`, `*.sql`
- 環境変数キー: `.env.example`, `.env.local.example`（値は読まない）
- 既存テスト: `tests/**`, `e2e/**`, `cypress/**`, `playwright/**`, `__tests__/**`

スキャン結果は `.qa/plans/<plan>.md` 冒頭にサマリで貼る。

## 2. テスト計画書ドラフト

- `templates/test-plan.md` を master として配置
- 機能ごとに `templates/feature-spec.md` を複製して `feature-specs/F-NN-<slug>.md` を作成
- `references/coverage-matrix.md` に従い、各機能に **正常 / 異常 / バリデーション / 境界 / 権限 / 復帰** の 6 カテゴリを必ず割り当てる
- バリデーションは **全入力フィールド × 全ルール** をテーブル化
- 重要度 P0/P1/P2 を割り振る

承認:

- 計画書をユーザに見せて 1 行で要約: 「F-01〜F-NN、計 X ケース、所要 hh:mm。実行 OK？」
- 「進めて」「OK」等が来てから STEP 3 へ。それまでは絶対に dev サーバを起動したり Chrome を開いたりしない。

## 3. 実行

### 3.1 dev サーバ確認

`scripts/start_dev.sh` で起動 or 起動済を検出。起動した PID は `.qa/runs/<run>/dev.pid` に保存。

### 3.2 テストデータ準備

- 既存 fixture が使えるか確認 → 使えればそれ
- なければ API 経由で seed（ヒトのフリで GUI から作成、または `curl` で create）
- 作成した ID を `.qa/runs/<run>/fixtures.json` に保存（後で teardown するため）

### 3.3 ケース実行ループ

各 TC につき:

1. **事前条件** をセットアップ（ログイン状態 / cookie 等）
2. Chrome MCP で **手順** を 1 ステップずつ実行
   - クリック前後でスクショ
   - 入力後にフォーカス外して validation を見る
3. **期待結果** をチェック:
   - UI: テキスト、URL、エラーメッセージ
   - API: ステータスコード、レスポンスボディ（network 監視）
   - DB: `psql -c 'select ... where id = $1'` で永続化確認
   - ログ: console error が出ていないか
4. **証拠を保存してから** PASS / FAIL を記録:
   - **passed にするには `evidence` に screenshot / db_checks / network のいずれか実体が必須。**
     証拠を取れなかった TC は passed にせず `planned`（未実施）のまま残す。「動くはず」で PASS にしない。
   - `features/<feature>.md` に記録（テンプレ: `templates/run-log.md`）
5. FAIL なら `failures.md` にも追記（再現手順 + 仮説）

連続 3 FAIL → 停止しユーザ報告。

#### ステートフル機能は必ず「3 ターン以上」連続実行する（最重要・抜けやすい）

チャット / ウィザード / 複数ステップフォーム / カート / 下書きなど **状態を持つ機能**は、
TC を「1 操作で完結」させてはいけない。 同じ会話・同じセッション・同じウィザードで
**最低 3 ステップ続けて**、 各ステップで「前の状態を覚えているか」を確認する。

- **API テスト**: 同一 scope / session_id で連続 POST し、 各レスポンスとツール呼び出しを観察。
  例: 2 ターン目で「最初から作り直す」「もう一度同じ質問をする」挙動なら **文脈喪失 = FAIL**。
  DB で全ターンの session_id が一致しているかも確認する。
- **UI テスト**: 実際に画面で送信 → 続けて送信 → さらに送信、 と人間のように続ける。
  途中でリロード / 別タブ / 「既存を編集」での再オープンも挟み、 状態が生きているか見る。
- **ID 遷移の罠**: 「仮 ID（new-xxx）で開始 → 作成して実 ID 発番」で ID が変わる系は、
  実 ID 発番後の次ターンが **空のセッションに落ちて文脈が消える** 事故が起きやすい。
  必ず「作成 → 続けて指示」を 1 本の TC として通す。

> なぜここを強調するか: 「1 リクエスト = 1 レスポンス」の単発テストは状態継続バグを
> **原理的に 1 件も検出できない**。 実プロジェクトの「途中で会話が飛ぶ」「作ったものが
> 次に入っていない」系クレームはすべてここを飛ばしたことが原因。

#### 層またぎ・統合整合スイープ（単一画面では出ないバグ）

各機能の単体 TC とは別に、**コードを横断して初めて出るバグ**を専用に潰す。これを飛ばすと
「画面は全部 PASS なのに実運用で落ちる」が起きる（coverage-matrix セクション G に対応）:

- **enum 整合**: API が受理する値（status 等）と FE のフィルタ/ラベル定義を grep で並べ、差分が無いか。
- **ルート実在**: ハンドラ一覧と route 登録一覧を突き合わせ、**全エンドポイントを実際に curl** して 404 が無いか。
- **ナビ全リンク**: サイドバー/メニューの全項目を **param 無し**で開いて、どれも落ちない・エラーにならないか。
- **リロード/セッション**: 主要画面で F5 リロード → ログイン画面に飛ばないか・状態が残るか。
- **フィルタ実効**: 一覧の各フィルタ値で件数/中身が実際に変わるか（全件と同じなら絞れていない疑い）。
- **作成→再取得→DB**: 作成 API のレスポンスだけで PASS にせず、別 GET と `select` で実在を確認。
- **集計 vs 実数**: 数字系 KPI を `select count(*)` と突合。内訳の合計＝総数か。
- **マイグレーション**: 適用後に `\d table` で新カラム/CHECK/index の実在を確認。

#### クリーン環境/0状態スイープ（seed済みDBでは出ないバグ・full 必須）

既存/seed済みDB相手のテストでは «fresh でだけ壊れる» バグを見逃す。 **必ず 1 本以上**実走する
（coverage-matrix セクション H・H-seed に対応）。 手順の型:

1. **全テーブル TRUNCATE**（または使い捨てDB）→ count=0 を確認。
2. **空状態スモーク**: 主要画面/API を開く・叩く → 500/throw で死なず、 空UI/200/適切な4xx か。 各ログインが例外でなく適切に拒否（403/401）か。
3. **seed のみ実行 or 手動ブートストラップ**: `db:seed` を素で流す → **seed だけで基本フローが成立するか**（S1）。 seed が必須項目=ログインPW 等を落としていないか実値で確認（S2）。 二重要件（Auth＋権限テーブル）が要る管理者は手順通りブートストラップ。
4. **0→初回登録→ログイン貫通**: 管理者で 親(期生等)→子(学生) を実導線/CSVテンプレ DL→記入→取込で作成 → 払い出された **デフォルトPW**で当の学生がログイン 200 → 主要画面/API が空〜最小データで動く。
5. **復元**: 検証後に再 seed（共有DBの場合）。
- **共有/本番DBで行うときは事前にユーザ承認**（破壊的・本番投入のため）。 ローカル/使い捨ては承認不要。
- 証拠: TRUNCATE後 count=0 / seed後の必須列の実値 / 0→ログイン200 の network を `evidence` に残す。

### 3.4 teardown

- 作成したテストデータを削除（fixtures.json 参照）
- ただしユーザ確認なしで本番 DB を消さない

### 3.5 自己監査（捏造PASS ゲート）

レポート（STEP 4）の前に必ず:

```bash
scripts/audit_evidence.sh .qa/runs/<run-id>
```

未証明 PASS（証拠ゼロの passed）が出たら、実機で再実行して証拠を取るか `planned` に戻す。
捏造のまま STEP 4 に進まない。`render_report.sh` も同検出で判定を BLOCK に落とす。

## 4. レポート

- `reports/YYYY-MM-DD-final.md` を `templates/final-report.md` から生成
- ユーザに 3 行サマリで報告

## 失敗時のリカバリ

- Chrome がフリーズ: `chrome` プロセスを再起動 → 該当 TC を 1 回だけ再走 → なお失敗なら FAIL
- dev サーバが落ちた: 自動再起動を 1 回試す → なお駄目なら停止しユーザに報告
- DB 接続不可: スキップ判定、レポートに明記

## チェックリスト（実行開始前）

- [ ] スキャン完了
- [ ] 計画書ユーザ承認済
- [ ] dev サーバ起動 OK
- [ ] テストアカウント手配済
- [ ] `.qa/runs/<run>/` ディレクトリ作成済
- [ ] スクショ出力先設定済

## チェックリスト（レポート発行前・必須）

- [ ] 層またぎスイープ（enum/ルート実在/全リンク/リロード/フィルタ/作成→DB/集計突合/マイグレーション）実施
- [ ] **クリーン環境/0状態スイープ実施**（空DB起動 500なし / fresh seed で素にログイン成立 / 0→初回登録→ログイン貫通）
- [ ] `scripts/audit_evidence.sh` が exit 0（未証明 PASS ゼロ）
- [ ] 全 passed に screenshot / db_checks / network のいずれか証拠あり
- [ ] `render_report.sh` の判定に「信頼不可（未証明PASSあり）」が出ていない
