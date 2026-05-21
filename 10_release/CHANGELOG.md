# Changelog

All notable changes to **Atelier** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), Versioning: [SemVer](https://semver.org/).

Versioning policy:
- `v0.x.y-mvp` — α 段階（内部 + 招待数社）
- `v0.5.x-beta` — β 段階（10 社招待制）
- `v1.x.y` — GA（一般公開）

## [Unreleased]

### Added
- Phase 0-7 完了（hearing → requirements → architecture → functional_breakdown → design → mockups → api-design → tasks）
- Phase 8 schedule-design 完了（二軸 Gantt + 15 営業日カレンダー）
- Phase 9 distributed-dev 完了（190 パッケージ + dispatcher + CI gate 10）
- 全 12 スキルに二軸時間表示ポリシー追加

### Planned
- v0.1.0-mvp 2026-06-10
- v0.5.0-beta 2026-06-15
- v1.0.0 2026-12-31

---

## [v0.1.0-mvp] — 2026-06-10（予定 / AI 並列モード）

### Added
- 33 画面 / 119 API 完全実装
- AI 社員 7 名稼働（tony/strange/thor/wanda/vision/tchalla/steve）
- 9 ステージワークフロー（hearing → 納品）
- F-CTX01 ハイブリッド文脈構築（チャット）
- F-IMP01 影響範囲解析（NetworkX）
- F-CUC01-04 継続更新サイクル
- F-J02 仕様徹底ループ（並列 5-10）
- F-DISP01 Hermes 互換 kanban_tools 7 ツール
- F-BRIDGE01 Atelier Bridge（Vibeyard fork）
- R-T08 クライアント別 JWT 完全分離
- BYOK + Claude プラン枠両対応
- AI 学習デフォルト OFF
- 監査ログ全 mutating API 書込
- 法令対応（個人情報保護法・特商法・利用規約・プライバシーポリシー）

### Security
- TLS 1.3 / HSTS
- Supabase Vault BYOK 暗号化
- RLS 越境試験 PASS（10 ゲート）

### Infrastructure
- Vercel + Fly.io 本番デプロイ
- Better Stack / Sentry / Langfuse 観測
- v3-gate.yml 10 種 auto-merge
- Bridge 配布（macOS .dmg / Linux .deb / Windows .msi / npm）

---

## [v0.5.0-beta] — 2026-06-15（予定）

### Added
- 招待制 10 社オンボーディング
- 価格表 v1（月額 ¥10,000/WS · 半額）
- オンボーディング動画 3 本 + ヘルプ記事 20 本
- jarvis チャット代行（キックオフ）

### Changed
- Sentry エラー集約強化
- プライバシー設計レビュー反映

---

## [v1.0.0] — 2026-12-31（予定 / GA）

### Added
- 一般公開（atelier.dev）
- Product Hunt 投稿
- AI 社員 10 名完全稼働（natasha / peter / jarvis Phase 2 起動）
- 営業 + カスタマーサクセス自動化（Atelier 自身が運用）
- 正規価格課金開始
- SOC2 Type1 監査開始

### KPI Target (M+90)
- 100 名 / 30 社
- MRR ¥3M
- Churn < 5%/月
- 売却査定 ¥1B
