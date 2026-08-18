# ADR-020: Vault 暗号鍵の管理方針 (Fernet 継続 + 段階的 KMS 移行)

- **Status**: Accepted
- **Date**: 2026-08-18
- **Decider**: 経営者 (S-E01 チャット合意「完璧にしたい。セキュリティが大丈夫で、かつ鍵をしっかり使える状態に」) + 実装 AI
- **Category**: security / architecture
- **Related**: GAP-131, docs/vault-key-operations.md, docs/project-vault-design.md

## 文脈

project_credentials (プロジェクト・シークレット) は顧客・案件の API キー /
パスワード / トークン / 接続文字列を保管する。従来の実装 (T-A-46/T-D-36) は
以下の状態だった:

- 暗号化: 単鍵 Fernet (`ATELIER_VAULT_ENCRYPTION_KEY` env)。鍵は DB の外、
  平文は保存も応答もしない、reveal は監査付き単一経路 — 骨格は正しい
- 弱点 4 つ:
  1. BYOK に存在する **列レベル revoke** (ciphertext を authenticated から
     SELECT 不可にする) が vault に無い
  2. **鍵ローテーション手段が無い** (単鍵 = 鍵を失うと全シークレット復号不能、
     鍵を替えるには手作業で全行再暗号化)
  3. **reveal に再認証が無い** (セッション奪取 = 全シークレット吸い出し可)
  4. **AI エージェントがシェルを実行できるホストでは、.env の鍵 + DB 接続で
     構造的に全復号できる** (SECRETS.md の運用ルールで守っているだけ)

過去に「Supabase Vault を使うか Fernet か」の裁定があり Fernet 採用と
なった経緯があるが、その裁定文書とローテーション手順が main に入っていな
かった。本 ADR がその裁定を main に正式に残すものである。

## 決定

**セルフホスト個人インスタンスでは MultiFernet (アプリ層暗号化) を正式採用し、
弱点 1〜3 を GAP-131 で実装して塞ぐ。弱点 4 (鍵をアプリから取り上げる) は
KMS 化が唯一の構造的解であり、ホスト版 (顧客提供の本番) の必須要件とする。**

### 今回実装 (GAP-131)

1. **列レベル revoke**: `encrypted_value` を authenticated/anon から SELECT
   不可にし、非機密列のみ列 grant (BYOK t-d-95 と同一パターン)。ciphertext は
   reveal の service セッションだけが読める
2. **MultiFernet 鍵ローテーション**: `ATELIER_VAULT_ENCRYPTION_KEYS`
   (カンマ区切り、先頭=暗号化・全鍵=復号)。再暗号化は
   `apps/api/scripts/rotate_vault_key.py` (dry-run 付き・復号不能行は skip 報告)。
   旧 `ATELIER_VAULT_ENCRYPTION_KEY` は後方互換で継続動作
3. **reveal 再認証**: ログインパスワード再入力 (signin と同一検証経路) +
   成功後 TTL 300 秒は省略可 + 10 回/分/ユーザーのレート制限 + 失敗の監査
   (`credential.reveal_denied`)
4. **運用文書**: ローテ手順・鍵喪失時手順・dev/prod 鍵分離 (AI が触るホストに
   本番鍵を置かない)・監査の見方 → docs/vault-key-operations.md

### セルフホストで KMS を今やらない理由

- AWS/GCP KMS はクラウド契約・ネットワーク到達性・課金をセルフホスト
  個人ユーザーに要求する。「ローカルで完結・課金ゼロ」の製品方針と衝突する
- Supabase Vault はセルフホスト Postgres では拡張の導入・管理が必要になり、
  鍵の実体が DB サーバーと同居する (「アプリから取り上げる」効果が薄い)
- セルフホストの脅威モデルでは「本番鍵を AI の触るホストに置かない」運用
  分離が費用対効果で最も効く (vault-key-operations.md に明文化)

### ホスト版 (顧客提供の本番) の必須要件

ホスト版を出す前に以下を実装すること (このままリリースしてはならない):

- **エンベロープ暗号化**: 行ごとのデータキーを KMS のマスターキーで包む。
  ローテはマスターキー差し替えのみで全行再暗号化が不要になる
- **鍵はアプリから不可視**: アプリは KMS に復号を依頼するだけ。ホストの
  .env を読まれても復号できない構造にする (弱点 4 の構造的解)
- 候補: AWS KMS / GCP Cloud KMS / HashiCorp Vault。選定は導入時の
  ホスティング先に合わせて別 ADR で裁定する

## 帰結

- 良: 鍵ローテが無停止で可能になり「鍵を失う = 顧客データ全喪失」の単一
  障害点が解消 (移行期は新旧併用)。ciphertext の露出面が BYOK と同水準に
  揃い、セッション奪取だけでは吸い出せなくなる
- 悪: reveal に 1 回のパスワード入力が増える (TTL で緩和)。マルチワーカー
  構成では再認証 TTL がワーカー毎になる (緩くはならない — 厳しくなる側)
- 負債として明示: セルフホストの AI 同居ホストでは依然として運用分離が
  前提。構造的遮断はホスト版 KMS 化まで存在しない
