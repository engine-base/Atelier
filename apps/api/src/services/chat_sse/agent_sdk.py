# pyright: reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnknownMemberType=false
# (claude-agent-sdk は optional dep で CI 環境に無く import が Unknown になるため。
#  src/mcp/server.py の mcp SDK と同じ抑制方針)
"""GAP-113: Claude サブスクリプション (Agent SDK) チャットアダプタ。

S-E01 チャットの LLM 呼出を、Anthropic API (従量課金) ではなく
**オーナー自身の Claude サブスクリプション** (Claude Code / Agent SDK 認証) で
行うための opt-in プロバイダ。

規約上の位置づけ (2026-08 時点の公式ヘルプに基づく):
- Agent SDK のサブスク認証は「自分のプロンプト・自分の仕事だけを処理する
  パーソナルユース」に限り許可される。
- したがって本モードは **セルフホスト個人インスタンス専用**。ホスト版 (顧客が
  使う本番) では有効化してはならない — そちらは BYOK / 運営 API キーを使う。
- 有効化は環境変数 `ATELIER_LLM_PROVIDER=agent_sdk` の明示 opt-in のみ。
  既定 (未設定) では従来どおり Anthropic API 経路。

動作要件 (実行ホスト側):
- `claude` CLI がインストールされ、サブスクアカウントでログイン済みであること
  (または `claude setup-token` で発行した CLAUDE_CODE_OAUTH_TOKEN が env にあること)。
- `claude-agent-sdk` (PyPI) がインストール済みであること。optional dep のため
  未インストール環境 (CI 等) でも本モジュールの import 自体は成功する (遅延 import —
  src/mcp/server.py の mcp SDK と同じ方針)。

v1 の制限 (誠実表示: 隠さず gap-tracker GAP-113 に記録):
- Atelier ツール (save_deliverable 等の agentic ループ) は本モードでは未注入。
  テキスト応答 + RAG/ペルソナ文脈のみ。ツール実行が必要な会話は API 経路を使う。
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

PROVIDER_ENV = "ATELIER_LLM_PROVIDER"
MODEL_ENV = "ATELIER_AGENT_SDK_MODEL"
WORKSPACE_ENV = "ATELIER_CHAT_WORKSPACE"

# opt-in と認識する値 (小文字比較)。既定・空・"anthropic" は従来経路。
_SUBSCRIPTION_VALUES = frozenset({"agent_sdk", "claude_subscription", "subscription"})

# GAP-129: auto/approve モードで使う Claude Code ツール (ローカル作業一式)。
# チャット既定 (off) では従来どおり一切許可しない。
_AUTO_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]

# GAP-130: 承認カードを挟むモードで「ユーザーに聞くことを許すツール」。
# ここに無いツール (WebSearch / Task 等) の許可要求は問答無用で拒否する。
_APPROVABLE_TOOLS = frozenset(_AUTO_TOOLS)


def chat_workspace_dir(env: dict[str, str] | None = None) -> str:
    """auto モードの作業フォルダ (成果物の保存先)。

    既定は ~/AtelierChatWork。ATELIER_CHAT_WORKSPACE で変更可能。
    チャットの PC 操作をこのフォルダ配下に限定する意図はカレントディレクトリ
    としての誘導であり、強制サンドボックスではない (auto は本人 opt-in)。
    """
    e = env if env is not None else dict(os.environ)
    configured = (e.get(WORKSPACE_ENV) or "").strip()
    return configured or str(Path.home() / "AtelierChatWork")


def build_options_kwargs(
    *,
    system_prompt: str,
    tools_mode: str = "off",
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """ClaudeAgentOptions に渡す kwargs を組み立てる (テスト可能な純粋部分)。

    GAP-129/130: tools_mode
      - "off"  (既定): ツール一切なし・1 往復のみ (従来のチャット挙動)
      - "auto": Claude Code 同等のローカル作業ツールを許可し、確認なしで
        自動実行する (Claude Code の bypassPermissions と同じ)。作業フォルダ
        (chat_workspace_dir) をカレントにして起動する。
      - "approve": ツール実行のたびにユーザーへ承認カードを出し、許可された
        ものだけ実行する (Claude Code の既定 permission prompt と同じ)。
        許可判定は can_use_tool コールバック (呼出側で注入) が担う —
        allowed_tools には載せない (載せると聞かずに自動許可されてしまう)。
    """
    kwargs: dict[str, Any] = {
        "system_prompt": system_prompt,
        "allowed_tools": [],
        "max_turns": 1,
        "include_partial_messages": True,
        # GAP-132: ホストの CLAUDE.md / ~/.claude 設定を子 CLI に読ませない。
        # 読ませると API 実行ディレクトリ (リポジトリ) のプロジェクト指示や
        # 個人設定がチャット応答・要約に混入する (実測: 要約に CLAUDE.md の
        # 実装ルールが紛れ込んだ)。Atelier の文脈は system_prompt が全て。
        "setting_sources": [],
    }
    if tools_mode in ("auto", "approve"):
        workspace = chat_workspace_dir(env)
        kwargs.update(
            {
                "system_prompt": system_prompt
                + "\n\nあなたはローカル作業ツール (ファイルの読み書き・コマンド実行) を使えます。"
                + "ファイルの作成・編集はカレントの作業フォルダ内で行い、"
                + "作ったファイルは絶対パスで報告してください。"
                + (
                    "\nツールの実行はユーザーの承認制です。拒否された場合は無理に別の"
                    "手段で実行せず、拒否されたことを踏まえて応答してください。"
                    if tools_mode == "approve"
                    else ""
                ),
                "cwd": workspace,
                "max_turns": 25,
            }
        )
        if tools_mode == "auto":
            kwargs.update(
                {
                    "allowed_tools": list(_AUTO_TOOLS),
                    "permission_mode": "bypassPermissions",
                }
            )
        else:
            kwargs["permission_mode"] = "default"
    model = (env if env is not None else dict(os.environ)).get(MODEL_ENV, "").strip()
    if model:
        kwargs["model"] = model
    return kwargs


def subscription_mode_enabled() -> bool:
    """サーバー内のサブスク実行 (agent_sdk) モードか。

    GAP-178: 判定は llm_route.resolve_llm_route() 1 か所に集約した。
    """
    from .llm_route import resolve_llm_route

    return resolve_llm_route().route == "agent_sdk"


def sdk_available() -> bool:
    """claude-agent-sdk が import 可能か (未導入 CI では False)。"""
    try:
        import claude_agent_sdk  # noqa: F401  # pyright: ignore[reportMissingImports,reportUnusedImport]
    except Exception:
        return False
    return True


def fold_prompt(history: list[tuple[str, str]], user_message: str) -> str:
    """history + 新規メッセージを単一プロンプトに畳む。

    Agent SDK の query() は単発プロンプト I/F のため、直近履歴をテキストで
    前置する (API 経路の messages 配列と同じ情報量を保つ)。
    """
    if not history:
        return user_message
    lines: list[str] = ["これまでの会話:"]
    for role, content in history:
        if role in ("user", "assistant"):
            label = "ユーザー" if role == "user" else "アシスタント"
            lines.append(f"[{label}] {content}")
    lines.append("")
    lines.append(f"新しいユーザーメッセージ (これに応答する): {user_message}")
    return "\n".join(lines)


def _subprocess_env() -> dict[str, str]:
    """CLI 子プロセスへ渡す env。

    ANTHROPIC_API_KEY を必ず除外する — 残っていると OAuth より優先されて
    **黙って API 従量課金に切り替わる** (flow-kit の ccstart.sh:113 と同じ理由)。
    同系統の ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_API_KEY も外す。
    """
    drop = {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_API_KEY"}
    return {k: v for k, v in os.environ.items() if k not in drop}


def make_pc_can_use_tool(
    *,
    user_id: str,
    thread_id: str,
    events: Any,
    allow_result: Any,
    deny_result: Any,
    timeout_seconds: float | None = None,
) -> Any:
    """GAP-130: approve モード用の can_use_tool コールバックを組み立てる。

    SDK の PermissionResult 型はファクトリ (allow_result / deny_result) として
    注入する — claude-agent-sdk 不在の CI でも本ロジックを実テストできる。
    events (asyncio.Queue) には以下を put する (SSE 配信は呼出側が行う):
      ("approval", {"id", "tool", "summary"})   … 承認カードの表示要求
      ("resolved", {"id", "decision"})          … カードの解決 (掃除用)
    決定が来ない場合はタイムアウトで **拒否** に倒す (勝手に実行しない)。
    """
    import asyncio

    from . import pc_approvals

    async def can_use_tool(tool_name: str, tool_input: dict[str, Any], _context: Any) -> Any:
        if tool_name not in _APPROVABLE_TOOLS:
            return deny_result(f"このツールはチャットからは許可されていません: {tool_name}")
        rec = pc_approvals.create_request(
            user_id=user_id,
            thread_id=thread_id,
            tool=tool_name,
            summary=pc_approvals.summarize_tool_input(tool_name, tool_input),
        )
        await events.put(("approval", {"id": rec.id, "tool": rec.tool, "summary": rec.summary}))
        timeout = (
            timeout_seconds
            if timeout_seconds is not None
            else pc_approvals.approval_timeout_seconds()
        )
        try:
            decision = await asyncio.wait_for(rec.future, timeout=timeout)
        except TimeoutError:
            decision = "timeout"
        finally:
            pc_approvals.discard(rec.id)
        await events.put(("resolved", {"id": rec.id, "decision": decision}))
        if decision == "allow":
            return allow_result()
        if decision == "timeout":
            return deny_result("ユーザーが時間内に承認しなかったため実行しませんでした")
        return deny_result("ユーザーがこのツール実行を拒否しました")

    return can_use_tool


async def agent_sdk_stream_chunks(
    *,
    system_prompt: str,
    history: list[tuple[str, str]],
    user_message: str,
    rate_limits_out: list[dict[str, Any]] | None = None,
    tools_mode: str = "off",
    approval_user_id: str | None = None,
    approval_thread_id: str | None = None,
) -> AsyncIterator[str | dict[str, Any]]:
    """Agent SDK (サブスク認証) で実 stream。

    yield するもの:
      - str: 応答本文の text delta (従来どおり)
      - dict {"tool": name}: GAP-129 ツール実行イベント (UI の実況用)
      - dict {"pc_approval": {...}} / {"pc_approval_resolved": {...}}:
        GAP-130 approve モードの承認カード表示/解決イベント

    include_partial_messages=True で CLI の raw stream event を受け、
    content_block_delta/text_delta を逐次 yield する。partial が一度も
    届かない場合 (旧 CLI 等) は完成 AssistantMessage の TextBlock で代替する。

    GAP-124: 実行中に CLI が発行する RateLimitEvent (5 時間 / 7 日枠の実測
    使用率 — API 応答ヘッダー由来) を rate_limits_out に収集する。
    GAP-129: tools_mode="auto" で Claude Code 同等のローカル作業ツールを許可
    (本人 opt-in、専用作業フォルダをカレントに起動)。
    GAP-130: tools_mode="approve" は can_use_tool で実行ごとにユーザー承認を
    待つ (approval_user_id / approval_thread_id が承認レジストリの帰属先)。
    """
    import asyncio

    from claude_agent_sdk import (  # pyright: ignore[reportMissingImports]
        AssistantMessage,
        ClaudeAgentOptions,
        StreamEvent,
        TextBlock,
        query,
    )

    try:
        from claude_agent_sdk import (  # pyright: ignore[reportMissingImports]
            RateLimitEvent,
        )
    except ImportError:  # 旧 SDK — プラン枠観測なしで動作継続 (誠実: 出さない)
        RateLimitEvent = None  # type: ignore[assignment]

    child_env = _subprocess_env()
    options_kwargs = build_options_kwargs(system_prompt=system_prompt, tools_mode=tools_mode)
    if tools_mode in ("auto", "approve"):
        # 作業フォルダを実作成 (無いと CLI が cwd 起動に失敗する)
        Path(str(options_kwargs.get("cwd", ""))).mkdir(parents=True, exist_ok=True)
        # CLI は root での bypassPermissions を拒否する。root で動くのは検証
        # コンテナのみ (実ユーザー機は非 root) — その場合だけ明示フラグを立てる。
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            child_env["IS_SANDBOX"] = "1"
    options_kwargs["env"] = child_env

    saw_partial = False

    def _msg_chunks(msg: Any) -> list[str | dict[str, Any]]:
        """SDK メッセージ 1 件を SSE 向け chunk 列に変換する (両経路で共用)。"""
        nonlocal saw_partial
        out: list[str | dict[str, Any]] = []
        if isinstance(msg, StreamEvent):
            event: dict[str, Any] = msg.event
            etype = event.get("type")
            if etype == "content_block_start":
                # GAP-129: ツール実行の開始をランタイム状態として通知
                raw_block = event.get("content_block")
                block_d: dict[str, Any] = raw_block if isinstance(raw_block, dict) else {}
                if block_d.get("type") == "tool_use":
                    name = block_d.get("name")
                    if isinstance(name, str) and name:
                        out.append({"tool": name})
                return out
            if etype != "content_block_delta":
                return out
            raw_delta = event.get("delta")
            delta: dict[str, Any] = raw_delta if isinstance(raw_delta, dict) else {}
            if delta.get("type") != "text_delta":
                return out
            text = delta.get("text")
            if isinstance(text, str) and text:
                saw_partial = True
                out.append(text)
        elif isinstance(msg, AssistantMessage) and not saw_partial:
            for block in msg.content:
                if isinstance(block, TextBlock) and block.text:
                    out.append(block.text)
        elif (
            rate_limits_out is not None
            and RateLimitEvent is not None
            and isinstance(msg, RateLimitEvent)
        ):
            info = msg.rate_limit_info
            status = getattr(info, "status", None)
            if status in ("allowed", "allowed_warning", "rejected"):
                rate_limits_out.append(
                    {
                        "status": status,
                        "rate_limit_type": getattr(info, "rate_limit_type", None),
                        "utilization": getattr(info, "utilization", None),
                        "resets_at": getattr(info, "resets_at", None),
                    }
                )
        return out

    folded = fold_prompt(history, user_message)

    if tools_mode != "approve":
        async for msg in query(prompt=folded, options=ClaudeAgentOptions(**options_kwargs)):
            for chunk in _msg_chunks(msg):
                yield chunk
        return

    # ---- GAP-130 approve モード: can_use_tool + キュー多重化 ----
    # can_use_tool は SDK 内部タスクで動くため、承認カードイベントを
    # メッセージ列に割り込ませるには単一キューへの多重化が必要になる
    # (承認待ちの間、query() のメッセージは進まない = キュー経由でしか
    #  カードを届けられない)。
    from claude_agent_sdk import (  # pyright: ignore[reportMissingImports]
        PermissionResultAllow,
        PermissionResultDeny,
        ResultMessage,
    )

    events: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
    options_kwargs["can_use_tool"] = make_pc_can_use_tool(
        user_id=str(approval_user_id or ""),
        thread_id=str(approval_thread_id or ""),
        events=events,
        allow_result=lambda: PermissionResultAllow(),
        deny_result=lambda message: PermissionResultDeny(message=message),
    )

    # SDK 0.2.139 の落とし穴: 入力イテレータが尽きると stdin を閉じるが、
    # can_use_tool の許可応答も stdin (control_response) で送るため、閉じると
    # CLI 側の許可要求が全て "AbortError: Stream closed" で即死する
    # (SDK は sdk_mcp_servers / hooks しか「開けたまま」の条件にしていない)。
    # → プロンプトを 1 件流した後、ストリーム完了までイテレータを開いたまま
    #   保つ (input_done は消費ループの finally で必ず set する)。
    input_done = asyncio.Event()

    async def _prompt_stream() -> AsyncIterator[dict[str, Any]]:
        # can_use_tool は streaming 入力必須 (SDK 制約) — 単発プロンプトを
        # stream-json の user メッセージ 1 件として流す。
        yield {
            "type": "user",
            "session_id": "",
            "message": {"role": "user", "content": folded},
            "parent_tool_use_id": None,
        }
        await input_done.wait()

    async def _pump() -> None:
        try:
            async for msg in query(
                prompt=_prompt_stream(), options=ClaudeAgentOptions(**options_kwargs)
            ):
                await events.put(("msg", msg))
                if isinstance(msg, ResultMessage):
                    # 実行 (run) 終了 — stdin 維持を解除して CLI を終了させる
                    input_done.set()
        except BaseException as exc:
            await events.put(("exc", exc))
        else:
            await events.put(("eof", None))

    pump_task = asyncio.create_task(_pump())
    try:
        while True:
            kind, item = await events.get()
            if kind == "eof":
                break
            if kind == "exc":
                raise item
            if kind == "approval":
                yield {"pc_approval": item}
            elif kind == "resolved":
                yield {"pc_approval_resolved": item}
            else:  # "msg"
                for chunk in _msg_chunks(item):
                    yield chunk
    finally:
        input_done.set()  # stdin 維持を解除 (これを忘れると CLI が終了しない)
        if not pump_task.done():
            pump_task.cancel()
        import contextlib

        with contextlib.suppress(BaseException):
            await pump_task
