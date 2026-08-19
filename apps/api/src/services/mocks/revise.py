# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
"""S-H01 モック「編集」= ワンダ (AI デザイナー) への修正依頼 (GAP-024)。

確定アーキ (decision_log / selected-libraries.md): モック生成・反復は
Open Design パターン (自然言語指示 → agent が HTML を生成) を直接活用する。
Atelier では担当 = デザイナー AI 社員ワンダで、S-H01 のバージョン author が
「ワンダ（更新）」なのはこのフロー。人間が HTML を手で書く編集ではない。

フロー:
  1. 現行バージョンの HTML を storage から取得 (署名付き URL)
  2. LLM (selected-stack v1 = AnthropicClient) が指示に従って全文 HTML を改訂
     - GAP-138/175: 経路は本人の Claude サブスク (Bridge)。経路なしは 503 (偽の改訂を出さない)
     - テストのみ ATELIER_ALLOW_FAKE_LLM=1 で決定的スタブ改訂 (配線検証用)
  3. 改訂 HTML を storage へアップロード (新オブジェクト)
  4. mocks に新バージョン行 (parent_mock_id 連鎖、meta に指示文 + author=wanda)
"""

from __future__ import annotations

import os
import uuid
from typing import Any, Protocol

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.llm.client import LLMMessage
from src.schemas.mocks import MockResponse, MockVersionCreate
from src.storage_signing import create_signed_download_url, create_signed_upload_url

from . import MockVersionConflict, create_version, get_mock

REVISE_MODEL = os.environ.get("ATELIER_DESIGN_MODEL", "claude-sonnet-4-6")

_MAX_HTML_CHARS = 60_000

# GAP-147: 改訂契約を system prompt の**先頭**に置く (実機バグの教訓 —
# 参考資料が契約の前にあると、モデルがスキルの手順に従って画面を作り直す)。
SUMMARY_MARKER = "---SUMMARY---"

_SYSTEM = (
    "あなたは開発案件管理 SaaS のデザイナー AI「ワンダ」です。"
    "与えられた「現行 HTML」を、修正指示に従って**改訂**してください。\n"
    "絶対ルール (この契約が最優先 — 後述の参考資料より強い):\n"
    "1. 既存 HTML の構成・見出し・文言・データを保持し、指示に関係する箇所"
    "だけを変更する。全面的な作り直し・別デザインへの置き換えは禁止。\n"
    "2. 参考資料 (スキル・サンプル) 内の画面例・ダミーデータ・別プロダクトの"
    "構成を成果物に持ち込まない。\n"
    "3. 出力形式: 改訂後の完全な HTML 全文 → 最終行に "
    f"{SUMMARY_MARKER} → 次の行に「何をどう変えたか」の要約 (日本語 1〜2 文)。\n"
    "4. HTML の前に説明・コードフェンス・前置きを出力しない。"
)


def split_summary(text_out: str) -> tuple[str, str]:
    """モデル出力を (HTML, 変更サマリー) に分ける。マーカー無しはサマリー空。"""
    if SUMMARY_MARKER in text_out:
        html_part, _, tail = text_out.rpartition(SUMMARY_MARKER)
        return html_part.strip(), " ".join(tail.strip().split())[:300]
    return text_out.strip(), ""


async def _instruction_history(
    session: AsyncSession, *, project_id: str, screen_name: str, before_version: int
) -> list[str]:
    """同一画面チェーンの過去の修正指示 (古い順・最大 5 件) — 会話の文脈。"""
    rows = (
        await session.execute(
            text(
                "select meta_tags ->> 'revision_instruction' as ins "
                "from public.mocks "
                "where project_id = cast(:p as uuid) and screen_name = :sn "
                "and version < :v and deleted_at is null "
                "and meta_tags ->> 'revision_instruction' is not null "
                "order by version desc limit 5"
            ),
            {"p": project_id, "sn": screen_name, "v": before_version},
        )
    ).all()
    return [str(r.ins)[:300] for r in reversed(rows) if r.ins]


