# Runbook: BYOK 暗号化鍵 (`ATELIER_BYOK_ENCRYPTION_KEY`) のローテーション

> 対象: 顧客が持ち込んだ LLM プロバイダの API キー (BYOK) を暗号化している Fernet 鍵。
> 方式の決定根拠は [ADR-BYOK-encryption](../../03_architecture/adrs/ADR-BYOK-encryption.md)。
> 関連: `apps/api/src/services/byok_keys/__init__.py` / `SECRETS.md`

---

## ⚠️ 最初に読むこと — 鍵を失うと復旧できない

Fernet は**対称鍵**で、暗号文から鍵を復元する手段はない。
`ATELIER_BYOK_ENCRYPTION_KEY` を失うと `byok_api_keys.encrypted_key` は**永久に復号できず**、
**顧客全員に API キーの再登録を依頼するしかなくなる**。

したがって:

1. **鍵は必ず 2 箇所以上に保管する** (1Password 等の保管庫 + Fly secrets)。
2. **旧鍵は再暗号化が完了し検証が済むまで捨てない。**
3. 本手順は**旧鍵で復号できる状態を保ったまま**新鍵へ移す (無停止・巻き戻し可能)。

---

## 0. 前提と所要

| 項目 | 内容 |
|---|---|
| 実行者 | 人間 (シークレットの実値を扱うため。AI エージェントには実値を渡さない — `SECRETS.md` 3.) |
| 所要 | 鍵生成 1 分 / デプロイ 5 分 / 再暗号化は行数次第 (1 万行で数分) |
| 影響 | 無停止。手順 2 の状態では新旧どちらの暗号文も復号できる |
| 巻き戻し | 手順 4 まではいつでも旧鍵単独へ戻せる |

---

## 1. 新しい鍵を生成し、保管庫に入れる

```bash
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

出力を **1Password 等の保管庫**へ `ATELIER_BYOK_ENCRYPTION_KEY (new / 2026-08-15)` として保存する。
**旧鍵のエントリは消さない** — `(old / retired YYYY-MM-DD)` にリネームして残す。

> このファイルにも、`.env.example` にも、`SECRETS.md` にも**実値は書かない**。
> `scripts/ci/env-template-drift.py` が実値混入を検査しており、書くと CI が落ちる。

---

## 2. 新旧鍵を併用する状態にする (`MultiFernet`)

`MultiFernet` は **リストの先頭の鍵で暗号化し、復号はリスト内のいずれかの鍵で試す**。
この性質を使うと「新規は新鍵・既存は旧鍵で復号」という状態を無停止で作れる。

`ATELIER_BYOK_ENCRYPTION_KEY` に**新鍵を先頭にしたカンマ区切り**で両方を入れる:

```bash
flyctl secrets set --app atelier-api-eb \
  ATELIER_BYOK_ENCRYPTION_KEY='<新鍵>,<旧鍵>'
```

> **実装対応が必要**: 現行の `_fernet()` は単一鍵のみを受け付ける。
> 併用を有効にするには `services/byok_keys` をカンマ区切り対応 (`MultiFernet`) に
> する必要がある。**この runbook の手順 2 を実行する前に、対応が入っているかを確認すること。**
> 未対応であれば、先に対応タスクを起票してから本手順に入る (無理に進めない)。
> 対応状況: **未対応 (2026-08-15 時点)**。単一鍵のままなので、
> 現時点で鍵を変えると既存行が復号不能になる。**この runbook は対応が入るまで
> 「手順 1 で鍵を作って保管庫に置く」以降を実行しないこと。**

デプロイ後、既存行 (旧鍵で暗号化済) が読めることを確認する:

```bash
# 任意の既存 BYOK キーを 1 件 GET して 200 が返ること
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer <access token>" \
  https://atelier-api-eb.fly.dev/byok-keys
```

---

## 3. 全行を新鍵で再暗号化する

`MultiFernet.rotate()` は「復号して先頭の鍵で再暗号化」を 1 回で行う。

```python
# 実行前に DB のバックアップを取る (手順 5 参照)
from cryptography.fernet import Fernet, MultiFernet

mf = MultiFernet([Fernet(new_key), Fernet(old_key)])   # 順序が重要: 先頭が新鍵
# 各行に対して:
#   new_ciphertext = mf.rotate(old_ciphertext)
#   UPDATE byok_api_keys SET encrypted_key = :new_ciphertext WHERE id = :id
```

- **1 トランザクションで全行を更新しない**。数百行ずつコミットし、途中で失敗しても
  既に更新済みの行は新鍵で、未更新の行は旧鍵で、いずれも `MultiFernet` が復号できる。
- 実行後、**旧鍵でしか復号できない行が残っていないこと**を確認する
  (全行を新鍵単独の `Fernet` で復号してみる)。

---

## 4. 旧鍵を外す

手順 3 の検証が済んでから:

```bash
flyctl secrets set --app atelier-api-eb ATELIER_BYOK_ENCRYPTION_KEY='<新鍵>'
```

デプロイ後に再度 BYOK API を叩いて 200 を確認する。
保管庫の旧鍵エントリは、**最低 1 か月**は `(retired)` として残す (巻き戻しの保険)。

---

## 5. バックアップ (手順 3 の前に必須)

再暗号化は **`encrypted_key` を書き換える不可逆操作**。実行前に必ず取る。

```bash
# Supabase の論理バックアップ (encrypted_key を含む)
pg_dump "$ATELIER_DB_URL" --table=public.byok_api_keys --data-only \
  --file="byok_api_keys_$(date +%Y%m%d).sql"
```

- バックアップ自体が**旧鍵の暗号文**なので、**旧鍵とセットで保管する**。
  片方だけ残っても復号できない。
- バックアップファイルは保管庫か暗号化ボリュームへ。**リポジトリには絶対に置かない**
  (`.gitignore` 済でも作業ツリーに置かない)。

---

## 6. 緊急時 (鍵が漏洩した疑い)

1. **先に手順 1〜4 を最短で回す** (漏洩鍵で復号できる暗号文をなくす)。
2. そのうえで、顧客へ**プロバイダ側での API キー再発行**を案内する。
   漏洩鍵で復号された可能性がある以上、暗号化のやり直しだけでは不十分。
3. `SECRETS.md` 4. のローテーション対象表に沿って、他のシークレットも点検する。

---

## 7. チェックリスト

- [ ] 新鍵を生成し保管庫に入れた (旧鍵も `(old)` として残っている)
- [ ] `MultiFernet` 対応が実装に入っていることを確認した
- [ ] 手順 3 の前に `byok_api_keys` のバックアップを取り、**旧鍵とセット**で保管した
- [ ] 新旧併用の状態で既存行が読めることを確認した
- [ ] 全行の再暗号化後、**新鍵単独で全行が復号できる**ことを確認した
- [ ] 旧鍵を外し、BYOK API が 200 を返すことを確認した
- [ ] 旧鍵エントリを `(retired YYYY-MM-DD)` にして最低 1 か月残した
