# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
"""S-H01 モック「編集」= ワンダ (AI デザイナー) への修正依頼 (GAP-024)。

確定アーキ (decision_log / selected-libraries.md): モック生成・反復は
Open Design パターン (自然言語指示 → agent が HTML を生成) を直接活用する。
Atelier では担当 = デザイナー AI 社員ワンダで、S-H01 のバージョン author が
「ワンダ（更新）」なのはこのフロー。人間が HTML を手で書く編集ではない。

フロー:
  1. 現行バージョンの HTML を storage から取得 (署名付き URL)
  2. LLM (selected-stack v1 = AnthropicClient) が指示に従って全文 HTML を改訂
     - ANTHROPIC_API_KEY 未設定は llm_unconfigured (503 — 偽の改訂を出さない)
     - テストのみ ATELIER_ALLOW_FAKE_LLM=1 で決定的スタブ改訂 (配線検証用)
  3. 改訂 HTML を storage へアップロード (新オブジェクト)
  4. mocks に新バージョン行 (parent_mock_id 連鎖、meta に指示文 + author=wanda)
"""

from __future__ import annotations

import os
import uuid
from typing import Any, Protocol

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from src.llm.client import LLMMessage
from src.schemas.mocks import MockResponse, MockVersionCreate
from src.storage_signing import create_signed_download_url, create_signed_upload_url

from . import create_version, get_mock

REVISE_MODEL = os.environ.get("ATELIER_DESIGN_MODEL", "claude-sonnet-4-6")

_MAX_HTML_CHARS = 60_000

_SYSTEM = (
    "あなたは開発案件管理 SaaS のデザイナー AI「ワンダ」です。"
    "与えられた HTML モックを、修正指示に従って改訂してください。"
    "出力は改訂後の完全な HTML 全文のみ。説明・コードフェンス・前置きを一切出力しないこと。"
    "指示に無関係な部分は変更しないこと。"
)


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
    if "<body" in html:
        head, sep, tail = html.partition(">")
        if sep and "<body" in head:
            return f"{head}>{banner}{tail}"
        idx = html.find("<body")
        end = html.find(">", idx)
        if end >= 0:
            return html[: end + 1] + banner + html[end + 1 :]
    return banner + html


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
) -> MockResponse | None:
    """修正指示から新バージョンを生成する。返り値 None = mock 不可視/不在。"""
    current = await get_mock(session, mock_id)
    if current is None:
        return None

    html = await _download_html(current.html_storage_path)
    if len(html) > _MAX_HTML_CHARS:
        raise MockReviseError(
            "too_large", f"mock html exceeds {_MAX_HTML_CHARS} chars — 分割を検討してください"
        )

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
        revised = _strip_fence(str(res.text))
        used_model = REVISE_MODEL
    else:
        # GAP-138: 確定アーキテクチャの費用順 (relay=本人サブスク → agent_sdk →
        # API → fake)。ANTHROPIC_API_KEY 直依存をやめる。
        from src.services.chat_sse.llm_chain import LLMUnavailable, llm_complete

        try:
            out, provider = await llm_complete(
                system_prompt=_SYSTEM,
                user_text=f"修正指示:\n{instruction}\n\n現行 HTML:\n{html}",
                actor_id=actor_id,
                max_tokens=16384,
                fake=lambda: _fake_revision(html, instruction),
            )
        except LLMUnavailable as exc:
            code = {
                "bridge_offline": "bridge_offline",
                "unconfigured": "llm_unconfigured",
            }.get(exc.code, "llm_failed")
            raise MockReviseError(code, exc.message) from exc
        revised = _strip_fence(out)
        used_model = provider
    if not revised:
        raise MockReviseError("llm_failed", "LLM が空の改訂を返しました")

    # GAP-138: mockdb モックは mockdb へ、Supabase 由来は Supabase へ (系を跨がない)
    from .artifacts import MOCKDB_PREFIX, store_content_service

    if current.html_storage_path.startswith(MOCKDB_PREFIX):
        new_path = f"{MOCKDB_PREFIX}{await store_content_service(revised)}"
    else:
        new_path = f"mocks/{current.project_id}/{uuid.uuid4()}/{current.screen_name}-rev.html"
        await _upload_html(new_path, revised)

    return await create_version(
        session,
        actor_id=actor_id,
        mock_id=mock_id,
        data=MockVersionCreate(
            html_storage_path=new_path,
            meta_tags={
                "author": "wanda",
                "revision_instruction": instruction,
                "revised_from_version": current.version,
                "model": used_model,
            },
        ),
    )
