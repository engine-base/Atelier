# route-sweep — 全ルート×実スキーマ整合・実DB貫通スイープ（第7軸の詳細）

mock/契約テストが緑でも、サーバハンドラ(API route / controller / handler)の DB 操作が**実スキーマ(実DB)と
不一致**だと、実機で 500 / 0件 / 認可エラーになる。これは「部品が動くか」を見るユニットテストの死角であり、
**画面(screens)経由で表面化した分だけ直しても、画面から叩かれない・条件分岐の奥にあるルートに同型バグが残る**。

> 鉄則: **全サーバハンドラをスイープ完了するまで未完**。「N個直したから十分」は不可。
> 母数(全ルート数)と検証済み数を必ず数値で出し、残数0になるまで続ける。

## なぜ起きるか（根本）
実装者は「想定スキーマ」に対してハンドラを書き、ユニットテストは DB クライアントをモックする。
モックは列名・enum・制約を検証しないため、**実マイグレ(DDL)とのズレが永遠に緑のまま通過**する。
実DBに通して初めて露見する。

## 手順（フレームワーク非依存）

### STEP R1 — 全サーバハンドラを列挙（母数を確定）
- ルーティング規約に応じて全件抽出: `app/**/route.ts`(Next App Router) / `pages/api/**`(Pages) /
  `routes/**`・`controllers/**`(Express/Nest/Rails/Laravel 等) / RPC・GraphQL resolver。
- HTTP メソッド単位で数える(GET/POST/PATCH/PUT/DELETE)。**総数 N を記録**。
- 出力: routes タブに 1 行/ルート(後述 spreadsheet-matrix)。

### STEP R2 — 静的突合（実DDLと列名・enum・制約）
各ルートの DB 書込/読取を実スキーマ(migrations / schema.sql / prisma schema / DDL)と機械突合する:
- **insert/update の各キー名**が実テーブルに存在するか（存在しない列＝500）。
- **代入する値が enum 列なら、その値が enum 定義に含まれるか**（無効値＝enum比較で500）。
- **NOT NULL 列を漏れなく与えているか**（未設定＝NOT NULL違反）。
- **FK 先が実在するか**（特に seed/fixture 由来 id）。
- **select する列名**が実在するか（存在しない列の select＝500）。
- grep で機械的に洗うパターン例（プロジェクトの実enum/実列に置換して使う）:
  - 固定ステータス値の代入: `status:\s*['"][a-z_]+['"]` → 実 enum と照合
  - `*_id:` への UUID/識別子代入 → 当該列が UUID か enum/区分か
  - 日付・所有者列: `created_at`/`updated_at`/`*_by`/`*_at` の手動代入が実列名と一致するか

### STEP R3 — 実DB貫通（モック禁止）
各ルートを**実DBに対して実行**し、結果コード/本文/副作用を観察する:
- 認証必須ルートは実セッション/実トークンで叩く（認可ヘッダ/cookie/JWT を本物で）。
- 期待: 2xx + 期待副作用、または妥当な 4xx。**500 / 0件(本来あるべき) / 認可エラー** を炙り出す。
- 書込は実テーブルに行が増えるか(select で再確認)。読取は件数/中身が妥当か。
- 破壊的・本番DBは事前承認。ローカル/使い捨てDB推奨。

### STEP R4 — 既知 systemic class（a〜g）を必ず照合
実プロジェクトで頻出した類型。各ルートで該当を疑う:
| # | class | 症状 | 確認 |
|---|---|---|---|
| a | 列名不一致 | "column X does not exist" / 500 | insert/select 列名 ⇔ DDL |
| b | 存在しない列へ代入 | 同上 | ハンドラのキー ⇔ 実テーブル列 |
| c | 無効 enum 値 | "invalid input value for enum" | 代入値 ⇔ enum 定義 |
| d | client メソッドの this 未バインド | "Cannot read properties of undefined (reading 'rest')" 等 | `const fn = client.method`(分離)→ `.bind(client)` か直呼び |
| e | 認可の role 判定が誤claim | 書込/管理操作が常に拒否(403/RLS) | RLS/ガードが「DBロール(authenticated)」でなく「アプリrole(app_metadata等)」を見ているか |
| f | リクエスト文脈(GUC/セッション変数)が別トランザクションで不伝播 | RLS が空値を評価し 0件/エラー | 文脈設定とクエリが**同一トランザクション/リクエスト**で効くか(pre-request hook 等) |
| g | seed/fixture の id が非RFC等で検証に弾かれる | "validation failed"(uuid等) | seed の id が本番のID生成(例: UUID v4)と同じ妥当性を満たすか(手書きの全ゼロ等は検証に弾かれる) |

### STEP R5 — 完了条件
- routes タブの全行が pass(または妥当な 4xx) で、証拠(実行結果/副作用)付き。
- 未検証ルートが 1 件でも残れば**未完**。スイープ完了率(検証済み/総数)を summary に明記。

## 修正の型
- a/b/c: ハンドラの列名・enum・必須列を実DDLに合わせる(または DDL/マイグレ側を正とするか判断)。
- d: メソッドを `.bind(client)` するか直接呼ぶ。
- e: 認可述語をアプリroleソース(クレーム/セッション変数)へ統一。
- f: 文脈をリクエスト先頭フック等で同一トランザクションに設定。
- g: seed/fixture の id を本番同等の妥当な形式に再生成(参照整合を保って一括置換)。

> 各修正後は「実DBで再実行して通ること」を証拠化。ユニットテストが古い不正形状を期待していたら、
> **テスト側を実スキーマ準拠に正す**(実装ではなくテストが間違っているケース)。
