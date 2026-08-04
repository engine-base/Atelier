# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
"""議事録の構造化解析 (GAP-015) — transcription 後段の LLM 解析。

Whisper (GAP-016 worker) が生成した文字起こしテキストから、S-M01 モックの
解析ブロックに対応する構造を抽出する:
  - summary: 3〜5 文の要約
  - speakers: 話者の推定リスト (名前/役割)
  - requirements: 抽出された要件
  - action_items: アクションアイテム (内容 + 担当)

LLM は selected-stack (v1 = Anthropic) の AnthropicClient を使う。
ANTHROPIC_API_KEY 未設定なら AnalysisError("llm_unconfigured") — 呼び出し側
(worker) は transcription 自体は成功のまま analysis_error として保存し、
UI は誠実に「解析未実行」を表示する (偽の解析結果を出さない)。
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Protocol

from src.llm.client import LLMMessage

# 解析に流す本文の上限 (トークン超過対策。超過分は末尾を切り notice を付ける)。
_MAX_TRANSCRIPT_CHARS = 24_000

ANALYSIS_MODEL = os.environ.get("ATELIER_ANALYSIS_MODEL", "claude-sonnet-4-6")

_SYSTEM = (
    "あなたは開発案件管理 SaaS の議事録解析アシスタントです。"
    "与えられた打合せ文字起こしから JSON だけを出力してください。"
    'スキーマ: {"summary": string (3〜5 文の日本語要約), '
    '"speakers": [{"name": string, "role": string|null}], '
    '"requirements": [string], '
    '"action_items": [{"title": string, "owner": string|null}]}。'
    "根拠のない情報を創作しないこと。話者が特定できなければ speakers は空配列。"
    "JSON 以外の文字 (説明・コードフェンス) を出力しないこと。"
)


class AnalysisError(Exception):
    """解析不可の分類 (code: llm_unconfigured / llm_failed / parse_failed)。"""

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
        stop_sequences: list[str] | None = ...,
    ) -> Any: ...


def _extract_json(text: str) -> dict[str, Any]:
    """LLM 応答から JSON オブジェクトを取り出す (コードフェンス混入も許容)。"""
    candidate = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", candidate, re.DOTALL)
    if fence:
        candidate = fence.group(1)
    else:
        brace = re.search(r"\{.*\}", candidate, re.DOTALL)
        if brace:
            candidate = brace.group(0)
    try:
        loaded: Any = json.loads(candidate)
    except json.JSONDecodeError as e:
        raise AnalysisError("parse_failed", f"LLM 応答が JSON でない: {e}") from e
    if not isinstance(loaded, dict):
        raise AnalysisError("parse_failed", "LLM 応答が JSON オブジェクトでない")
    return loaded


def _normalize(payload: dict[str, Any]) -> dict[str, Any]:
    """スキーマ外キーを落とし、型を保証する (UI が undefined 参照で壊れない)。"""
    speakers: list[dict[str, Any]] = []
    for s in payload.get("speakers") or []:
        if isinstance(s, dict) and s.get("name"):
            speakers.append({"name": str(s["name"]), "role": s.get("role") or None})
    action_items: list[dict[str, Any]] = []
    for a in payload.get("action_items") or []:
        if isinstance(a, dict) and a.get("title"):
            action_items.append({"title": str(a["title"]), "owner": a.get("owner") or None})
        elif isinstance(a, str) and a:
            action_items.append({"title": a, "owner": None})
    return {
        "summary": str(payload.get("summary") or ""),
        "speakers": speakers,
        "requirements": [str(r) for r in (payload.get("requirements") or []) if r],
        "action_items": action_items,
        "model": ANALYSIS_MODEL,
    }


async def analyze_transcript(
    transcript_text: str, *, client: _CompletionClient | None = None
) -> dict[str, Any]:
    """文字起こし本文を構造化解析する。失敗は AnalysisError。"""
    if client is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise AnalysisError("llm_unconfigured", "ANTHROPIC_API_KEY is not configured")
        from src.llm.anthropic import AnthropicClient

        client = AnthropicClient()

    body = transcript_text
    truncated = False
    if len(body) > _MAX_TRANSCRIPT_CHARS:
        body = body[:_MAX_TRANSCRIPT_CHARS]
        truncated = True

    try:
        res = await client.complete(
            model=ANALYSIS_MODEL,
            messages=[LLMMessage(role="user", content=f"文字起こし:\n{body}")],
            system=_SYSTEM,
            max_tokens=2048,
            temperature=0.2,
        )
    except AnalysisError:
        raise
    except Exception as e:
        raise AnalysisError("llm_failed", f"LLM 呼出に失敗: {e}") from e

    result = _normalize(_extract_json(str(res.text)))
    if truncated:
        result["truncated"] = True
    return result
