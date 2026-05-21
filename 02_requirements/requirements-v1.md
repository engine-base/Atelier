# Atelier要件定義書 v1.0
作成日：2026-05-18 ／ オーナー：高本まさと
ベータ開始：2026年6月 ／ 本格リリース：2026年8月

---

## 1. プロジェクト概要

AI社員（COO／部署リーダー／専門メンバーの三階層）が常駐し、ヒアリングから納品まで開発プロジェクトの全工程を一元管理する SaaS。クライアントはAIと対話するだけでプロジェクトを完走でき、運営者は1人で同時10案件以上を回せる属人性の低い体制を実現する。2-3年後の事業売却（〜10億円規模）を視野。

**成功定義**：2026年内100社/100名利用、SaaS課金開始、同時10案件並行運用。

**技術スタック**：Next.js + Supabase + TypeScript + Python FastAPI、Anthropic SDK + Claude Agent SDK + LangGraph + Inngest + Voyage AI + pgvector + LlamaIndex + Cognee + Whisper + Langfuse、HTML/JSON/MD三層出力、ローカル Claude Code ブリッジで 5-10 並列実行。

**OSS 流用方針（実装系の基盤）**：
- **Atelier Bridge デスクトップクライアント** = [Vibeyard](https://github.com/elirantutia/vibeyard) (MIT) を fork
  - 流用：pty-manager / claude-cli・codex-cli・gemini-cli 接続 / セッション再開 / カンバン UI / swarm モード
  - 追加：Atelier クラウド SSE 接続 / 9 工程ワークフロー連動 / AI 社員 Skill 自動注入
  - 削除：P2P セッション共有 / 埋め込みブラウザ
- **工程7 実装ディスパッチャ** = [Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT) の kanban パターンを FastAPI に port
  - 流用：`HERMES_KANBAN_TASK` env による worker spawn / git worktree 自動作成 / サーキットブレーカ / 構造化ハンドオフ (summary + metadata) / `kanban_show` `kanban_complete` `kanban_block` `kanban_unblock` 等の 7 ツール
  - タスクライフサイクル：**6 列モデル**（準備中 / 着手可 / 実装中 / 要対応 / 承認待ち / 完了）= Hermes 流 (Triage / Ready / In Progress / Blocked / Awaiting / Done)
- **Atelier 独自実装**：9 工程ワークフロー・AI 社員ペルソナ・F-CTX01 ハイブリッド文脈構築・F-IMP01 影響解析・F-CUC01-04 継続更新サイクル

## 2. ターゲットユーザー

5ペルソナ：ソロ受託開発者（メイン）／小規模受託会社経営者／個人開発者・スタートアップ／クライアント（招待モード）／運営管理者。

## 3. 主要機能一覧

A〜U の21カテゴリ。詳細は [requirements-v1.html](./requirements-v1.html) を参照。

## 4. 機能要件詳細

55機能を定義。詳細は [features.json](./features.json) と [bf_feature_spec.json](./bf_feature_spec.json) を参照。

**最重要機能：**
- **F-BRIDGE01 Atelier Bridge**：Vibeyard fork による Electron デスクトップクライアント、ローカル `claude` CLI を PTY 経由で並列起動、worktree 自動作成、Atelier クラウドへ SSE で進捗送信
- **F-DISP01 タスクディスパッチャ**：Hermes Agent port による FastAPI ディスパッチャ、`HERMES_KANBAN_TASK` env で worker 起動、依存解消で Ready 昇格、サーキットブレーカで再試行
- **F-I03 並列実行エンジン**：Bridge + ディスパッチャの組合せで 5-10 並列、バックグラウンド継続、Claude プラン認証共有
- **F-J02 仕様徹底ループ**：スコア計算（AC×0.6+Test×0.3+検証AI×0.1）、95%自動/80-94%承認/<80%強制介入、最大3回再試行
- **F-I05 /goal駆動実行モード**：タスクカード→ゴール文自動生成→Claude Code投入→自走
- **F-K01 ナレッジ管理基盤**：共通＋AI社員別の2層構造、プロジェクト跨ぎ再活用
- **F-S01 LLMClient抽象化レイヤー**：Phase 0必須、v2でGPT/Gemini追加対応

## 5. 非機能要件

パフォーマンス：チャット応答≤2秒、ダッシュボード≤3秒、RAG検索≤1秒。可用性：99%。セキュリティ：TLS 1.3、RLS、AES-256、Supabase Vault、監査ログ1年保持、Tokyo region推奨。

## 6. 画面・UX

一般20画面 + クライアント3画面 + 管理者6画面 = 約30画面。

## 7. データ構造

25エンティティ。詳細は [bf_feature_spec.json](./bf_feature_spec.json) を参照。

## 8. 外部連携

Anthropic API、Voyage AI、ローカルClaude Code、Inngest、Stripe（Phase 8）、GitHub（閲覧のみ）、Supabase、Resend/SendGrid、Whisper API、Langfuse、MCP Clients。

## 9. 法的考慮

特商法・個情法・消費者契約法・電気通信事業法（要確認）・著作権法・特定電子メール法・プロバイダ責任制限法・Anthropic利用規約。詳細は [bf_legal_requirements.json](./bf_legal_requirements.json)。

**重要事項**：電気通信事業届出は要否確認必須、AI学習デフォルトOFF、Supabase Tokyo region推奨。

## 10. リスク・懸念点

致命級リスク：RLS設計ミスでクライアント漏洩（R-T08）、個人情報漏洩（R-O05）、電気通信事業届出未提出（R-L01）。高リスク：Claude Codeブリッジ不安定性、仕様徹底ループ無限化、3ヶ月での全Phase完走の野心性。

## 11. 未確認事項

高優先：Claude CodeブリッジOAuth可否、電気通信事業届出要否、月額単価、無料枠設計、スコア計算式チューニング、AI学習デフォルト値。中優先：Supabaseリージョン、Whisper方式、デフォルト10名スキルセット、AI社員リリース名称（商標）。

## 12. スケジュール

| Phase | 期間 | 主要スコープ |
|---|---|---|
| Phase 0 | 5月下旬〜6月上旬 | 基盤・PoC |
| Phase 1 | 6月 | AI組織・スキル・チャット・MCP → ベータ開始 |
| Phase 2 | 6月下旬〜7月前半 | 工程ワークフロー・モック・招待・コメント |
| Phase 3 | 7月 | タスク・並列実行・/goal・仕様徹底ループ |
| Phase 4 | 7月下旬〜8月初旬 | ナレッジ・議事録・提案/見積/契約・cron・課金 |
| Phase 5 | 8月 | マルチLLM準備・Git・監査・法令・QA → 本格リリース |
| Phase 6+ | 9月以降 | オンボーディング・FB・ローカルLLM |

## 13. 改訂履歴

- v1.0（2026-05-18）：初版（ヒアリング→要件定義STEP7まで反映）

## 関連ファイル

- [requirements-v1.html](./requirements-v1.html) — クライアント提出用
- [features.json](./features.json) — 機能要件構造化データ
- [bf_feature_spec.json](./bf_feature_spec.json) — 下流スキル（task-decomposition等）向け
- [bf_legal_requirements.json](./bf_legal_requirements.json) — コンプライアンス監査用
- [decision_log_v1.json](./decision_log_v1.json) — 判断ログ・MCP連携用
- [step3_functional_spec.md](./step3_functional_spec.md) — STEP3詳細リファレンス

## 次のスキル

**`architecture-design`（アーキテクチャ設計）** に進む。
順序：requirements-definition → **architecture-design** → functional-breakdown → feature-decomposition → task-decomposition
