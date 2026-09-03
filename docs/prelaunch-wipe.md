# ローンチ前の本番 DB 全消去手順（`scripts/prelaunch-wipe.sh`）

> ADR-021 改訂 2026-09-03 / GAP-250。ローンチ前は本番 Supabase プロジェクトを staging として共用している。
> 実顧客が入る前に QA データを全部消し、deploy.yml と同じコードで運営固定データだけを入れ直す。
> **ダッシュボードで手作業しない。** レビュー済みの 1 コマンドで、ガード付きで行う。

## 1. いつ・誰が

| 項目 | 内容 |
|---|---|
| いつ | **ローンチ直前**: 最後の QA（L4 full）が終わった後、最初の実顧客が入る前。T-I-24 go/no-go の前提。1 回きり |
| 誰が | **経営者**（本番 DB の接続文字列を持つ人）。自分の Mac で実行する |
| 接続文字列 | GitHub secret **`PROD_DATABASE_URL`** と同じ値（Supabase Session pooler `postgresql://postgres.<ref>:<pw>@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres`）。Supabase Dashboard → Connect → Session pooler でも同じものが取れる |
| 前提ツール | `psql` / `pg_dump` / `pg_restore`（サーバーと同じか新しい版。`brew install postgresql@17`）/ `python3` |
| 所要 | 数分（backup の大きさ次第） |

## 2. コマンド

```bash
cd Atelier
export DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres'

# ① まず dry-run: 何を消すか・今の行数を見るだけ（backup も wipe もしない）
./scripts/prelaunch-wipe.sh --env production-prelaunch --dry-run

# ② 本実行
./scripts/prelaunch-wipe.sh --env production-prelaunch --i-understand-this-deletes-everything
```

出力の最後が `✓ prelaunch-wipe 完了` で exit 0 なら成功。`❌ verify FAIL` なら §4 を見る。
接続文字列のパスワードは画面に出ない（`postgres.<ref>:***@…` と表示）。

### ガード（どれか 1 つでも外れると **何もせず** exit 2）

1. `DATABASE_URL`（`postgresql://` で始まる）と `--i-understand-this-deletes-everything` の両方
2. `--env`（無ければ `APP_ENV`）が `production-prelaunch` か `staging`。`production` など他の値は拒否
3. `03_architecture/selected-stack.json` の `environments.staging.phase` が **`pre-launch` で始まる**こと。
   ローンチ時に案 A（別プロジェクト）へ切り替えて phase を書き換えた後は、このスクリプトは二度と動かない

## 3. 何をするか（4 ステップ）

| # | ステップ | 中身 |
|---|---|---|
| 1 | backup | `scripts/db-backup.sh`（`pg_dump -Fc --schema=public`）→ `./backups/atelier-full-<UTC>.dump`。`pg_restore --list` で健全性確認。**失敗したら続行しない** |
| 2 | wipe | public の全表を **1 トランザクションで `TRUNCATE … RESTART IDENTITY CASCADE`**（運営固定の表は temp 表へ退避 → 復元）。`storage.objects` は GAP-242 の 7 バケット分を `DELETE`。`auth.users` を `DELETE`（identities / sessions / refresh_tokens は Supabase の FK cascade で消える） |
| 3 | reseed | deploy.yml と **同じスクリプト・同じ順**: `SCHEMA_ONLY=1 scripts/ci/apply-migrations.sh` → `scripts/ci/apply-seeds.sh` |
| 4 | verify | 全表の行数を表で出す。運営固定以外に 1 行でも残っていれば **exit 1** |

### 消えるもの

- **public の全アプリデータ**: users / workspaces / memberships / projects / phases / tasks / chat_* / knowledge_* / outputs / mocks / comments / consents / audit_logs / billing / bridge_* / byok_api_keys / mcp_tokens / oauth_accounts / error_log / cron_* … 63 表（`--dry-run` に全表が出る）
- **`auth.users`** 全員（QA アカウント含む。Supabase Auth のセッション・identity も連鎖して消える）
- **`storage.objects`** の 7 バケット（chat-attachments / outputs / mocks / avatars / meetings / transcripts / reference-uploads）の中身
- 出力デザインテンプレの **ワークスペース版**（`output_design_templates` で `is_platform_default = false`）

### 残るもの（消さない）

