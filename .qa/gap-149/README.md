# GAP-149: AI 社員間の会話引き継ぎ — プロジェクト内他スレッド要約の横断注入

## 経営者質問

「セッションは各 AI 社員ごとに作られるの？同じプロジェクトでも違う AI 社員なら
元々していた会話は引き継がれないのか？？」

## 事実と対処

- チャットスレッドは **project × AI 社員** ごと (chat_threads.ai_employee_id)。
  従来は社員をまたぐと会話は引き継がれなかった (プロジェクト基本情報のみ共有)。
- GAP-149: GAP-132 のローリング要約 (chat_threads.context_summary) を横断利用し、
  **同一プロジェクトの他スレッド (他の社員との会話) の要約を全チャットの
  system prompt に自動注入** (`_peer_thread_summaries` — 最新 4 スレッド ×
  各 500 字、実在する要約のみ・推測で埋めない)。
  → どの社員に話しかけても「他の社員と何を決めたか」を知った状態で応答する。

## テスト

tests/routes/test_chat_sse.py::test_gap149_peer_thread_summaries_injected —
別社員 (ワンダ) のスレッド要約「メインカラーは紺に決定」が、トニーとの
会話の context-preview (実 system prompt) に載ることを実証。suite 12 PASS。
