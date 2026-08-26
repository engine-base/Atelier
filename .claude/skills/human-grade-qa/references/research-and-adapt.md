# Research & Adapt — 未知プロジェクトへの適応

「初めて見るスタック / 初めて見るドメイン」でも人間レベル QA を回せるよう、
**実行前にリサーチして自分の前提を更新する**。スキャンだけで計画を書くと、
フレームワーク固有の落とし穴・ドメイン固有の規制・ライブラリの既知バグを見落とす。

## なぜ調査が必要か

スキャンで分かるのは「何を使っているか」だけ。
**「そのフレームワーク／ライブラリで何が壊れやすいか」「そのドメインで何を検証すべきか」**
は外部知識が要る。例:

- Next.js 15 の App Router で `cookies()` を await 必須化 → セッション系で 5xx が増える
- Stripe v15+ で 3DS のフロー変更 → 既存 E2E が壊れる
- 医療系なら PHI ログ漏れチェックが必須（HIPAA）
- 教育系なら未成年保護（COPPA）でメール検証が違う
- pgvector の cosine と l2 で挙動差 → 検索の境界が変わる

## 調査の優先順位

| 順 | 道具 | 用途 |
|---|---|---|
| 1 | **Context7 MCP** (`mcp__context7__*`) | ライブラリ / フレームワークの公式ドキュメント |
| 2 | **WebSearch** | 最新版の breaking change、known issues、CVE |
| 3 | **WebFetch** | GitHub Releases / Changelog / Issue を直接読む |
| 4 | **gh search code / repos** | 同じ組合せの実装例、テスト例 |
| 5 | **既存 `.qa/runs/*/failures.md`** | 同プロジェクト過去 FAIL の再発防止 |
| 6 | **code-explorer agent** | プロジェクト内の暗黙ルール（独自バリデータ等） |

トレーニングデータに頼って書かない。**バージョンを特定して** ドキュメントを引く。

## 調査タイミング

### STEP 1.5（スキャン直後・計画前）

スキャン結果から **不確実点リスト** を抽出して調査キューに入れる:

- 主要フレームワーク × 検出バージョン
- 認証ライブラリ × 検出バージョン
- DB / ORM × 検出バージョン
- 決済 / OTP / 外部 API（必要なら）
- ドメイン（package.json description / README から推定）

各項目について 1-2 クエリを投げ、要点だけ計画書冒頭の「リサーチノート」に貼る。

### STEP 3（実行中・FAIL したとき）

落ちた API / ライブラリ / コンポーネントについて改めて検索:

- `<lib>@<version> <error message>`
- `<framework> <symptom> known issue`
- GitHub Issues で "is:open <キーワード>"

「既知バグだ」と分かったら回避策を `failures.md` に書く。

## ドメイン適応チェックリスト

スキャン直後に **ドメインを推定** し、ドメイン固有の検証カテゴリを追加する:

| ドメイン推定の手がかり | 追加カテゴリ |
|---|---|
| `auth / login / signup` がある | 認証強度・セッション固定・パスワード policy |
| 決済語彙（stripe, payment, checkout） | PCI / 3DS / 二重課金 / 返金 |
| 医療語彙（patient, ehr, hipaa） | PHI ログ漏れ / 監査ログ / アクセス制御 |
| 教育語彙（student, lesson, school） | 未成年保護 / 親同意 / 学齢制限 |
| 金融語彙（trade, balance, transfer） | 残高一貫性 / 順序保証 / 監査 |
| EC 語彙（cart, order, sku） | 在庫競合 / 価格改定中の注文 |
| SaaS multi-tenant | テナント分離 / クロステナントリーク |
| 位置情報 | 権限拒否時の挙動 / 精度劣化 |
| ファイル処理 | ファイル種別偽装 / 巨大ファイル / ウイルス |
| AI / LLM 機能 | プロンプトインジェクション / レート / コスト上限 / 幻覚許容 |

該当ドメインの **典型攻撃・典型バグ** を 1 度 web で調べる。「<domain> common bugs」「<domain> security checklist」程度の検索でも十分初動になる。

## フレームワーク適応の最小セット

検出したフレームワークごと、最低でも次を確認:

- **現在の最新版** と検出バージョンの差
- 直近の **breaking change**
- **既知の重大 Issue**（GitHub Issues open & 多 reaction）
- 公式の **テスト推奨パターン**

```text
クエリ例:
"<framework> <version> breaking changes"
"<framework> common pitfalls testing"
"<library> known issues site:github.com"
```

## ライブラリの version pin

`package.json` の `^` `~` は実環境で何になっているかを `package-lock.json` / `pnpm-lock.yaml` から確認。
ドキュメントは **実環境のバージョン** に合わせて引く。

## リサーチノートの保存

`.qa/plans/<plan>/research.md` に以下を残す:

```markdown
## Stack
- Next.js 15.0.3 (App Router)
- next-auth 5.0.0-beta.20
- Prisma 5.22 / Postgres 16
- Stripe 17.3
- Domain: B2C ヘルスケア（PHI 取扱い）

## Notes
- Next.js 15: `cookies()` / `headers()` は async 化済 → セッション get で await 漏れに注意
- next-auth v5 beta: redirect callback の戻り型が string|null 変更
- Stripe 17: setupIntent の `next_action` 型が拡張
- 医療: PHI を console.log / API error body に出さない（HIPAA §164.312）
- Postgres 16: ICU collation がデフォ → 並び順テストに注意

## 参照
- https://nextjs.org/docs/app/building-your-application/upgrading/version-15
- https://github.com/nextauthjs/next-auth/releases/tag/v5.0.0-beta.20
- ...
```

このノートを参照しながら計画書を書くと、フレームワーク特有の TC を自然に組み込める。

## 「分からない」を残す

調査しても確信が持てない箇所は **計画書に "ASSUMPTION" タグで残す**:

```markdown
- ASSUMPTION: Next.js 15 で `cookies()` を await し忘れていない（実コードで再確認）
```

ASSUMPTION は実行中に必ず潰す（コード参照 or 動作確認）。

## NG

- トレーニングデータの記憶で「たぶん〜」で計画を書く → 必ず公式ドキュメントを当てる
- 「最新バージョン」を仮定する → lock ファイルから確定
- ドメイン無視で汎用テストだけ → ドメイン固有の規制 / 既知パターンを必ず追加
- 1 回調べて固定する → FAIL が出たら都度追加調査
