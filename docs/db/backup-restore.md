# Atelier DB バックアップ / リストア手順

> 対象 DB: **Supabase Postgres 16 (Tokyo region)** — `03_architecture/selected-stack.json#primary_db`
> 関連: T-D-30 / R-T08（クライアント別 JWT 完全分離 — リストア時も RLS policy を必ず復元する）

Atelier の DB 保護は **2 層**で構成する。

| 層 | 手段 | 保護対象 | 担当 |
|---|---|---|---|
| 1. 基盤 | Supabase 自動バックアップ + PITR | 全スキーマ (auth / storage / public 他) | Supabase マネージド |
| 2. 論理 | `scripts/db-backup.sh` (pg_dump) | `public` スキーマ (アプリデータ) | 本手順 |

---

## 1. 基盤層 — Supabase 自動バックアップ / PITR

- **Free**: 日次バックアップ（保持 7 日相当、ダッシュボードから復元）。
- **Pro 以上**: Point-in-Time Recovery (PITR) を有効化し、任意時点へ復元可能。
- 操作: Supabase ダッシュボード → Project → Database → Backups。
- 本番運用では **Pro + PITR を有効化**し、RPO（目標復旧時点）を 5 分以内にする。

基盤層は `auth.users` / Storage オブジェクト / Vault secret を含む完全復旧用。
論理層（次節）は、誤操作（特定テーブルの破壊・誤 DELETE）からの **部分復旧**や、
別環境（staging / ローカル）への移送に使う。

---

## 2. 論理層 — `scripts/db-backup.sh`

### バックアップ取得

```bash
# Supabase の接続文字列を環境変数に (Session pooler / direct どちらでも可)
export DATABASE_URL="postgresql://postgres.<ref>:<password>@<host>:5432/postgres"

# フルダンプ (public スキーマ、custom format)
./scripts/db-backup.sh
# → ./backups/atelier-full-<UTC>.dump

# スキーマのみ / データのみ
./scripts/db-backup.sh --schema-only
./scripts/db-backup.sh --data-only

# 既存ダンプの健全性確認 (DB 接続不要)
./scripts/db-backup.sh --verify ./backups/atelier-full-<UTC>.dump
```

出力は `pg_dump -Fc`（custom format）。`--schema=public` で **アプリデータのみ**を対象とし、
Supabase 管理スキーマ（`auth` 等）は基盤層に委ねる。`--no-owner --no-privileges` により
復元先の所有者・ロール差異を吸収する（**RLS policy 定義は dump に含まれる**ため復元後も維持される）。

### リストア

```bash
export RESTORE_URL="postgresql://postgres.<ref>:<password>@<host>:5432/postgres"

# (A) 丸ごと復元 (空 DB / 別環境へ)
pg_restore --dbname="$RESTORE_URL" --no-owner --clean --if-exists \
  ./backups/atelier-full-<UTC>.dump

# (B) 特定テーブルのみ復元 (誤操作からの部分復旧)
pg_restore --dbname="$RESTORE_URL" --no-owner \
  --table=public.tasks \
  ./backups/atelier-full-<UTC>.dump

# (C) 目録を確認してから選択復元
pg_restore --list ./backups/atelier-full-<UTC>.dump
```

### リストア後チェックリスト（R-T08 必須）

1. **RLS が有効**であること:
   `select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r';`
   → 全アプリテーブルで `relrowsecurity = t`。
2. **policy 件数**が復元前と一致すること:
   `select count(*) from pg_policies where schemaname='public';`
3. `auth.uid()` / `current_user_workspaces()` などの helper 関数が存在すること。
4. 越境試験（`scripts/verify_rls_isolation.py`）を staging で再実行し、
   workspace/client 分離が維持されていることを確認する。

> ⚠️ `--no-owner` で復元すると policy の `TO authenticated` ロールは保持されるが、
> 復元先に `authenticated` / `anon` / `service_role` ロールが存在しない場合は
> 先に作成する（Supabase 環境には標準で存在）。

---

## 3. 運用スケジュール（推奨）

| 環境 | 基盤 PITR | 論理ダンプ |
|---|---|---|
| 本番 | 有効 (RPO 5 分) | 日次 + リリース前に手動取得 |
| staging | 日次 | リリース前のみ |
| ローカル | — | 必要時 (`supabase db dump` でも可) |

論理ダンプの保管は暗号化ストレージ（顧客データを含むため）に置き、
保持期間と削除を SOC2 要件に合わせて管理する。
