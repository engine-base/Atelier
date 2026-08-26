# Data Layer Checks

UI で「成功っぽい」と「実際にデータが正しく保存された」は別物。
各操作の後にデータ層を直接見て **永続化** と **整合性** を確認する。

## 何を見るか

| 層 | 何を見るか | 道具 |
|---|---|---|
| HTTP | リクエスト/レスポンス、ヘッダ、ステータス | `read_network_requests` / curl --trace |
| Cookie / Storage | 認証 cookie、localStorage、IndexedDB | Chrome MCP `javascript_tool` |
| DB | 行数、関連、状態カラム | psql / mysql / mongosh |
| Cache | Redis のキー | redis-cli |
| Object storage | アップロードファイル | aws s3 ls / supabase storage |
| ログ | application log / structured log | tail -f |

## DB 検証パターン

### before / after diff

```sql
-- before
select count(*) from annual_curricula where school_id = '...';
-- 操作
-- after
select count(*) from annual_curricula where school_id = '...';
```

### 状態遷移

```sql
-- finalize 押した後
select id, status, finalized_at
  from annual_curricula
 where id = '<id>';
-- 期待: status = 'finalized', finalized_at not null
```

### 関連の整合

```sql
-- 親に紐づく子の数
select count(*) from sessions where curriculum_id = '<id>';
-- 期待: 12 件
```

### NULL / デフォルト

```sql
-- 必須カラムに NULL が入っていないか
select * from sessions where curriculum_id = '<id>' and genre_id is null;
-- 期待: 0 行（Q2 修正後）
```

### Unique / FK

操作後に重複や孤立データが作られていないか。

```sql
-- duplicate
select school_id, academic_year_id, grade_level, count(*)
  from annual_curricula
 group by 1,2,3
having count(*) > 1;

-- orphan
select s.id from sessions s
  left join annual_curricula c on c.id = s.curriculum_id
 where c.id is null;
```

## API 検証パターン

### curl で再現

UI で失敗したリクエストを curl で再走して、サーバ単体で再現するか確認:

```bash
curl -sS -i -X POST 'http://localhost:5173/api/...' \
  -H 'Authorization: Bearer <test-token>' \
  -H 'Content-Type: application/json' \
  -d @body.json
```

200/4xx/5xx で切り分け:

- UI で 500 だが curl で 200 → クライアント側のバグ
- UI で 200 だが永続化されない → トランザクション抜け
- curl でも 500 → サーバ側のバグ

### 認証バリエーション

| 試す値 | 期待 |
|---|---|
| 正しい token | 200 |
| 期限切れ token | 401 |
| 別ユーザの token | 403 |
| token なし | 401 |
| 不正な署名 | 401 |

## ストレージ

### LocalStorage

```js
JSON.stringify(Object.fromEntries(Object.entries(localStorage)), null, 2)
```

- 認証 token / 個人情報がベタ書きされていないか
- 容量上限（~5MB）に近いキーがあるか

### Cookie

```js
document.cookie
```

HttpOnly cookie は見えない。サーバ側で Set-Cookie ヘッダを `read_network_requests` で確認。

## 後処理：データ漏洩しないこと

- レスポンス JSON に内部 ID（UUID）や内部状態（debug flag）が漏れていないか確認
- エラーメッセージにスタックトレースや SQL 文が出ていないか
- ログに password / token / クレジットカード番号が出ていないか

## 失敗パターン

| 兆候 | 仮説 |
|---|---|
| UI で成功 / DB に何も入らない | トランザクションロールバック、または書き込み先テーブル違い |
| DB に重複 | クライアント二重送信 / 冪等性なし |
| 1 件作ったのに 0 件で見える | フィルタ条件・スコープ違い、tenant 違い |
| UI に 200 / レコードあり / 関連 0 | 子レコード作成が別 transaction で失敗 |
| 認証ヘッダで 200 / Cookie で 401 | サーバが Authorization 専用で Cookie を見ていない |
| 日付が 1 日ずれる | TZ ズレ（typeof Date / OID 1082 / ISO の Z） |

これらの兆候はそのまま `failures.md` の「根本原因仮説」に書き写してよい。
