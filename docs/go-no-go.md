# 本番リリース go/no-go 判定 (T-I-24 致命級)

Atelier の本番リリースは **致命級ゲート**であり、AI 単独での判断は禁止
(CLAUDE.md 絶対ルール #7)。本ドキュメントは **経営者最終承認**のための
チェックリスト + 判定マトリクスを提供する。

## 依存と前提

このリリース判定は以下の全 23 タスクの完了を前提とする (T-I-24 の depends_on):

```
T-I-01..18: E2E + RLS 越境 + Lighthouse + a11y + 統合・ストレス試験
T-I-19:     dead code cleanup
T-I-21:     DNS/SSL/カスタムドメイン
T-I-22:     監視ダッシュボード (Better Stack + Sentry)
T-I-23:     ロールバック手順書 + 自動化スクリプト
```

加えて以下の **致命級ゲート 2 つ** も完了済であること:

| ID | 内容 | 承認者 | 完了時 |
|---|---|---|---|
| T-D-22 | R-T08 RLS 設計レビュー | 経営者 (3h) | Wave 2 で完了 (R-T08 承認扱いで実装、越境試験 PASS 必須) |
| T-A-45 | API 契約凍結 | 経営者 (2h) | Wave 2 で完了 (OpenAPI 凍結、Gate #5/#7/#8/#9 PASS) |

## 1. 自動 gate (release-gate.sh)

```bash
./scripts/release-gate.sh --release-tag <tag>
```

以下 7 group をまとめて検証し、いずれか fail なら exit 1:

| Group | 内容 | gate |
|---|---|---|
| A | tickets.json 整合性 | Gate #2 |
| B | 静的解析 (lint/type/drift/stack/gap) | Gate #1/#3/#7/#12/#13 |
| C | ローカル test (vitest) | Gate #4 入力 |
| D | 契約整合 (openapi.yaml + 生成物) | Gate #5/#6/#7/#8/#9 入力 |
| E | **R-T08 致命級** (構成 + 越境試験) | Gate #10 |
| F | 本番準備 (docs + 監視 sanity) | T-I-21/22/23 |
| G | CI workflow 構成 | T-F-07 |

**`./scripts/release-gate.sh` exit 0 が必須**。これ以外の状態でのデプロイは禁止。

## 2. 経営者最終承認チェックリスト

`release-gate.sh` PASS 後、以下のチェックリスト全てに ✓ が付くまでデプロイ禁止。

### 2.1 CI/CD

- [ ] **main ブランチの最新 commit で v3-gate 全 13 gate PASS** (GitHub Actions で目視確認)
- [ ] 直近 7 日間で main への merge は全て v3-gate PASS のもの (force-merge 無し)
- [ ] Gate #10 RLS isolation matrix が最新 main で PASS
- [ ] Gate #11 PR scope guard が最新 main で PASS
- [ ] Gate #4 coverage ≥ 80% on touched files が最新 main で PASS

### 2.2 致命級ゲート

- [ ] R-T08 越境試験 (T-I-05..08) を Postgres ありで実走し全 PASS
  - `cd apps/api && ATELIER_TEST_PG_URL=... uv run pytest tests/rls/ -v`
- [ ] T-A-45 OpenAPI 凍結後、契約変更 PR は別途凍結解除 PR で承認済 (差分監査)
- [ ] **本ドキュメント T-I-24 の自動 gate が PASS** (exit 0)

### 2.3 監視・運用

- [ ] Better Stack の uptime monitor (web/api/client) が **全 GREEN** で 24h 以上継続
- [ ] Sentry の直近 24h で新規 issue が **0 件**、既存 issue は全て resolved または won't-fix
- [ ] PagerDuty の on-call rotation が当週分セット済
- [ ] `./scripts/check-monitoring.sh` が exit 0
- [ ] `./scripts/rollback.sh --dry-run` が正常終了 (ロールバック手順実行可能)

### 2.4 法的・ポリシー

- [ ] 利用規約 (S-PUB01)・プライバシーポリシー (S-PUB02)・特商法 (S-PUB03)・データ削除 (S-PUB04) が本番 URL で公開済
- [ ] AI 学習 default OFF (F-LEGAL-005) の表記が利用規約・プラポリ両方にある
- [ ] 30 日 grace + hard delete (F-LEGAL-007) の表記が S-PUB04 にある
- [ ] DMARC / SPF / DKIM が設定済 (`dig TXT atelier.example`)

### 2.5 ステークホルダー承認

- [ ] **経営者承認**: 本リリースで進めることに署名 (Slack `#alerts` に承認スレッド + 経営者発言)
- [ ] **PdM/PjM 承認**: リリースノートとリリースタイミングを承認
- [ ] **SRE 承認**: 監視・ロールバック手順の準備完了を承認
- [ ] **法務承認** (顧客契約に影響する場合のみ): 規約変更がある場合は同意フロー (consents) 確認

## 3. デプロイ実行

全 ✓ 確認後、以下の順序でデプロイ:

```bash
# 1. main を最新化
git checkout main && git pull origin main

# 2. release-gate を最終確認
./scripts/release-gate.sh --release-tag v1.0.0

# 3. tag 打ち
git tag -a v1.0.0 -m "production release v1.0.0"
git push origin v1.0.0

# 4. CI が deploy workflow を起動 (.github/workflows/deploy.yml)
#    deploy 後の自動 smoke test が PASS することを確認

# 5. 監視ダッシュボードで 1h 観察 (RUM / error rate / latency)
```

## 4. ロールバック発動基準

デプロイ後 24h 以内に以下のいずれかが発生したら **30 分以内に rollback 開始**:

| 指標 | しきい値 |
|---|---|
| Sentry error rate | デプロイ前 baseline の 10x 超 |
| Uptime monitor | 3 endpoint のうち 1 つでも 5 分連続 fail |
| API p95 latency | 2 連続 1 分 window が 3 秒超 |
| DB pool 枯渇 | connections > 95% を 1 分継続 |
| **R-T08 違反** | 越境試験 fail (即時) |

ロールバック手順は [`rollback-runbook.md`](./rollback-runbook.md) と
[`scripts/rollback.sh`](../scripts/rollback.sh) を参照。

## 5. ポストモーテム

リリース後 (rollback 有無に関わらず) 7 日以内に postmortem を作成:

- リリース内容と影響範囲
- 発生事象とタイムライン (発生があれば)
- 検出方法 (どの monitor が catch したか)
- 根本原因
- 再発防止策 (CI gate 追加 / monitor 追加 / 検証手順追加)
- 次回リリースへの改善提案

ポストモーテムは `09_dispatch/postmortems/<date>-release-v<ver>.md` に置く。

---

**本ドキュメントは Atelier 本番リリースの最終承認手順を定める唯一の信頼源**
(CLAUDE.md 絶対ルール #1 を踏襲)。このチェックリストを満たさないデプロイは
無効とし、即時 rollback を実施する。
