# ADR-BYOK-encryption — 追随の記録 (T-F-52)

- **親 ADR**: [ADR-BYOK-encryption.md](./ADR-BYOK-encryption.md) (Accepted 2026-08-15)
- **実施**: dev / T-F-52 / 2026-08-15
- **性質**: **仕様側の追随のみ。実装は 1 行も変更していない。**

---

## 1. 何をどちらへ寄せたか

食い違いは「`selected-stack.json` (Supabase Vault) ↔ 実装 (Fernet)」の 2 者間にあった。
ADR の決定は **Fernet 採用**なので、**仕様側を実装に寄せた** (CLAUDE.md ルール 13
「実装を歪めて辻褄を合わせない。仕様を先に直す」の適用)。

| 対象 | 変更前 | 変更後 |
|---|---|---|
| `03_architecture/selected-stack.json` | BYOK 暗号化の明示エントリ**が無い**。`primary_db.reason` に「Auth/Storage/Realtime/**Vault** 一元化」とあり Vault 利用を含意 | `selections.byok_encryption` を**新設**し `Fernet + ATELIER_BYOK_ENCRYPTION_KEY + 列レベル権限` を chosen に。`primary_db.reason` から `Vault` を削除 |
| `07_tasks/tickets.json` T-F-19 | 表題「**Supabase Vault**（BYOK 暗号化）」/ AC はテンプレの `importable` のみ | 表題「BYOK 暗号化 (Fernet + 列レベル権限) — ADR-BYOK-encryption」/ AC を実装の性質 (鍵を DB に置かない・`encrypted_key` の列レベル revoke) で記述 |
| 実装 (`apps/api/src/**`) | — | **変更なし** |

`Supabase Vault` は `byok_encryption.alternatives` に**却下案として残した**。
検討したうえで選ばなかった事実を消すと、同じ議論が再発するため。

## 2. 決定内容の要約 (親 ADR の再掲)

主脅威 **T1 (DB ダンプ流出)** では両案同等。差が出たのは **T2 (DB 読み取り権限を持つ内部者)** で、
Fernet は復号鍵が DB の外 (Fly secrets) にあるため **DB 権限だけでは平文に到達できない**。
Vault は復号が DB 内で完結するため高権限ロールが平文を取れる。
BYOK は顧客資産を預かる性質上、内部者経路を狭く保つ方を採った。

## 3. 残っている追随

| タスク | 内容 | 状態 |
|---|---|---|
| **T-F-53** | Fernet 鍵ローテーション手順 (MultiFernet 併用 → 全行再暗号化 → 旧鍵撤去 + バックアップ) | 束 F で実施 |

## 4. 検証

- `03_architecture/selected-stack.json`: `byok_encryption.chosen` が Fernet を指す。
  `vault` の残存は `alternatives` と却下理由の 2 箇所のみ (chosen としての指定は無い)。
- 実装不変: `git diff` で `apps/api/src` に差分 0。
- BYOK 関連 pytest / `env-template-drift.py` が従来どおり green。
