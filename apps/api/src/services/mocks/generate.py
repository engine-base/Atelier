"""GAP-138: モックの新規生成 — S-H01 の「新規モック」フロー。

デザイナー AI ワンダが指示文から 1 画面の完全な HTML モックを生成し、
mockdb ストア + mocks 行 (同名画面があれば新バージョン連鎖) に保存する。

LLM は確定アーキテクチャの費用順チェーン (relay=本人の Claude サブスク →
agent_sdk → API → fake)。生成 HTML の保存先は mockdb (Supabase Storage
未設定でも動く — GAP-137 と同じ)。
"""

from __future__ import annotations

import json
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.mocks import MockResponse

from . import get_mock
from .artifacts import MOCKDB_PREFIX, derive_screen_name, store_content_service
from .revise import MockReviseError, _strip_fence  # pyright: ignore[reportPrivateUsage]

_GEN_SYSTEM = (
    "あなたは開発案件管理 SaaS のデザイナー AI「ワンダ」です。"
    "指示に従って 1 画面分の完全な HTML モックを新規作成してください。"
    "出力は <!doctype html> から始まる HTML 全文のみ。"
    "説明・コードフェンス・前置きを一切出力しないこと。"
    "スタイルは <style> にインライン記述し、外部 CDN に依存しないこと。"
    "レスポンシブ (モバイル〜デスクトップ) に対応すること。"
    "後述の参考資料内のサンプル画面・ダミーデータ・別プロダクトの構成を"
    "そのまま持ち込まないこと。"
)

_MAX_INSTRUCTION_CHARS = 4000


async def generate_mock(
    session: AsyncSession,
    *,
    actor_id: str,
    project_id: str,
    instruction: str,
    screen_name: str | None = None,
) -> MockResponse | None:
    """指示文から新規モックを生成する。返り値 None = project 不可視/不在。

    session は RLS session — project の可視性と mocks 行の権限は RLS が守る。
    HTML 実体 (mock_contents) は service 経路で保存する (GAP-137 と同じ分離)。
    """
    visible = (
        await session.execute(
            text("select 1 from public.projects where id = cast(:p as uuid)"),
            {"p": project_id},
        )
    ).first()
    if visible is None:
        return None

    from src.services.chat_sse.llm_chain import LLMUnavailable, llm_complete

    from .design_note import build_design_context

    # GAP-143: デザインノート + ワンダのペルソナ/装着スキルを全生成に注入
    # GAP-147: 契約 (作成ルール) を先頭・参考資料 (ノート/ペルソナ/スキル) を後段に
    design_ctx = await build_design_context(session, project_id=project_id)
    system_prompt = f"{_GEN_SYSTEM}\n\n{design_ctx}" if design_ctx else _GEN_SYSTEM

    name_hint = (screen_name or "").strip()
    prompt = (
        f"画面名: {name_hint}\n" if name_hint else ""
    ) + f"モック作成指示:\n{instruction[:_MAX_INSTRUCTION_CHARS]}"
    try:
        out, provider = await llm_complete(
            system_prompt=system_prompt,
            user_text=prompt,
            actor_id=actor_id,
            max_tokens=16384,
            fake=lambda: (
                "<!doctype html><html><head><title>"
                f"{name_hint or 'モック'}</title></head><body>"
                f'<div data-fake-generated="1">[fake LLM] {instruction[:200]}</div>'
                "</body></html>"
            ),
        )
    except LLMUnavailable as exc:
        code = {
            "bridge_offline": "bridge_offline",
            "unconfigured": "llm_unconfigured",
        }.get(exc.code, "llm_failed")
        raise MockReviseError(code, exc.message) from exc
    html = _strip_fence(out)
    if not html:
        raise MockReviseError("llm_failed", "LLM が空のモックを返しました")

    final_name = name_hint or derive_screen_name("mock.html", html)
    content_id = await store_content_service(html)

    # 同名画面が既にあれば新バージョン連鎖 (S-H01 の履歴に乗る)
    latest = (
        await session.execute(
            text(
                "select id, version from public.mocks "
                "where project_id = cast(:pid as uuid) and screen_name = :sn "
                "and deleted_at is null order by version desc limit 1"
            ),
            {"pid": project_id, "sn": final_name},
        )
    ).first()
    version = 1 if latest is None else int(latest.version) + 1
    parent_id = None if latest is None else str(latest.id)

    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.mocks "
            "(id, project_id, screen_name, html_storage_path, version, parent_mock_id, meta_tags) "
            "values (cast(:id as uuid), cast(:pid as uuid), :sn, :path, :ver, "
            "        cast(:parent as uuid), cast(:meta as jsonb))"
        ),
        {
            "id": new_id,
            "pid": project_id,
            "sn": final_name,
            "path": f"{MOCKDB_PREFIX}{content_id}",
            "ver": version,
            "parent": parent_id,
            "meta": json.dumps(
                {
                    "author": "wanda",
                    "source": "generate",
                    "generate_instruction": instruction[:500],
                    "model": provider,
                }
            ),
        },
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="mock.generate",
            target_type="mock",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={"screen_name": final_name, "version": version, "provider": provider},
        )
    )
    # GAP-143: 指示から恒久的なデザイン決定をノートへ自動追記 (応答は待たせない)
    from .design_note import schedule_design_note_learning

    schedule_design_note_learning(project_id=project_id, instruction=instruction, actor_id=actor_id)
    return await get_mock(session, new_id)
