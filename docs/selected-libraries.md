# 選定 OSS / ライブラリ（正準）

> spec-sync の add-feature playbook が参照する OSS 評価の正準台帳。
> 新規モジュール採用時はここに「第一候補・ライセンス・セルフホスト可否・採用判断」を追記する。

## デザイン / モック生成

### Open Design（nexu-io/open-design）— 採用（デザイン領域は直接活用）

| 項目 | 内容 |
|---|---|
| リポジトリ | https://github.com/nexu-io/open-design |
| ライセンス | **Apache-2.0**（商用可・改変可・NOTICE 保持のみ） |
| 規模/活性 | 72k★・TypeScript・継続更新中 |
| 何か | **Local-first, open-source Claude Design alternative**。SKILL.md+DESIGN.md+agent(子プロセス)+sandboxed iframe+MCP で、自然言語 brief → HTML/PDF/PPTX/MP4/プロトタイプ/スライド/動画を生成。BYOK。 |
| 配布 | macOS/Windows デスクトップ + Web UI(Next.js, Docker) + CLI + MCP server |
| AI ランタイム | **自前 LLM 無し**。導入済みコーディングエージェント CLI(Claude Code 等)を daemon が起動、または BYOK プロキシ |
| チャット/記憶 | チャットは**デザイン反復にスコープ**。SQLite に conversations/messages/tabs を永続(基本的な状態管理あり)。記憶は**デザイン資産の学習**(会話 RAG ではない) |

**採用判断（decision_log 参照）**
- **デザイン/モック生成**: **そのまま活用**（重なり 100%・即戦力・低リスク）。出力 HTML を `06_mockups/` へ、表示は S-H01、コメントは F-015。
- **Atelier コアエンジン**: **丸ごとフォークしない**。理由 = Atelier が欲しい「クラウド多テナント・RLS(R-T08)・プロジェクト記憶のエージェント実行基盤」を Open Design は持たず（ローカル単一ユーザー/CLI subprocess/SQLite/デザイン特化）、流用できる重なりは チャットUI / skill-loader / MCP / iframe パターンに限られる。
- **コア実行基盤は Atelier 自前**（LangGraph + Postgres + RLS）で構築し、**Open Design は参照アーキ + 部品つまみ食い**として活用する。

**評価した代替**
- Onlook（OSS, React 用ビジュアル+AI 編集）/ Sandpack+Claude 自前（軽量な編集+プレビュー）/ OpenUI / bolt.diy / Penpot(OSS Figma・実コード編集ではない)。→ Claude design 同型・実働・スタック一致の点で Open Design が最有力。

## 参考: コア AI スタック（既存・selected-stack.json 準拠）

| 用途 | 採用 |
|---|---|
| LLM | Anthropic SDK + Claude Agent SDK |
| エージェント基盤 | LangGraph（自前・コアエンジン） |
| 埋め込み | Voyage AI（voyage-3-large） |
| ベクトル検索 | pgvector + HNSW（Supabase） |
| MCP | 自前 MCP サーバ（Open Design の MCP パターンを参照） |
