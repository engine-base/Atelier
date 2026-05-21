# Atelier リリース計画書（v3.1-dual / 二軸対応）

- 信頼源: [`release-plan.json`](./release-plan.json)
- HTML 版: [`RELEASE-PLAN.html`](./RELEASE-PLAN.html)（タイムライン + トグル）
- CHANGELOG: [`CHANGELOG.md`](./CHANGELOG.md)
- 上流: [`08_schedule/SCHEDULE.html`](../08_schedule/SCHEDULE.html) / [`09_dispatch/PACKAGES.html`](../09_dispatch/PACKAGES.html)

## 3 段階リリース（二軸日付）

| ステージ | version | AI 並列 | Human | 規模 | 主目的 |
|---|---|---|---|---|---|
| 🚀 **MVP (α)** | v0.1.0-mvp | **2026-06-10 水** | 2026-11-15 | 内部 + 5-10 社 | 動作確認 / フィードバック |
| **β** | v0.5.0-beta | **2026-06-15 月** | 2026-12-01 | 招待制 10 社 | 価格検証 / NPS |
| **GA** | v1.0.0 | **2026-12-31 木** | 2027-08-31 | 一般公開 | 100 ユーザー / ¥3M MRR |

## MVP リリースゲート（2026-06-10 06:00 デプロイ）

```
□ v3-gate.yml 10/10 PASS
□ T-I-24 本番リリース判定 AC 全 PASS
□ 経営者 go/no-go (前日 2h)
□ Bridge 配布パッケージ (.dmg/.deb/.msi/npm) 署名済
□ 監視ダッシュボード稼働
□ ロールバック手順書整備
□ DB バックアップ取得
□ DNS / SSL 確認
```

### Day 16 タイムライン
| 時刻 | アクション | 担当 |
|---|---|---|
| 06:00 | feature flag MVP_LAUNCH ON | 経営者 |
| 06:05 | Vercel + Fly.io 本番 deploy | tony |
| 06:10 | smoke test（5 分） | vision |
| 06:15 | Bridge DL ページ公開 | tony |
| 06:20 | 招待リンク 5-10 社送付 | 経営者 |
| 07:00 | 1h 運用ステータス確認 | vision |
| 12:00 | 半日レビュー | 経営者 + vision |
| 18:00 | 1 日レビュー → 自動監視移行 | vision |

## β オンボーディング SOP（10 社 / 6 営業日後）

```
1. 招待リンク発行（クライアント別 JWT・R-T08 保護・7 日有効）
2. キックオフコール 30 分/社（経営者 or AI 社員 jarvis 代行）
3. 利用規約 + 個別契約締結（規約版数を audit_logs に記録）
4. オンボーディング教材
   - 動画 3 本（各 10 分以内）
   - ヘルプセンター記事 20 本
5. 1 週間後フォローアップ（自動メール + jarvis チャット）
6. β 終了時アンケート + NPS
```

### β KPI
| 指標 | 目標 |
|---|---:|
| 継続利用（10 社中） | ≥ 8 |
| 重大障害（P0/P1）| 0 |
| 完走率（9 ステージ） | ≥ 70% |
| NPS | ≥ 40 |
| 工数削減実感 | ≥ 5× |

### β 価格
月額 **¥10,000 / WS**（半額）or **無料**

## GA マーケティングカウントダウン

| M-N | アクション |
|---|---|
| M-30 (12-01) | LP 公開 (atelier.dev) + β 体験談 5 本 |
| M-21 (12-10) | note/Zenn 開発記事連載 (週 2 本) |
| M-14 (12-17) | Twitter/X 告知開始 |
| M-7 (12-24) | Product Hunt ティザー |
| M-3 (12-28) | PH 投稿予告 + メーカー枠確保 |
| M-1 (12-30) | ローンチメール |
| **M-0 (12-31)** | **Product Hunt 投稿 00:01 PST + 全チャネル告知** |
| M+1 (1-01) | 24h レビュー |
| M+7 (1-07) | 初週 KPI レビュー |

### GA KPI (M+90 / 2027-03-31)
| 指標 | 目標 |
|---|---:|
| ユーザー数 | **100 名 / 30 社** |
| MRR | **¥3,000,000** |
| Churn | < 5% / 月 |
| NPS | ≥ 50 |
| 売却査定 | **¥1B** (10-15× ARR) |

## 自動ロールバック条件

| メトリクス | 閾値 | 窓 |
|---|---|---:|
| error_rate | > 5% | 5 分 |
| p95 latency | > 5s | 10 分 |
| auth_success_rate | < 95% | 10 分 |
| db connection errors | > 10/min | 1 分 |

→ Vercel + Fly.io 直前 deploy に自動 revert + S-E01 通知

## 障害対応 SOP（24/7）

| 重度 | 検知 → 通知 | 初動 | RTO |
|---|---|---|---:|
| **P0** 全停止 | 監視自動 → S-E01 + SMS | 即時ロールバック | 30 分 |
| **P1** 主要停止 | 監視自動 → S-E01 | feature flag OFF | 2h |
| **P2** 部分不具合 | ユーザー報告 | hotfix branch | 24h |
| **P3** 軽微 | 起票 | 通常タスク化 | 1 週 |

## セキュリティ・コンプライアンス

### MVP 時点
- TLS 1.3 / HSTS
- Supabase Vault による BYOK 暗号化
- 監査ログ全 mutating API に書込
- RLS 越境試験 PASS（R-T08 含む）
- 個人情報保護法 + 特商法表記公開
- AI 学習デフォルト OFF

### β 時点（追加）
- Sentry エラー集約
- プライバシー設計レビュー
- データ削除請求フロー（F-LEGAL-002）
- 退会 30 日猶予フロー

### GA 時点（追加）
- SOC2 Type1 監査開始 or 取得
- ISO 27001 検討
- ペネトレーションテスト 1 回
- 脆弱性開示プログラム

## CHANGELOG ワークフロー

```
conventional commits
   ↓
release-please bot → PR 作成
   ↓
AI 社員 jarvis → CHANGELOG.md ドラフト
   ↓
S-E01 で 経営者 1 クリック承認
   ↓
git tag v<x.y.z> + GitHub Release
   ↓
配信チャネル自動告知（X / メール / Product Hunt）
```

## 次に接続するスキル

- **sprint-planning**: Wave = Sprint の運営設計
- **test-verification**: 実装中・実装後の品質保証
- **integration**: Wave 5 統合テスト
