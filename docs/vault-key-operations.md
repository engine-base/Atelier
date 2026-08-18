# Vault 鍵運用手順 (GAP-131)

> 対象: `project_credentials` (プロジェクト・シークレット) の暗号鍵。
> 実装: `apps/api/src/services/project_credentials/` (MultiFernet)。
> 裁定: [ADR-020](./adr/ADR-020-vault-encryption-key-management.md)

## 鍵の設定

| 環境変数 | 意味 |
|---|---|
| `ATELIER_VAULT_ENCRYPTION_KEYS` | **推奨**。カンマ区切りで複数指定可。**先頭の鍵で暗号化**、復号は全鍵で試行 (ローテーション移行期対応) |
| `ATELIER_VAULT_ENCRYPTION_KEY` | 旧単鍵 (後方互換)。`KEYS` 未設定時のみ使われる |
| `ATELIER_VAULT_REAUTH_TTL_SECONDS` | reveal 再認証の有効秒数 (既定 300) |

鍵の発行:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

## 鍵ローテーション手順 (無停止)

1. 新しい鍵を発行する (上記コマンド)
2. `.env` の `ATELIER_VAULT_ENCRYPTION_KEYS` を **`新鍵,旧鍵`** の順に設定し、API を再起動する
   - この時点で: 新規登録は新鍵で暗号化 / 既存行は旧鍵のまま復号できる (移行期)
3. 既存行を新鍵で再暗号化する:
   ```bash
   cd apps/api
   uv run --no-sync python scripts/rotate_vault_key.py --dry-run   # 件数確認
   uv run --no-sync python scripts/rotate_vault_key.py             # 実行
   ```
   `skipped=0` を確認する。skipped が出た行は**どの鍵でも復号できない** —
   旧鍵の設定漏れを直してから再実行する (スクリプトは黙って壊さない)
4. `ATELIER_VAULT_ENCRYPTION_KEYS` から旧鍵を外して API を再起動する
5. 旧鍵は次の四半期まで安全な場所 (パスワードマネージャ等) に保管してから破棄する

**推奨頻度**: 年 1 回、またはホストの侵害が疑われた直後・退職者/委託先の離任直後。

## 鍵を失った場合

Fernet は鍵が無いと**復号不能**です (これは仕様であり、鍵が漏れても DB だけでは
読めないという防御の裏返し)。

- `rotate_vault_key.py` の `skipped` に出た行 = 復号できない行。**値の復旧は不可能**
- 対応: 該当シークレットを削除し、発行元 (顧客・サービス) で再発行 → 再登録する
- 予防: 鍵は **DB バックアップとは別の場所** に必ず控える (同じ場所に置くと
  「鍵と暗号文が一緒に漏れる/一緒に消える」— どちらも最悪)。推奨は
  パスワードマネージャ (1Password 等) + 紙のリカバリーコード

## dev / prod の鍵分離 (AI エージェント対策)

**AI が触るホストに本番の鍵を置かないこと。** このリポジトリで作業する
AI エージェント (Claude Code 等) はシェルを実行でき、`.env` と DB の両方に
届く。つまり本番鍵を開発ホストに置くと、構造的には AI が全シークレットを
復号できてしまう (SECRETS.md の運用ルールで守っているだけ)。

- 開発ホスト: 開発用の鍵 + ダミーデータのみ
- 本番ホスト: 本番鍵。AI エージェントのシェル実行を許可しない
- 恒久対策 (鍵をアプリから取り上げる KMS 化) は ADR-020 参照 —
  ホスト版 (顧客提供の本番) では必須要件

## reveal の防御層 (GAP-131 実装済)

1. **列レベル revoke**: `encrypted_value` は authenticated ロールから SELECT
   不可 (`gap-131_project_credentials_hardening.sql`)。RLS を通っても
   ciphertext は API 越しに取れない。読めるのは reveal の service セッションのみ
2. **パスワード再認証**: reveal にはログインパスワードの再入力が必要。
   成功後 300 秒 (TTL) はパスワードなしで続けられる。失敗は
   `credential.reveal_denied` として監査記録
3. **レート制限**: 10 回/分/ユーザー
4. **監査**: すべての reveal は `audit_logs` (`credential.reveal`) に記録

### 監査の見方 (記録は見なければ事故の後にしか役立たない)

```sql
-- 直近 7 日の reveal (誰が・いつ・どれを)
select created_at, actor_id, target_id, action
from audit_logs
where action in ('credential.reveal', 'credential.reveal_denied')
  and created_at > now() - interval '7 days'
order by created_at desc;
```

`reveal_denied` が連続しているユーザーは、パスワード総当たりの兆候。
