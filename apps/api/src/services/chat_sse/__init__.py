"""チャット SSE + F-CTX01 文脈構築 サービス層 (T-A-18 / T-A-48 完全実装)。

F-CTX01 (完全版): ペルソナ + 装着スキル(content_md) + プロジェクト状態(DB-as-truth)
+ これまでの経緯(要約) + ナレッジRAG(本物の Voyage/pgvector 意味検索, 運営デフォルト
platform を横断参照) + 直近履歴 を system prompt に組み立てる。LLM 呼出は Anthropic SDK。

LLM 未接続時 (GAP-175: 既定は本人の Bridge。未接続) は本番では **fake/stub を黙って返さず error** を
返す (鉄則: stub 排除)。テストのみ ATELIER_ALLOW_FAKE_LLM=1 で echo fallback を許可する。

state-changing 操作 (user/assistant message の chat_messages 挿入) は
audit_logs に必ず記録 (3-tier AC: state-changing audit)。
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any, cast

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.chat_sse import ChatContextPreviewResponse

if TYPE_CHECKING:
    from .tools import ToolContext

logger = logging.getLogger(__name__)


async def _load_recent_messages(
    session: AsyncSession, *, thread_id: str, limit: int
) -> list[tuple[str, str]]:
    """thread の過去 message を (role, content) の組で新しい順 → 古い順で返す。"""
    if limit <= 0:
        return []
    res = await session.execute(
        text(
            "select role, content from public.chat_messages "
            "where thread_id = cast(:tid as uuid) "
            "order by created_at desc limit :lim"
        ),
        {"tid": thread_id, "lim": limit},
    )
    rows = list(res.all())
    rows.reverse()
    return [(str(r.role), str(r.content)) for r in rows]


async def _build_rag_context(
    session: AsyncSession,
    *,
    query: str,
    account_id: str | None,
    project_id: str | None = None,
) -> tuple[str, list[str]]:
    """ナレッジ RAG を **本物のベクトル検索** (Voyage 埋め込み + pgvector cosine) で構築する。

    T-A-47 の knowledge.search_knowledge を呼ぶ (埋め込みが使えないときは text fallback に
    自動 degrade)。account_id 指定時はそのテナント + 運営デフォルト (account_type=platform) を
    横断参照する。RLS で不可視は自動 skip。
    """
    from src.services import knowledge as kn

    result = await kn.search_knowledge(
        session, query=query, limit=5, account_id=account_id, project_id=project_id
    )
    if not result.hits:
        return "", []
    lines = ["以下は関連ナレッジ (意味検索 / RAG):"]
    ids: list[str] = []
    for hit in result.hits:
        k = hit.knowledge
        lines.append(f"- [{k.title}] {k.content_md[:300]}")
        ids.append(k.id)
    return "\n".join(lines), ids


async def _load_thread_meta(
    session: AsyncSession, *, thread_id: str
) -> tuple[str | None, str | None]:
    """thread から (ai_employee_id, project_id) を返す。RLS 不可視なら (None, None)。"""
    res = await session.execute(
        text(
            "select ai_employee_id, project_id from public.chat_threads where id = cast(:t as uuid)"
        ),
        {"t": thread_id},
    )
    row = res.first()
    if row is None:
        return None, None
    return (
        None if row.ai_employee_id is None else str(row.ai_employee_id),
        None if row.project_id is None else str(row.project_id),
    )


async def _load_persona_and_skills(
    session: AsyncSession, *, ai_employee_id: str
) -> tuple[str, list[str]]:
    """AI 社員のペルソナ文 + 装着スキル(content_md) を返す。"""
    res = await session.execute(
        text(
            "select display_name, role, department, tone_preset, custom_tone_text, "
            "system_prompt_override, attached_skills "
            "from public.ai_employees where id = cast(:i as uuid)"
        ),
        {"i": ai_employee_id},
    )
    row = res.first()
    if row is None:
        return "", []
    persona_lines: list[str] = []
    name = str(row.display_name) if row.display_name else "AI社員"
    role = str(row.role) if row.role else ""
    dept = str(row.department) if row.department else ""
    persona_lines.append(f"あなたは「{name}」（{dept} {role}）として振る舞います。")
    if row.tone_preset:
        persona_lines.append(f"口調: {row.tone_preset}")
    if row.custom_tone_text:
        persona_lines.append(str(row.custom_tone_text))
    if row.system_prompt_override:
        persona_lines.append(str(row.system_prompt_override))
    raw_skills: list[object] = list(row.attached_skills) if row.attached_skills is not None else []
    skill_ids: list[str] = [str(s) for s in raw_skills]
    # GAP-144: content_md は authenticated から列 revoke 済 — service 経路で読む
    from src.services.skills import fetch_skills_md

    skills_md = await fetch_skills_md(skill_ids)
    return "\n".join(persona_lines), skills_md


async def _load_project_state(session: AsyncSession, *, project_id: str) -> str:
    """プロジェクト状態 (DB-as-truth) を文脈テキストで返す。"""
    res = await session.execute(
        text("select name, status, project_type from public.projects where id = cast(:p as uuid)"),
        {"p": project_id},
    )
    row = res.first()
    if row is None:
        return ""
    return f"現在のプロジェクト: 「{row.name}」 (種別={row.project_type} / 状態={row.status})"


async def _fold_older_history(
    session: AsyncSession,
    *,
    thread_id: str,
    recent_window: int,
    char_budget: int = 1200,
    after: Any = None,
) -> str:
    """直近 recent_window より前の発言を文字数で畳み込む (切り捨て版)。

    GAP-132 以降はローリング要約 (chat_threads.context_summary) が主で、
    本関数は「要約に未反映の溢れ分」と「要約が無い/失敗した場合」の
    フォールバックを担う。after 指定時は created_at > after の行のみ対象
    (= 要約反映済みを二重に含めない)。
    """
    params: dict[str, Any] = {"t": thread_id, "off": recent_window}
    after_clause = ""
    if after is not None:
        after_clause = "where created_at > :after "
        params["after"] = after
    res = await session.execute(
        text(
            "select role, content from ("
            "  select role, content, created_at from public.chat_messages "
            "  where thread_id = cast(:t as uuid) "
            "  order by created_at desc offset :off"
            ") older "
            f"{after_clause}"
            "order by created_at asc"
        ),
        params,
    )
    rows = list(res.all())
    if not rows:
        return ""
    joined = " / ".join(f"{r.role}: {str(r.content)[:120]}" for r in rows)
    if len(joined) > char_budget:
        joined = "…" + joined[-char_budget:]
    return joined


async def _peer_thread_summaries(session: AsyncSession, *, project_id: str, thread_id: str) -> str:
    """GAP-149: 同一プロジェクトの他スレッド (他 AI 社員との会話) の要約ブロック。

    スレッドは project × AI 社員ごとに分かれるため、そのままだと社員間で
    会話が引き継がれない (経営者指摘)。GAP-132 のローリング要約を横断で
    注入し、どの社員もプロジェクト内の他の会話の要点を知った状態で応答する。
    実在する要約のみ (推測で埋めない)。最新 4 スレッド・各 500 字まで。
    """
    rows = (
        await session.execute(
            text(
                "select t.title, e.display_name, t.context_summary "
                "from public.chat_threads t "
                "left join public.ai_employees e on e.id = t.ai_employee_id "
                "where t.project_id = cast(:p as uuid) and t.id <> cast(:t as uuid) "
                "and coalesce(t.context_summary, '') <> '' "
                "order by t.updated_at desc limit 4"
            ),
            {"p": project_id, "t": thread_id},
        )
    ).all()
    if not rows:
        return ""
    lines: list[str] = ["# プロジェクト内の他の会話の要点 (他の AI 社員への相談内容 — 引き継ぎ用)"]
    for r in rows:
        who = str(r.display_name) if r.display_name else "別の社員"
        title = str(r.title) if r.title else "無題"
        summary = str(r.context_summary)[:500]
        lines.append(f"- {who}との会話「{title}」: {summary}")
    return "\n".join(lines)


async def _summary_context_block(
    session: AsyncSession, *, thread_id: str, recent_window: int
) -> str:
    """「これまでの経緯」ブロック (GAP-132 ローリング要約 + フォールバック)。

    保存済み LLM 要約 (context_summary) を主とし、要約に未反映の溢れ分
    (context_summary_upto より後) だけを切り捨て版で補う。
    """
    from .summary import compose_context_block

    res = await session.execute(
        text(
            "select context_summary, context_summary_upto "
            "from public.chat_threads where id = cast(:t as uuid)"
        ),
        {"t": thread_id},
    )
    row = res.first()
    stored: str | None = None
    upto: Any = None
    if row is not None:
        stored = None if row.context_summary is None else str(row.context_summary)
        upto = row.context_summary_upto
    unfolded = await _fold_older_history(
        session, thread_id=thread_id, recent_window=recent_window, after=upto
    )
    return compose_context_block(stored, unfolded)


_ATTACHMENT_HISTORY_MESSAGES = 6
_ATTACHMENT_MAX_FILES = 5


async def _recent_attachment_records(
    session: AsyncSession, *, thread_id: str
) -> list[dict[str, Any]]:
    """直近メッセージに添付された資料 (新しい順) を返す。"""
    rows = (
        await session.execute(
            text(
                "select attachments from public.chat_messages "
                "where thread_id = cast(:t as uuid) and deleted_at is null "
                "and attachments is not null "
                "order by created_at desc, id desc limit :n"
            ),
            {"t": thread_id, "n": _ATTACHMENT_HISTORY_MESSAGES},
        )
    ).all()
    out: list[dict[str, Any]] = []
    for r in rows:
        raw = r.attachments
        items: object = json.loads(raw) if isinstance(raw, str) else raw
        if isinstance(items, list):
            out.extend(
                cast("dict[str, Any]", i)
                for i in cast("list[object]", items)
                if isinstance(i, dict)
            )
    return out


async def _attachments_context_block(
    session: AsyncSession,
    *,
    thread_id: str,
    current: list[dict[str, Any]] | None,
) -> str:
    """添付資料をテキスト化して system prompt 用ブロックにする (GAP-161)。

    storage 未設定・取得失敗・未対応形式は「取り込めなかった」と正直に書き、
    推測で埋めない。抽出そのものは LLM を使わない (追加費用ゼロ)。
    """
    from src.services.attachments import extract_stored_attachments, render_attachments_block

    records: list[dict[str, Any]] = list(current or [])
    records.extend(await _recent_attachment_records(session, thread_id=thread_id))
    if not records:
        return ""
    extracted = await extract_stored_attachments(
        cast("list[dict[str, object]]", records), max_files=_ATTACHMENT_MAX_FILES
    )
    return render_attachments_block(extracted)


async def build_context(
    session: AsyncSession,
    *,
    thread_id: str,
    user_message: str,
    include_history: int,
    rag_account_id: str | None,
    use_rag: bool = True,
    attachments: list[dict[str, Any]] | None = None,
) -> tuple[str, list[tuple[str, str]], list[str]]:
    """(system_prompt, history, rag_hit_ids) を返す F-CTX01 構築。

    構成: ペルソナ + 装着スキル(content_md) + プロジェクト状態(DB-as-truth) +
    これまでの経緯(要約) + ナレッジRAG(本物ベクトル) + 直近履歴。
    """
    ai_employee_id, project_id = await _load_thread_meta(session, thread_id=thread_id)
    history = await _load_recent_messages(session, thread_id=thread_id, limit=include_history)

    base = "あなたは Atelier の AI アシスタントです。日本語で簡潔に回答してください。"
    parts: list[str] = [base]

    if ai_employee_id is not None:
        persona, skills_md = await _load_persona_and_skills(session, ai_employee_id=ai_employee_id)
        if persona:
            parts.append(persona)
        parts.extend(skills_md)

    if project_id is not None:
        proj_state = await _load_project_state(session, project_id=project_id)
        if proj_state:
            parts.append(proj_state)
        # GAP-150: フロー進行状況 (現在のステージ/担当) — COO 窓口運用の中核
        from src.services.flow import flow_context_block

        flow_block = await flow_context_block(session, project_id=project_id)
        if flow_block:
            parts.append(flow_block)
        # GAP-157: 確定済みフェーズの中身 (成果物/モック/完了工程) — 画面表示は
        # ヘッダーで切り替えても、AI は常に前フェーズを踏まえて依存・タスク分解する
        from src.services.flow.phases import phase_history_block

        history_block = await phase_history_block(session, project_id=project_id)
        if history_block:
            parts.append(history_block)
        # GAP-158: 現在工程の出力デザインテンプレ (workspace 定義) — 「内容は
        # スキル・指示、見た目はこのテンプレ」の分離を prompt で保証する
        from src.services.outputs.templates import templates_context_block

        tmpl_block = await templates_context_block(session, project_id=project_id)
        if tmpl_block:
            parts.append(tmpl_block)
        # GAP-149: 他 AI 社員との会話の要約を横断注入 (社員間の引き継ぎ)
        peers = await _peer_thread_summaries(session, project_id=project_id, thread_id=thread_id)
        if peers:
            parts.append(peers)

    summary = await _summary_context_block(
        session, thread_id=thread_id, recent_window=include_history
    )
    if summary:
        parts.append(summary)

    # GAP-161: 添付資料の中身を実際に AI へ渡す (従来は保存・表示のみで
    # プロンプトに一切入っていなかった実バグ)。直近のやり取りで渡された資料も
    # 対象にする — 「さっき送った資料を見て」が成立するように。
    att_block = await _attachments_context_block(session, thread_id=thread_id, current=attachments)
    if att_block:
        parts.append(att_block)

    rag_ids: list[str] = []
    if use_rag:
        rag_block, rag_ids = await _build_rag_context(
            session, query=user_message, account_id=rag_account_id, project_id=project_id
        )
        if rag_block:
            parts.append(rag_block)

    return "\n\n".join(parts), history, rag_ids


async def preview_context(
    session: AsyncSession,
    *,
    thread_id: str,
    user_message: str,
    include_history: int,
    rag_account_id: str | None,
) -> ChatContextPreviewResponse:
    system_prompt, history, rag_ids = await build_context(
        session,
        thread_id=thread_id,
        user_message=user_message,
        include_history=include_history,
        rag_account_id=rag_account_id,
        use_rag=True,
    )
    return ChatContextPreviewResponse(
        system_prompt=system_prompt,
        history_count=len(history),
        rag_hit_ids=rag_ids,
    )


async def _insert_message(
    session: AsyncSession,
    *,
    thread_id: str,
    role: str,
    content: str,
    attachments: list[dict[str, Any]] | None = None,
) -> str:
    new_id = str(uuid.uuid4())
    # created_at は clock_timestamp() を明示する。デフォルト now() は transaction
    # timestamp のため、同一トランザクションで入る user/assistant が同値になり
    # (created_at, id) 順のスレッド表示・分岐境界が UUID 次第で崩れる
    # (GAP-031① 監査で検出した実バグ)。
    await session.execute(
        text(
            "insert into public.chat_messages "
            "(id, thread_id, role, content, attachments, created_at) "
            "values (cast(:i as uuid), cast(:t as uuid), "
            "cast(:r as chat_message_role_enum), :c, cast(:att as jsonb), clock_timestamp())"
        ),
        {
            "i": new_id,
            "t": thread_id,
            "r": role,
            "c": content,
            "att": json.dumps(attachments or []),
        },
    )
    return new_id


#: GAP-189: 繋ぎ直しストリームのポーリング間隔と最大接続時間。
_ATTACH_POLL_SECONDS = 0.25
_ATTACH_TIMEOUT_ENV = "ATELIER_CHAT_ATTACH_TIMEOUT"
_ATTACH_TIMEOUT_DEFAULT = 900.0


def _attach_timeout_seconds() -> float:
    """繋ぎ直しを維持する最大秒数 (既定 15 分)。"""
    raw = os.environ.get(_ATTACH_TIMEOUT_ENV, "").strip()
    try:
        value = float(raw) if raw else _ATTACH_TIMEOUT_DEFAULT
    except ValueError:
        return _ATTACH_TIMEOUT_DEFAULT
    return value if value > 0 else _ATTACH_TIMEOUT_DEFAULT


async def _relay_answer_id(job_id: str, *, thread_id: str) -> str | None:
    """GAP-189: relay ジョブの返答が保存された chat_messages.id を引く。

    保存は complete_job (サーバー側のジョブ確定) が済ませている。まだ入って
    いない稀なケース (確定と SSE の見え方のずれ) はここで冪等に保存する —
    「chunk は DB にあるのにスレッドに答えが無い」を残さないため。
    別 session を使うのは、SSE の generator が持つリクエスト scope の session
    とジョブ確定側のトランザクションが別物だから (Bridge 側の commit を跨ぐ)。
    """
    from src.services import chat_run

    from .relay import service_session_factory

    factory = service_session_factory()
    async with factory() as s:
        result = await chat_run.persist_answer(s, job_id=job_id, thread_id=thread_id)
        await s.commit()
    return result.message_id


async def _cancelled_result(job_id: str) -> tuple[str, int]:
    """GAP-189: 中断されたターンの「ここまで」を返す (id, 文字数)。

    保存自体は中断操作の時点で済んでいる。ここは画面に返すための読み取り。
    """
    from src.services import chat_run

    from .relay import service_session_factory

    factory = service_session_factory()
    async with factory() as s:
        saved = await chat_run.saved_answer(s, job_id=job_id)
    return saved.message_id or "", saved.chars


def _sse_event(payload: dict[str, Any]) -> bytes:
    """data: <json>\\n\\n の SSE event をエンコード。"""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


async def _fake_stream_chunks(prompt: str) -> AsyncIterator[str]:
    """ANTHROPIC_API_KEY 不在時の fallback。

    user_message を echo する deterministic な短い応答を 1 文字ずつ
    yield する (テスト容易性 + SSE 配信パス検証用)。
    """
    fake_text = f"echo: {prompt[:200]}"
    for ch in fake_text:
        yield ch


def _build_system_param(system_prompt: str) -> str | list[dict[str, Any]]:
    """T-A-52: 実 stream の system 引数を組み立てる。

    T-F-15 の cache_system_prompt() で cache_control 付き blocks に変換し、
    連続ターンで provider prompt cache にヒットし得る形にする
    (Atelier の system はペルソナ+スキル+プロジェクト状態で毎ターンほぼ同一)。
    ATELIER_PROMPT_CACHE_DISABLED=1 で plain string のまま渡す (既定は有効)。
    """
    if os.environ.get("ATELIER_PROMPT_CACHE_DISABLED") == "1":
        return system_prompt
    from src.llm.caching import cache_system_prompt

    blocks = cache_system_prompt(system_prompt)
    return blocks if blocks else system_prompt


def _build_stream_tools(*, include_atelier: bool = False) -> list[dict[str, Any]] | None:
    """T-A-51: 実 stream に注入する tools を組み立てる。

    - web_search: Anthropic server-side tool (T-F-21 build_web_search_tool が唯一の組立元)。
      ATELIER_WEB_SEARCH_DISABLED=1 で無効化。
    - Atelier ツール (save_deliverable 等): include_atelier=True のとき追加。agentic ループが
      tool_use を受けてサーバ側で実行する (chat がアプリ操作を実行できるようにする)。
    """
    stream_tools: list[dict[str, Any]] = []
    if os.environ.get("ATELIER_WEB_SEARCH_DISABLED") != "1":
        from src.tools.web_search import build_web_search_tool

        stream_tools.append(build_web_search_tool())
    if include_atelier:
        from src.services.chat_sse.tools import atelier_tool_defs

        stream_tools.extend(atelier_tool_defs())
    return stream_tools or None


async def _real_stream_chunks(
    *,
    system_prompt: str,
    history: list[tuple[str, str]],
    user_message: str,
    tool_ctx: ToolContext | None = None,
) -> AsyncIterator[str]:
    """Anthropic SDK で実 stream。chunk text delta を yield する。

    - tool_ctx あり (既定): Atelier ツールを注入し、tool_use → サーバ側実行 →
      tool_result で継続する agentic ループを回す (チャットがアプリ操作＝成果物保存
      等を実行できるようになる)。チャットを Claude 同等のツール実行主体にするのが標準。
    - tool_ctx 無し / ATELIER_CHAT_TOOLS_ENABLED="0" で明示 OFF: text delta のみ。
      web_search は Anthropic server-side tool のため provider 側で完結する。
    """
    from anthropic import AsyncAnthropic  # type: ignore[import-not-found]

    client = AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    # 既定 ON。緊急時のみ ATELIER_CHAT_TOOLS_ENABLED="0" で従来動作(text のみ)へ退避できる。
    tools_enabled = (
        os.environ.get("ATELIER_CHAT_TOOLS_ENABLED", "1") != "0" and tool_ctx is not None
    )

    msgs: list[dict[str, Any]] = []
    for role, content in history:
        if role in ("user", "assistant"):
            msgs.append({"role": role, "content": content})
    msgs.append({"role": "user", "content": user_message})

    tools = _build_stream_tools(include_atelier=tools_enabled)
    system_param = _build_system_param(system_prompt)

    if not tools_enabled:
        kwargs: dict[str, Any] = {}
        if tools is not None:
            kwargs["tools"] = tools
        async with client.messages.stream(
            model="claude-sonnet-4-6",
            max_tokens=2048,
            system=system_param,  # type: ignore[arg-type]
            messages=msgs,  # type: ignore[arg-type]
            **kwargs,
        ) as stream:
            async for delta in stream.text_stream:  # type: ignore[union-attr]
                if delta:
                    yield delta
        return

    # agentic ループ: tool_use を実行して継続。無限ループ防止に上限を設ける。
    from .tools import (
        APPROVAL_REQUIRED_TOOLS,
        ATELIER_TOOL_NAMES,
        execute_atelier_tool,
        request_tool_approval,
    )

    assert tool_ctx is not None
    # save_deliverable は成果物全文を content_md(tool 入力)として emit するため出力が長い。
    # 2048 だと文書 + 前置き + 次の tool 呼び出しで上限に達し stop_reason="max_tokens" で
    # 切れ、tool_use にならず保存前に break していた。文書 1 本 + 継続に十分な枠を確保する。
    _AGENTIC_MAX_TOKENS = 8192
    for _round in range(5):
        async with client.messages.stream(
            model="claude-sonnet-4-6",
            max_tokens=_AGENTIC_MAX_TOKENS,
            system=system_param,  # type: ignore[arg-type]
            messages=msgs,  # type: ignore[arg-type]
            tools=tools,  # type: ignore[arg-type]
        ) as stream:
            async for delta in stream.text_stream:  # type: ignore[union-attr]
                if delta:
                    yield delta
            final = await stream.get_final_message()

        if getattr(final, "stop_reason", None) != "tool_use":
            break

        # assistant のツール呼び出しをそのまま積み、client-side ツールを実行して結果を返す。
        # ブロックは union 型のため属性は getattr で安全に取り出す。
        msgs.append(
            {
                "role": "assistant",
                "content": [b.model_dump() for b in final.content],
            }
        )
        results: list[dict[str, Any]] = []
        for b in final.content:
            if getattr(b, "type", None) != "tool_use":
                continue
            name: str = str(getattr(b, "name", ""))
            if name not in ATELIER_TOOL_NAMES:
                continue
            raw_input = getattr(b, "input", None)
            tool_input: dict[str, Any] = (
                cast("dict[str, Any]", raw_input) if isinstance(raw_input, dict) else {}
            )
            if name in APPROVAL_REQUIRED_TOOLS and tool_ctx.thread_id:
                # GAP-031①: 書込系ツールは自動実行せず承認待ちへ (人間の
                # 「承認して実行」で初めて実行される)
                out = await request_tool_approval(
                    tool_ctx,
                    thread_id=tool_ctx.thread_id,
                    name=name,
                    tool_input=tool_input,
                )
            else:
                out = await execute_atelier_tool(tool_ctx, name, tool_input)
            results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": str(getattr(b, "id", "")),
                    "content": out,
                }
            )
        if not results:  # server-side tool のみ等、実行対象が無ければ終了
            break
        msgs.append({"role": "user", "content": results})


async def attach_run(
    *,
    job_id: str,
    actor_id: str,
) -> AsyncIterator[bytes]:
    """GAP-189: すでに走っている実行に**繋ぎ直す** SSE ストリーム。

    画面を閉じても PC は仕事を続けている。戻ってきたときに最初から見えるよう、
    DB に溜まった chunk を先頭から流し直し、その後は追いつきながら中継する。
    イベント形は stream_chat と同じなので、画面側は同じパーサで読める。

    認可はここで行う (本人のジョブのみ)。終わっているジョブに繋いだ場合は
    溜まっている分を流し切って end を返す — 「見に行ったら空だった」を作らない。
    """
    import asyncio

    from src.services import chat_relay, chat_run

    from .relay import service_session_factory

    factory = service_session_factory()
    async with factory() as s:
        try:
            snap = await chat_run.run_snapshot(s, job_id=job_id, actor_id=actor_id)
        except chat_run.RunControlError as exc:
            yield _sse_event({"type": "error", "content": exc.message})
            return
    if snap.thread_id is None:
        yield _sse_event({"type": "error", "content": "この実行はチャットの返答ではありません。"})
        return

    yield _sse_event({"type": "run", "metadata": {"job_id": job_id, "attached": True}})

    last_seq = -1
    total = 0
    deadline = asyncio.get_event_loop().time() + _attach_timeout_seconds()
    while True:
        async with factory() as s:
            chunks = await chat_relay.fetch_chunks(s, job_id=job_id, after_seq=last_seq)
            status, error = await chat_relay.job_result(s, job_id=job_id)
        for seq, kind, content in chunks:
            last_seq = seq
            if not content:
                continue
            if kind == "tool":
                yield _sse_event({"type": "tool", "content": content})
            elif kind == "artifact":
                try:
                    payload = json.loads(content)
                except ValueError:
                    continue
                if isinstance(payload, dict):
                    yield _sse_event({"type": "artifact", "metadata": payload})
            else:
                total += len(content)
                yield _sse_event({"type": "delta", "content": content})

        if status in ("done", "error", "expired", "cancelled"):
            async with factory() as s:
                saved = await chat_run.persist_answer(s, job_id=job_id, thread_id=snap.thread_id)
                await s.commit()
            event = "cancelled" if status == "cancelled" else "end"
            if status == "error":
                # 生のプロバイダーエラー (内部情報) は画面へ流さない — 既存方針と同一。
                logger.error("attached relay job %s ended with error: %s", job_id, error)
                yield _sse_event(
                    {
                        "type": "error",
                        "content": (
                            "ローカル実行がエラーで終了しました。Bridge のログを確認してください。"
                        ),
                    }
                )
            yield _sse_event(
                {
                    "type": event,
                    "metadata": {
                        "assistant_message_id": saved.message_id or "",
                        "user_message_id": "",
                        "total_chars": total,
                    },
                }
            )
            return
        if asyncio.get_event_loop().time() > deadline:
            # 繋ぎっぱなしにしない。実行自体は PC で続いているので、
            # もう一度開けば続きから見える (嘘の完了は出さない)。
            yield _sse_event(
                {
                    "type": "error",
                    "content": "実行はまだ続いています。画面を開き直すと続きから表示します。",
                }
            )
            return
        await asyncio.sleep(_ATTACH_POLL_SECONDS)


async def stream_chat(
    session: AsyncSession,
    *,
    actor_id: str,
    thread_id: str,
    user_message: str,
    use_rag: bool,
    include_history: int,
    rag_account_id: str | None,
    attachments: list[dict[str, Any]] | None = None,
    tools_mode: str = "off",
) -> AsyncIterator[bytes]:
    """SSE byte stream を yield する generator。

    1. F-CTX01: system prompt + history + RAG を構築
    2. chat_messages に user message を insert (audit)
    3. LLM stream → SSE 'delta' を chunk 配信
    4. 完了時に assistant message を chat_messages に insert (audit)
    5. 'end' event で usage / message_ids を返す
    """
    system_prompt, history, rag_ids = await build_context(
        session,
        thread_id=thread_id,
        user_message=user_message,
        include_history=include_history,
        rag_account_id=rag_account_id,
        use_rag=use_rag,
        attachments=attachments,
    )

    user_msg_id = await _insert_message(
        session,
        thread_id=thread_id,
        role="user",
        content=user_message,
        attachments=attachments,
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="chat.message.create",
            target_type="chat_message",
            actor_type="user",
            actor_id=actor_id,
            target_id=user_msg_id,
            after={"thread_id": thread_id, "role": "user"},
        )
    )

    yield _sse_event(
        {
            "type": "context",
            "metadata": {
                "history_count": len(history),
                "rag_hit_ids": rag_ids,
                "user_message_id": user_msg_id,
            },
        }
    )
    yield _sse_event({"type": "start"})

    # GAP-201: **ここで確定して DB 接続をいったん手放す**。
    #
    # この先は本人の PC (Bridge) の実行待ちで、長いと数分かかる。以前はその間
    # ずっとリクエストの DB 接続を握ったままだったので、「同時に喋れる人数 =
    # DB 接続の本数」になっていた (GAP-198 で実測)。
    #
    # commit すると接続はプールへ返り、次に SQL を投げた時に取り直される。
    # role / claims は transaction-local なので普通なら消えるが、GAP-201 で
    # `after_begin` に貼り直しを仕込んだので RLS は効いたまま。
    #
    # 副産物として **ユーザーの発言がこの時点で確定する** — 生成に失敗しても
    # 「送ったのに消えた」が起きない。
    await session.commit()

    # GAP-113: ATELIER_LLM_PROVIDER=agent_sdk でオーナーの Claude サブスク
    # (Agent SDK 認証) 経路に切替 (セルフホスト個人インスタンス専用 opt-in)。
    # GAP-114: 同 =relay で各ユーザー PC の Bridge (= 本人のプラン) へ中継。
    from .agent_sdk import sdk_available, subscription_mode_enabled
    from .relay import relay_mode_enabled

    use_subscription = subscription_mode_enabled()
    use_relay = relay_mode_enabled()
    # GAP-129/130/134: PC 操作 (auto/approve) は本人の Claude プランで実行できる
    # 経路 (relay = 本人 PC の Bridge / agent_sdk = サーバー内サブスク実行) 限定。
    # 他モードで要求されたら黙って無視せず誠実にエラーで返す
    # (UI は対応モード以外でトグル自体を出さないので、これは防御層)。
    if tools_mode in ("auto", "approve") and not (use_subscription or use_relay):
        yield _sse_event(
            {
                "type": "error",
                "content": (
                    "PC 操作は Bridge (自分の PC で実行) または"
                    "「オーナーの Claude プランで実行」モードのときだけ使えます。"
                    "PC 操作をオフにして再送してください。"
                ),
            }
        )
        return
    if use_subscription and not sdk_available():
        # opt-in したのに SDK 不在 → 黙って API/fake に落とさず誠実にエラー
        # (F-CTX01 / 鉄則: 未設定は明示。黙る fallback は課金事故のもと)。
        yield _sse_event(
            {
                "type": "error",
                "content": (
                    "サブスクリプションモードが利用できません (claude-agent-sdk 未インストール)。"
                ),
            }
        )
        return
    # GAP-175: 運営の ANTHROPIC_API_KEY は既定で使わない。キーが環境にあるだけで
    # 黙って従量課金へ流れると、Bridge が繋がっていない全ユーザー分が運営持ちに
    # なる。API 課金は ATELIER_ALLOW_API_BILLING=1 の明示 opt-in のときだけ。
    from .llm_chain import api_billing_allowed

    use_api = api_billing_allowed() and bool(os.environ.get("ANTHROPIC_API_KEY"))
    use_real = use_subscription or use_relay or use_api
    # GAP-124: agent_sdk 経路のプラン枠観測 (RateLimitEvent) の収集先
    sdk_rate_limits: list[dict[str, Any]] = []
    # GAP-137: agent_sdk 経路の成果物反映用スナップショット (tools 時のみ実値)
    sdk_workspace = ""
    sdk_ws_before: dict[str, float] = {}
    allow_fake = os.environ.get("ATELIER_ALLOW_FAKE_LLM") == "1"
    if not use_real and not allow_fake:
        # 本番では LLM 未接続時に fake/stub を黙って返さない (F-CTX01 / 鉄則: stub 排除)。
        yield _sse_event(
            {
                "type": "error",
                "content": (
                    "お使いのパソコン (Bridge) が未接続のため AI 実行ができません。"
                    "Bridge アプリを起動してから再送してください。"
                ),
                "metadata": {"code": "bridge_offline"},
            }
        )
        return
    # agentic ツール実行 (既定 ON) 用の文脈: thread→project→workspace。
    # ATELIER_CHAT_TOOLS_ENABLED="0" の明示 OFF 時のみ文脈を作らず従来動作に退避する。
    # GAP-113/114 v1 制限: サブスク/リレーモードでは Atelier ツール (agentic
    # ループ) は未注入 (実行系が API 形式と別系統のため)。テキスト+RAG のみ。
    tool_ctx: ToolContext | None = None
    if (
        use_api
        and not use_subscription
        and not use_relay
        and os.environ.get("ATELIER_CHAT_TOOLS_ENABLED", "1") != "0"
    ):
        from .tools import ToolContext as _ToolContext

        _, project_id = await _load_thread_meta(session, thread_id=thread_id)
        workspace_id: str | None = None
        if project_id is not None:
            ws_res = await session.execute(
                text("select workspace_id from public.projects where id = cast(:p as uuid)"),
                {"p": project_id},
            )
            ws_row = ws_res.first()
            workspace_id = None if ws_row is None else str(ws_row.workspace_id)
        tool_ctx = _ToolContext(
            session=session,
            actor_id=actor_id,
            project_id=project_id,
            workspace_id=workspace_id,
            thread_id=thread_id,
        )

    accumulated: list[str] = []
    # GAP-189: relay 経路のこのターンの実行 ID。中断・繋ぎ直しの手掛かりであり、
    # 返答の保存主体がサーバー (ジョブ確定) 側であることの目印でもある。
    relay_job_id: str | None = None
    try:
        if use_relay:
            from .relay import relay_stream_chunks

            # GAP-134: tools_mode を Bridge へ伝える — PC 操作は本人の PC で実行
            chunks = relay_stream_chunks(
                system_prompt=system_prompt,
                history=history,
                user_message=user_message,
                thread_id=thread_id,
                actor_id=actor_id,
                tools_mode=tools_mode,
            )
        elif use_subscription:
            from .agent_sdk import agent_sdk_stream_chunks, chat_workspace_dir

            # GAP-137: サーバー内実行の成果物反映 — 実行前スナップショット
            if tools_mode in ("approve", "auto"):
                from .pc_artifacts import snapshot_artifact_files

                sdk_workspace = chat_workspace_dir()
                sdk_ws_before = snapshot_artifact_files(sdk_workspace)

            # GAP-124: 実行中の RateLimitEvent (プラン枠実測) を収集して記録する
            # GAP-129: tools_mode="auto" で Claude Code 同等の PC 操作を許可
            # GAP-130: tools_mode="approve" は実行ごとにユーザー承認を待つ
            chunks = agent_sdk_stream_chunks(
                system_prompt=system_prompt,
                history=history,
                user_message=user_message,
                rate_limits_out=sdk_rate_limits,
                tools_mode=tools_mode,
                approval_user_id=actor_id,
                approval_thread_id=thread_id,
            )
        elif use_api:
            chunks = _real_stream_chunks(
                system_prompt=system_prompt,
                history=history,
                user_message=user_message,
                tool_ctx=tool_ctx,
            )
        else:
            chunks = _fake_stream_chunks(user_message)
        async for chunk in chunks:
            if isinstance(chunk, dict):
                # GAP-129/130: ツール実行・承認イベント — UI がランタイム状態
                # (「Bash を実行中…」/ 承認カード) を実表示するための実値。
                # 本文には含めない (accumulated に足さない)。
                if "pc_approval" in chunk:
                    yield _sse_event({"type": "pc_approval", "metadata": chunk["pc_approval"]})
                elif "pc_approval_resolved" in chunk:
                    yield _sse_event(
                        {
                            "type": "pc_approval_resolved",
                            "metadata": chunk["pc_approval_resolved"],
                        }
                    )
                elif "artifact" in chunk:
                    # GAP-137: 成果物のモック取り込み結果 — UI が「モック保存」
                    # カード (S-H01 へのリンク) を出すための実値。
                    yield _sse_event({"type": "artifact", "metadata": chunk["artifact"]})
                elif "job" in chunk:
                    # GAP-189: 実行 ID。画面はこれで「停止」を出せるようになり、
                    # 閉じてしまっても同じ実行に繋ぎ直せる。
                    relay_job_id = str(chunk["job"])
                    yield _sse_event({"type": "run", "metadata": {"job_id": relay_job_id}})
                else:
                    yield _sse_event({"type": "tool", "content": str(chunk.get("tool", ""))})
                continue
            accumulated.append(chunk)
            yield _sse_event({"type": "delta", "content": chunk})
        # GAP-137: agent_sdk 経路の成果物反映 (relay 経路は Bridge が担当)。
        # 失敗してもチャット応答は壊さない (best-effort、ただし黙って捨てず log)。
        if use_subscription and tools_mode in ("approve", "auto"):
            try:
                from .pc_artifacts import collect_new_artifacts, ingest_for_thread

                new_files = collect_new_artifacts(sdk_workspace, sdk_ws_before)
                for ingested in await ingest_for_thread(
                    thread_id=thread_id, files=new_files, instruction=user_message
                ):
                    yield _sse_event({"type": "artifact", "metadata": dict(ingested)})
            except Exception as exc:  # pragma: no cover  - fs/DB 例外は環境依存
                logger.error("chat artifact reflect failed (thread=%s): %s", thread_id, exc)
        # GAP-124: プラン枠観測の記録 (best-effort — 応答自体は既に届いている)
        if use_subscription and sdk_rate_limits:
            import contextlib

            from .relay import record_plan_observations

            # 観測記録の失敗でチャットを壊さない (best-effort)
            with contextlib.suppress(Exception):
                await record_plan_observations(actor_id, sdk_rate_limits)
    except Exception as exc:  # pragma: no cover  - 実 LLM 障害は別レイヤ
        # GAP-114: リレー固有の失敗は原因を偽らず具体的に伝える (誠実設計)。
        from .relay import RelayCancelled, RelayFailed, RelayTimeout, RelayUnavailable

        if isinstance(exc, RelayCancelled):
            # GAP-189: 人が止めた = 失敗ではない。エラー文言を出さず、
            # 「ここまで」を確定させて静かに終える (本文は保存済み)。
            saved_id, saved_chars = await _cancelled_result(exc.job_id)
            yield _sse_event(
                {
                    "type": "cancelled",
                    "metadata": {
                        "assistant_message_id": saved_id,
                        "user_message_id": user_msg_id,
                        "total_chars": saved_chars,
                    },
                }
            )
            return
        if isinstance(exc, RelayUnavailable):
            # GAP-240: 「まだ接続していない」と「接続済みだが起動していない」で案内を分ける
            if getattr(exc, "reason", "offline") == "not_connected":
                message = (
                    "お使いの PC がまだ接続されていません。"
                    "設定画面の「Bridge を接続」から接続すると、AI 機能を使えるようになります。"
                )
            else:
                message = (
                    "ローカル実行 (Bridge) がオフラインのため応答できません。"
                    "お使いの PC で Bridge を起動してから再送してください。"
                )
        elif isinstance(exc, RelayTimeout):
            message = "ローカル実行が制限時間内に完了しませんでした。再送してください。"
        elif isinstance(exc, RelayFailed):
            message = "ローカル実行がエラーで終了しました。Bridge のログを確認してください。"
        else:
            # 生のプロバイダーエラー (request_id 等の内部情報) はクライアントへ流さない。
            message = "AI 応答の取得に失敗しました。時間をおいて再試行してください。"
        logger.error("chat stream LLM failure (thread=%s): %s", thread_id, exc)
        yield _sse_event({"type": "error", "content": message})
        return

    final_text = "".join(accumulated)
    if relay_job_id is not None:
        # GAP-189: relay 経路の返答は **ジョブ確定時にサーバーが保存済み**。
        # ここで入れ直すと二重投稿になるので、保存された id を引くだけにする
        # (画面を閉じても答えが消えないのは、保存がこちらに寄っているため)。
        assistant_msg_id = await _relay_answer_id(relay_job_id, thread_id=thread_id)
    else:
        assistant_msg_id = await _insert_message(
            session, thread_id=thread_id, role="assistant", content=final_text
        )
    if rag_ids:
        # GAP-012: RAG で実消費したナレッジの参照元 (このスレッド) を永続化し、
        # S-K01 バックリンクの逆引きデータ源にする。再参照は count++ に畳まれる。
        from src.services import knowledge as kn

        await kn.record_references(
            session,
            knowledge_ids=rag_ids,
            referrer_type="chat_thread",
            referrer_id=thread_id,
            context="チャット応答で参照（RAG）",
        )
    if assistant_msg_id is not None:
        await AuditWriter(session).write(
            AuditEvent(
                action="chat.message.create",
                target_type="chat_message",
                actor_type="user",
                actor_id=actor_id,
                target_id=assistant_msg_id,
                after={"thread_id": thread_id, "role": "assistant"},
            )
        )

    # GAP-132: 応答完了後にローリング要約を非同期更新する (溢れが無ければ
    # no-op)。応答自体は既に配信済みなので体感遅延ゼロ。失敗しても
    # 切り捨て版フォールバックが生きるためチャットは壊れない。
    from .summary import schedule_summary_update

    schedule_summary_update(thread_id=thread_id, actor_id=actor_id, recent_window=include_history)

    # GAP-164: 会話から「他の案件でも使えるノウハウ」を自動でナレッジに残す。
    # 外部のモデル学習には使わない — このワークスペースの資産として貯める
    # (source_type=ai_extracted なので画面で見分けられ、不要なら消せる)。
    from src.services.knowledge.auto_capture import schedule_capture

    schedule_capture(thread_id=thread_id, actor_id=actor_id)

    yield _sse_event(
        {
            "type": "end",
            "metadata": {
                "assistant_message_id": assistant_msg_id or "",
                "user_message_id": user_msg_id,
                "total_chars": len(final_text),
            },
        }
    )