class MockReviseError(Exception):
    """修正依頼の構造的失敗 (code: llm_unconfigured / llm_failed /
    storage_unconfigured / content_unavailable / too_large)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _CompletionClient(Protocol):
    async def complete(
        self,
        *,
        model: str,
        messages: list[LLMMessage],
        system: str | None = ...,
        max_tokens: int = ...,
        temperature: float = ...,
    ) -> Any: ...


def _fake_revision(html: str, instruction: str) -> str:
    """ATELIER_ALLOW_FAKE_LLM=1 のみの決定的スタブ改訂 (配線検証用)。

    実 LLM の代替ではない — 指示バナーを可視挿入することで
    「新バージョンの実体が本当に変わった」ことを E2E で検証可能にする。
    """
    banner = (
        '<div data-fake-revision="1" style="background:#FEF3C7;padding:8px 12px;'
        'font-size:12px;border-bottom:1px solid #F59E0B;">'
        f"[fake LLM] 修正依頼を適用: {instruction}</div>"
    )
    tail_summary = f"\n{SUMMARY_MARKER}\n[fake] 修正依頼を反映: {instruction[:120]}"
    if "<body" in html:
        head, sep, tail = html.partition(">")
        if sep and "<body" in head:
            return f"{head}>{banner}{tail}{tail_summary}"
        idx = html.find("<body")
        end = html.find(">", idx)
        if end >= 0:
            return html[: end + 1] + banner + html[end + 1 :] + tail_summary
    return banner + html + tail_summary


async def _download_html(storage_path: str) -> str:
    # GAP-138: mockdb (DB 内蔵 — チャット成果物/生成モック) は service 経由で読む
    from .artifacts import MOCKDB_PREFIX, fetch_content_service

    if storage_path.startswith(MOCKDB_PREFIX):
        html = await fetch_content_service(storage_path[len(MOCKDB_PREFIX) :])
        if html is None:
            raise MockReviseError("content_unavailable", "mockdb content not found")
        return html
    url = await create_signed_download_url(storage_path)
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(url)
    if r.status_code >= 400:
        raise MockReviseError(
            "content_unavailable", f"failed to download mock html: {r.status_code}"
        )
    return r.text


async def _upload_html(storage_path: str, html: str) -> None:
    url = await create_signed_upload_url(storage_path)
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.put(
            url, content=html.encode("utf-8"), headers={"Content-Type": "text/html"}
        )
    if r.status_code >= 400:
        raise MockReviseError("llm_failed", f"failed to upload revised html: {r.status_code}")


def _strip_fence(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        first_nl = t.find("\n")
        if first_nl >= 0:
            t = t[first_nl + 1 :]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


async def revise_mock(
    session: AsyncSession,
    *,
    actor_id: str,
    mock_id: str,
    instruction: str,
    client: _CompletionClient | None = None,
    reference_files: list[dict[str, object]] | None = None,
) -> MockResponse | None:
    """修正指示から新バージョンを生成する。返り値 None = mock 不可視/不在。"""
    current = await get_mock(session, mock_id)
    if current is None:
        return None
    html = await _load_current_html(current)

    if client is not None:
        # テスト注入経路 (決定的クライアント) — 実運用は下の共通チェーン
        try:
            res = await client.complete(
                model=REVISE_MODEL,
                messages=[
                    LLMMessage(
                        role="user",
                        content=f"修正指示:\n{instruction}\n\n現行 HTML:\n{html}",
                    )
                ],
                system=_SYSTEM,
                max_tokens=16384,
                temperature=0.2,
            )
        except Exception as e:
            raise MockReviseError("llm_failed", f"LLM 呼出に失敗: {e}") from e
        revised, summary = split_summary(_strip_fence(str(res.text)))
        used_model = REVISE_MODEL
    else:
        # GAP-138: 確定アーキテクチャの費用順 (relay=本人サブスク → agent_sdk →
        # API → fake)。ANTHROPIC_API_KEY 直依存をやめる。
        from src.services.chat_sse.llm_chain import LLMUnavailable, llm_complete

        system_prompt, user_text = await _build_prompts(
            session,
            current=current,
            html=html,
            instruction=instruction,
            reference_files=reference_files,
        )
        try:
            out, provider = await llm_complete(
                system_prompt=system_prompt,
                user_text=user_text,
                actor_id=actor_id,
                max_tokens=16384,
                fake=lambda: _fake_revision(html, instruction),
            )
        except LLMUnavailable as exc:
            raise MockReviseError(_map_unavailable(exc.code), exc.message) from exc
        revised, summary = split_summary(_strip_fence(out))
        used_model = provider
    if not revised:
        raise MockReviseError("llm_failed", "LLM が空の改訂を返しました")
    return await _persist_revision(
        session,
        actor_id=actor_id,
        mock_id=mock_id,
        current=current,
        revised=revised,
        summary=summary,
        instruction=instruction,
        used_model=used_model,
    )


def _map_unavailable(code: str) -> str:
    return {
        "bridge_offline": "bridge_offline",
        "unconfigured": "llm_unconfigured",
    }.get(code, "llm_failed")


async def _load_current_html(current: MockResponse) -> str:
    html = await _download_html(current.html_storage_path)
    if len(html) > _MAX_HTML_CHARS:
        raise MockReviseError(
            "too_large", f"mock html exceeds {_MAX_HTML_CHARS} chars — 分割を検討してください"
        )
    return html


async def _build_prompts(
    session: AsyncSession,
    *,
    current: MockResponse,
    html: str,
    instruction: str,
    reference_files: list[dict[str, object]] | None = None,
) -> tuple[str, str]:
    """GAP-147: 契約が先頭・参考資料は後段の system prompt + 履歴つき user prompt。"""
    from .design_note import build_design_context

    design_ctx = await build_design_context(session, project_id=current.project_id)
    system_prompt = f"{_SYSTEM}\n\n{design_ctx}" if design_ctx else _SYSTEM
    # GAP-161: ユーザーがこの作業のために上げた資料 (画像/PDF/Excel 等) を渡す
    if reference_files:
        from src.services.attachments import (
            extract_stored_attachments,
            render_reference_block,
        )

        ref_block = render_reference_block(await extract_stored_attachments(reference_files))
        if ref_block:
            system_prompt = f"{system_prompt}\n\n{ref_block}"
    history = await _instruction_history(
        session,
        project_id=current.project_id,
        screen_name=current.screen_name,
        before_version=current.version + 1,
    )
    history_block = (
        "これまでの指示履歴 (古い順 — 文脈として維持すること):\n"
        + "\n".join(f"- {h}" for h in history)
        + "\n\n"
        if history
        else ""
    )
    user_text = f"{history_block}今回の修正指示:\n{instruction}\n\n現行 HTML:\n{html}"
    return system_prompt, user_text


async def _persist_revision(
    session: AsyncSession,
    *,
    actor_id: str,
    mock_id: str,
    current: MockResponse,
    revised: str,
    summary: str,
    instruction: str,
    used_model: str,
) -> MockResponse | None:
    # GAP-138: mockdb モックは mockdb へ、Supabase 由来は Supabase へ (系を跨がない)
    from .artifacts import MOCKDB_PREFIX, store_content_service

    if current.html_storage_path.startswith(MOCKDB_PREFIX):
        new_path = f"{MOCKDB_PREFIX}{await store_content_service(revised)}"
    else:
        new_path = f"mocks/{current.project_id}/{uuid.uuid4()}/{current.screen_name}-rev.html"
        await _upload_html(new_path, revised)

    # GAP-143: 修正指示から恒久的なデザイン決定をノートへ自動追記 (非同期)
    from .design_note import schedule_design_note_learning

    schedule_design_note_learning(
        project_id=current.project_id, instruction=instruction, actor_id=actor_id
    )
    meta: dict[str, object] = {
        "author": "wanda",
        "revision_instruction": instruction,
        "revised_from_version": current.version,
        "model": used_model,
    }
    if summary:
        # GAP-147: 「何をどう変えたか」— 会話バブル/バージョン履歴に表示される
        meta["note"] = summary
    try:
        return await create_version(
            session,
            actor_id=actor_id,
            mock_id=mock_id,
            data=MockVersionCreate(html_storage_path=new_path, meta_tags=meta),
        )
    except MockVersionConflict as exc:
        # GAP-155: 同時改訂 — 黙って積み直さず誠実に 409
        raise MockReviseError("conflict", str(exc)) from exc


async def revise_mock_stream(
    session: AsyncSession,
    *,
    actor_id: str,
    mock_id: str,
    instruction: str,
    reference_files: list[dict[str, object]] | None = None,
):
    """GAP-147: 改訂の進行状況を逐次 yield する (「何をしているか」の可視化)。

    yield (dict):
      {"stage": "loading"}                 — 現行 HTML の取得
      {"stage": "generating", "provider"}  — ワンダが改訂を生成中
      {"progress": {"chars": n}}           — 生成済み文字数 (実測)
      {"stage": "saving"}                  — 新バージョンの保存
      {"result": {mock..., "summary"}}     — 完了 (新バージョン)
      {"error": {"code", "message"}}       — 失敗 (誠実にそのまま)
    """
    from src.services.chat_sse.llm_chain import LLMUnavailable, llm_stream

    try:
        current = await get_mock(session, mock_id)
        if current is None:
            yield {"error": {"code": "not_found", "message": "mock not found"}}
            return
        yield {"stage": "loading"}
        html = await _load_current_html(current)
        system_prompt, user_text = await _build_prompts(
            session,
            current=current,
            html=html,
            instruction=instruction,
            reference_files=reference_files,
        )
        parts: list[str] = []
        chars = 0
        last_reported = 0
        provider = ""
        async for kind, payload in llm_stream(
            system_prompt=system_prompt,
            user_text=user_text,
            actor_id=actor_id,
            max_tokens=16384,
            fake=lambda: _fake_revision(html, instruction),
        ):
            if kind == "provider":
                provider = payload
                yield {"stage": "generating", "provider": provider}
                continue
            parts.append(payload)
            chars += len(payload)
            if chars - last_reported >= 1500:
                last_reported = chars
                yield {"progress": {"chars": chars}}
        revised, summary = split_summary(_strip_fence("".join(parts)))
        if not revised:
            yield {"error": {"code": "llm_failed", "message": "LLM が空の改訂を返しました"}}
            return
        yield {"stage": "saving"}
        created = await _persist_revision(
            session,
            actor_id=actor_id,
            mock_id=mock_id,
            current=current,
            revised=revised,
            summary=summary,
            instruction=instruction,
            used_model=provider or "unknown",
        )
        if created is None:
            yield {"error": {"code": "not_found", "message": "mock not found"}}
            return
        yield {"result": {**created.model_dump(mode="json"), "summary": summary}}
    except LLMUnavailable as exc:
        yield {"error": {"code": _map_unavailable(exc.code), "message": exc.message}}
    except MockReviseError as exc:
        yield {"error": {"code": exc.code, "message": exc.message}}
