# プロジェクト・クレデンシャルシークレット — 設計

## 目的
各プロジェクトの**機密データ（顧客/案件のAPIキー・パスワード・トークン・接続文字列）**を
暗号化保存し、AI社員/メンバーが必要時のみ安全に利用できる「シークレット」。

資料/ドキュメント(仕様書・議事録)は **ナレッジ側 (knowledge_*)** が担当。本シークレットは
**機密クレデンシャル専用**で責務を分離する。

## 既存資産との関係
- 既存 BYOK (byok_api_keys) は「ユーザー個人の LLM API キー」用。Fernet 暗号 + RLS の
  パターンを**流用**するが、本機能は **project_id 軸**で独立テーブルにする。
- 暗号化: cryptography.fernet.Fernet (既存 byok service と同方式)。
  鍵は環境変数 ATELIER_VAULT_ENCRYPTION_KEY (DB の外。漏洩しても鍵が無ければ復号不可)。

## データモデル: public.project_credentials
| カラム | 型 | 説明 |
|---|---|---|
| id | uuid PK | |
| project_id | uuid FK→projects | どのプロジェクトのシークレットか |
| name | text | 表示名 (例: "顧客Slack Bot Token") |
| kind | enum | api_key / password / token / connection_string / other |
| encrypted_value | text | Fernet 暗号化済 (平文は保存も応答もしない) |
| last4 | text(4) | 末尾4文字のみ平文保持 (一覧で ●●●●1a2b 表示用、任意) |
| created_by | uuid FK→users | |
| created_at / updated_at / deleted_at | timestamptz | soft delete |

## RLS (致命: 越境ゼロ)
- SELECT/INSERT/UPDATE/DELETE: project の workspace メンバーのみ
  (`project_id` の workspace ∈ current_user_workspaces())。
- service_role はバックエンド復号用にバイパス可。

## API: /projects/{project_id}/credentials
| method | path | 説明 |
|---|---|---|
| GET | /projects/{id}/credentials | 一覧 (値マスク。name/kind/last4/created_at のみ) |
| POST | /projects/{id}/credentials | 登録 (plaintext を暗号化保存、応答に平文なし) |
| PATCH | /projects/{id}/credentials/{cid} | name/kind 更新 (値は変えない) |
| DELETE | /projects/{id}/credentials/{cid} | soft delete |
| POST | /projects/{id}/credentials/{cid}/reveal | 復号 (権限者のみ・audit記録・要再認証推奨) |

全 mutating + reveal は audit_logs に記録 (誰がいつ復号したか)。

## 画面: S-B04 (プロジェクト・シークレットタブ)
- プロジェクト配下に「シークレット」タブ。一覧は値を ●●●● でマスク (name + kind + last4)。
- 「追加」フォーム: name / kind / value(入力時のみ、保存後は二度と表示しない)。
- 「表示」ボタン: reveal API を叩いて一時的に平文表示 (クリップボードコピー)。

## セキュリティ原則 (絶対)
1. 平文は API レスポンスに含めない (reveal を除く。reveal は監査+権限必須)。
2. 暗号鍵は DB の外 (env/KMS)。
3. 全 reveal/mutating を audit_logs に記録。
4. RLS で project workspace メンバーのみ (越境=0)。
5. AI 学習にシークレットデータを使わない (絶対ルール #6 準拠)。