| 残るもの | 理由 / 持ち主 |
|---|---|
| スキーマ・表・index・RLS policy・関数・トリガ・enum | `TRUNCATE` は行だけ消す。`DROP` は一切しない |
| migration | `supabase/migrations/*.sql` は冪等で deploy ごとに再適用する方式（追跡表は無い）。`supabase_migrations` スキーマがあっても触らない |
| `skills` / `ai_employee_templates` | `supabase/seed/t-d-24.sql`（UPSERT）。運営が管理画面で足した行も残す |
| `legal_documents` | migration が正本（gap-188 / 204 / 208）。同意記録の突合に旧版も要る |
| `dispatch_control` | 単一行（id=1）。migration が入れる |
| `output_design_templates` の **運営既定**（`is_platform_default = true`） | 運営が管理画面で作る既定。WS 版だけ消す |
| `storage.buckets` の 7 行 | migration gap-242 が持ち主 |
| Supabase の設定（Auth の Site URL / Redirect URLs、SMTP、API キー、Vault） | DB の行ではないので触らない |

## 4. 確認

- スクリプトの **[4/4] verify** 表で、`expected 0` の表がすべて `OK`、`skills` / `ai_employee_templates` / `legal_documents` / `dispatch_control` が `>0 (seed) OK`、`auth.users` / `storage.objects` が 0、`storage.buckets (gap-242)` が 7。
- 続けて **本番スモーク**（`apps/web/.qa/test-specs/prod-smoke.md` の PS-01〜）を流す。特に: 新規登録 → ワークスペース作成で AI 社員 10 名が実体化する（テンプレが残っている証拠）、法務ページが表示される、添付の署名 URL が 200（バケットが残っている証拠）。
- `verify FAIL` が出たら: FAIL 行の表を見る。`storage.objects` の FAIL は 7 バケット以外にオブジェクトがある（ダッシュボードで作ったバケット）ので、バケット名を確認して手で判断する。public の表が FAIL になるのは reseed（migration の backfill）が行を作った場合で、その migration の内容を確認する。**verify が FAIL のままローンチしない。**

## 5. 復元（間違えて消したとき）

backup は **public スキーマだけ**（`db-backup.sh` の仕様。`docs/db/backup-restore.md`）。

```bash
export RESTORE_URL="$DATABASE_URL"
# 丸ごと戻す（表は残っているので --clean --if-exists で入れ直す）
pg_restore --dbname="$RESTORE_URL" --no-owner --clean --if-exists ./backups/atelier-full-<UTC>.dump
# 復元後チェック（RLS 有効 / policy 件数 / 越境試験）は docs/db/backup-restore.md §2 の通り
```

- `auth.users` / `storage.objects` は dump に入っていない。必要なら Supabase Dashboard → Database → Backups（日次）から戻す。
  ただし **ローンチ前のデータは QA 専用で使い捨て**（selected-stack `environments.staging.data_policy`）なので、通常は戻さない。
- `storage.objects` の行を消しても **S3 側の実ファイルは残る**（Supabase は行の削除だけでは物理削除しない）。課金・動作には影響しないが、
  物理的にも消したいときは `supabase storage rm -r ss:///<bucket>/ --experimental`（Supabase CLI、`supabase link` 済みで）を 7 バケットに対して実行する。

## 6. ローカルでの実証（2026-09-03）

使い捨て DB（素の PG 16 + `scripts/ci/pg-bootstrap.sql` + 擬似 `storage` スキーマ）に migration 99 本 + seed を当て、
auth.users 2 / workspaces 2（トリガで memberships 2・ai_employees 20）/ projects 2 / storage.objects 3 / WS 版テンプレ 1 を入れて実行:
backup 取得 → 63 表 TRUNCATE（運営固定 5 表を復元）→ storage.objects 3 行・auth.users 2 行 DELETE → migration 99 / seed 1 再適用 →
verify 全行 OK（skills 23 / templates 10 / legal 6 / dispatch_control 1 / buckets 7、それ以外 0）で exit 0。
ガード 4 種（フラグ無し / env 無し / env=production / phase≠pre-launch）はいずれも何もせず exit 2。
`storage` スキーマの無い環境では `storage.objects: SKIP (storage スキーマが無い環境)` と明示して続行する。
