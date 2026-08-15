# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
"""S-G01 成果物の「編集」= ドキュメント AI (スティーブ) への修正依頼 (GAP-023)。

成果物 (workflow_outputs) は工程で AI 社員が生成する文書であり、確定アーキ
(Open Design パターンと同型 — GAP-024 の S-H01 と同じ設計判断) に従い
「編集」は人間の HTML 手編集ではなく、担当ドキュメント AI スティーブへの
自然言語の修正依頼 → LLM が全文 HTML を改訂 → 新バージョン行の追加で実装する。
モック S-G01 の ai-fix ブロック (「スティーブの修正提案」) と同一の主体。

フロー:
  1. 現行バージョンの HTML を storage から取得 (署名付き URL)
  2. LLM (AnthropicClient) が指示に従って全文 HTML を改訂
     - ANTHROPIC_API_KEY 未設定は llm_unconfigured (503 — 偽の改訂を出さない)
     - テストのみ ATELIER_ALLOW_FAKE_LLM=1 で決定的スタブ改訂 (配線検証用)
  3. 改訂 HTML を storage へアップロード (新オブジェクト)
  4. workflow_outputs に新バージョン行 (version+1、meta に指示文 + author=steve)
"""

from __future__ import annotations

import html as html_mod
import os
import re
import uuid
from typing import Any, Protocol

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.llm.client import LLMMessage
from src.schemas.outputs import OutputAnchorResponse, OutputResponse
from src.storage_signing import create_signed_download_url, create_signed_upload_url

from . import get_output, insert_version

REVISE_MODEL = os.environ.get("ATELIER_DOC_MODEL", "claude-sonnet-4-6")

_MAX_HTML_CHARS = 60_000

_SYSTEM = (
    "あなたは開発案件管理 SaaS のドキュメント AI「スティーブ」です。"
    "与えられた成果物 HTML (要件定義書等) を、修正指示に従って改訂してください。"
    "出力は改訂後の完全な HTML 全文のみ。説明・コードフェンス・前置きを一切出力しないこと。"
    "指示に無関係な部分は変更しないこと。既存要素の id 属性は保持すること。"
)


class OutputReviseError(Exception):
    """修正依頼の構造的失敗 (code: llm_unconfigured / llm_failed /
    storage_unconfigured / content_unavailable / no_html / too_large)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class CompletionClient(Protocol):
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

    指示バナーを可視挿入することで「新バージョンの実体が本当に変わった」
    ことを E2E で検証可能にする。実 LLM の代替ではない。
    """
    banner = (
        '<div data-fake-revision="1" style="background:#FEF3C7;padding:8px 12px;'
        'font-size:12px;border-bottom:1px solid #F59E0B;">'
        f"[fake LLM] 修正依頼を適用: {instruction}</div>"
    )
    if "<body" in html:
        idx = html.find("<body")
        end = html.find(">", idx)
        if end >= 0:
            return html[: end + 1] + banner + html[end + 1 :]
    return banner + html


async def download_html(storage_path: str) -> str:
    url = await create_signed_download_url(storage_path)
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(url)
    if r.status_code >= 400:
        raise OutputReviseError(
            "content_unavailable", f"failed to download output html: {r.status_code}"
        )
    return r.text


async def _upload_html(storage_path: str, html: str) -> None:
    url = await create_signed_upload_url(storage_path)
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.put(
            url, content=html.encode("utf-8"), headers={"Content-Type": "text/html"}
        )
    if r.status_code >= 400:
        raise OutputReviseError("llm_failed", f"failed to upload revised html: {r.status_code}")


def _strip_fence(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        first_nl = t.find("\n")
        if first_nl >= 0:
            t = t[first_nl + 1 :]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


_TAG_RE = re.compile(r"<[^>]+>")
_ANCHOR_RE = re.compile(
    r"<(?P<tag>[a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bid=\"(?P<id>[^\"]+)\"[^>]*>(?P<rest>.{0,400}?)</",
    re.DOTALL,
)


def extract_anchors(html: str, *, limit: int = 50) -> list[OutputAnchorResponse]:
    """HTML から id 付き要素を抽出し、コメントの対象位置候補にする。

    label は開始タグ直後のテキスト (タグ除去・空白正規化・60 字まで)。
    実 HTML に存在する id のみを返す — 推測候補は作らない。
    """
    anchors: list[OutputAnchorResponse] = []
    seen: set[str] = set()
    for m in _ANCHOR_RE.finditer(html):
        el_id = m.group("id")
        if el_id in seen:
            continue
        seen.add(el_id)
        raw = _TAG_RE.sub(" ", m.group("rest"))
        label = html_mod.unescape(re.sub(r"\s+", " ", raw)).strip()[:60]
        anchors.append(OutputAnchorResponse(element_id=el_id, label=label or el_id))
        if len(anchors) >= limit:
            break
    return anchors


async def run_revision(
    html: str, instruction: str, client: CompletionClient | None
) -> tuple[str, str]:
    """LLM (または fake スタブ) で HTML を改訂する。返り値 (改訂 HTML, 使用モデル)。"""
    allow_fake = os.environ.get("ATELIER_ALLOW_FAKE_LLM") == "1"
    if client is None and not os.environ.get("ANTHROPIC_API_KEY"):
        if allow_fake:
            return _fake_revision(html, instruction), "fake-llm"
        raise OutputReviseError(
            "llm_unconfigured",
            "ANTHROPIC_API_KEY が未設定のためドキュメント AI による改訂を実行できません",
        )
    if client is None:
        from src.llm.anthropic import AnthropicClient

        client = AnthropicClient()
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
        raise OutputReviseError("llm_failed", f"LLM 呼出に失敗: {e}") from e
    revised = _strip_fence(str(res.text))
    if not revised:
        raise OutputReviseError("llm_failed", "LLM が空の改訂を返しました")
    return revised, REVISE_MODEL


async def revise_output(
    session: AsyncSession,
    *,
    actor_id: str,
    output_id: str,
    instruction: str,
    client: CompletionClient | None = None,
    audit_action: str = "output.revise",
) -> OutputResponse | None:
    """修正指示から新バージョンを生成する。返り値 None = output 不可視/不在。"""
    current = await get_output(session, output_id)
    if current is None:
        return None
    if current.html_path is None:
        raise OutputReviseError("no_html", "この成果物には改訂対象の HTML がありません")

    html = await download_html(current.html_path)
    if len(html) > _MAX_HTML_CHARS:
        raise OutputReviseError(
            "too_large", f"output html exceeds {_MAX_HTML_CHARS} chars — 分割を検討してください"
        )

    revised, used_model = await run_revision(html, instruction, client)

    new_path = f"outputs/{current.project_id}/{uuid.uuid4()}/{current.stage}-rev.html"
    await _upload_html(new_path, revised)

    created = await insert_version(
        session,
        src=current,
        html_path=new_path,
        meta={
            "author": "steve",
            "revision_instruction": instruction,
            "revised_from_version": current.version,
            "model": used_model,
        },
    )
    await AuditWriter(session).write(
        AuditEvent(
            action=audit_action,
            target_type="workflow_output",
            actor_type="user",
            actor_id=actor_id,
            target_id=created.id,
            after={
                "source_output_id": output_id,
                "version": created.version,
                "instruction": instruction[:200],
            },
        )
    )
    return created
