"""GAP-130: PC 操作 (approve モード) のライブ承認レジストリ。

Claude Code の permission prompt と同じ体験をチャットで実現する:
ツール実行の直前に SSE で承認カードを配信し、ユーザーが
POST /chat/pc-approvals/{id} で「許可 / 拒否」を返すまで実行を待つ。

設計メモ:
- レジストリは **プロセス内メモリ** (asyncio.Future)。agent_sdk モードは
  セルフホスト個人インスタンス専用 (uvicorn 単一プロセス) なので、
  SSE ストリームと決定 POST は必ず同一プロセスに着地する。
  マルチワーカー構成でこのモードを有効化してはならない (GAP-113 と同じ制約)。
- id は uuid4 (推測不能)。さらに resolve 時に user_id 一致を要求する
  (他ユーザーの承認 ID を握っても解決できない)。
- タイムアウト (既定 300 秒) は呼出側 (can_use_tool コールバック) が
  wait_for で適用し、時間切れは「拒否」として扱う (勝手に実行しない)。
"""

from __future__ import annotations

import asyncio
import os
import uuid
from dataclasses import dataclass
from typing import Any

TIMEOUT_ENV = "ATELIER_PC_APPROVAL_TIMEOUT_SECONDS"
DEFAULT_TIMEOUT_SECONDS = 300.0

# ツール入力の要約に含める最大文字数 (SSE カードの視認性優先)
_SUMMARY_MAX = 200


@dataclass
class PendingPcApproval:
    """承認待ち 1 件。future は "allow" / "deny" で解決される。"""

    id: str
    user_id: str
    thread_id: str
    tool: str
    summary: str
    future: asyncio.Future[str]


_pending: dict[str, PendingPcApproval] = {}


def approval_timeout_seconds(env: dict[str, str] | None = None) -> float:
    """承認待ちのタイムアウト秒 (env で調整可能、不正値は既定に落とす)。"""
    e = env if env is not None else dict(os.environ)
    raw = (e.get(TIMEOUT_ENV) or "").strip()
    if raw:
        try:
            value = float(raw)
            if value > 0:
                return value
        except ValueError:
            pass
    return DEFAULT_TIMEOUT_SECONDS


def summarize_tool_input(tool: str, tool_input: dict[str, Any]) -> str:
    """承認カードに出すツール入力の 1 行要約 (Claude Code の prompt 相当)。

    Bash はコマンド全文、ファイル系はパスを最優先で見せる —
    「何が実行されるのか」をユーザーが判断できる実値を出す。
    """
    if tool == "Bash":
        primary = tool_input.get("command")
    elif tool in ("Read", "Write", "Edit"):
        primary = tool_input.get("file_path")
    elif tool in ("Glob", "Grep"):
        primary = tool_input.get("pattern")
    else:
        primary = None
    if not isinstance(primary, str) or not primary:
        # フォールバック: 入力キーの列挙 (中身は出しすぎない)
        primary = ", ".join(sorted(tool_input.keys())) or "(入力なし)"
    if len(primary) > _SUMMARY_MAX:
        primary = primary[: _SUMMARY_MAX - 1] + "…"
    return primary


def create_request(*, user_id: str, thread_id: str, tool: str, summary: str) -> PendingPcApproval:
    """承認待ちを登録して返す (future は未解決)。"""
    loop = asyncio.get_running_loop()
    rec = PendingPcApproval(
        id=str(uuid.uuid4()),
        user_id=user_id,
        thread_id=thread_id,
        tool=tool,
        summary=summary,
        future=loop.create_future(),
    )
    _pending[rec.id] = rec
    return rec


def resolve_request(approval_id: str, *, user_id: str, decision: str) -> bool:
    """承認 ID を allow / deny で解決する。

    未登録 ID・他ユーザーの ID は False (呼出側は 404 にする)。
    既に解決済み (二重クリック等) でも True を返す (冪等)。
    """
    rec = _pending.get(approval_id)
    if rec is None or rec.user_id != user_id:
        return False
    if not rec.future.done():
        rec.future.set_result(decision)
    return True


def discard(approval_id: str) -> None:
    """レジストリから除去する (解決後・タイムアウト後の掃除)。"""
    _pending.pop(approval_id, None)


def pending_count() -> int:
    """現在の承認待ち件数 (テスト・診断用)。"""
    return len(_pending)
