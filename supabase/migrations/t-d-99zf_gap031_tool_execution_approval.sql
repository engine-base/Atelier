-- GAP-031①: チャットのツール実行に人間承認ゲート (S-E01 「承認して実行」)
--
-- 書込系ツール (save_deliverable 等) は自動実行せず approval_inbox に
-- type='tool_execution' で登録し、人間の「承認して実行」で初めて実行する。
-- target_type は分岐元スレッドを指す 'chat_thread' を許可する。
--
-- NOTE: ALTER TYPE ... ADD VALUE は transaction block 外。IF NOT EXISTS で冪等。

alter type public.approval_inbox_type_enum add value if not exists 'tool_execution';

alter table public.approval_inbox
  drop constraint if exists approval_inbox_target_type_valid;
alter table public.approval_inbox
  add constraint approval_inbox_target_type_valid
  check (
    target_type in (
      'task', 'phase', 'knowledge_node', 'comment', 'scope_change', 'project', 'chat_thread'
    )
  );
