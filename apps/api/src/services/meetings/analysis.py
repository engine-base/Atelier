# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
"""議事録の構造化解析 (GAP-015 → GAP-184 で全面改訂)。

**GAP-184 以前の実態** (経営者指摘「要件を 2〜3 行って絶対そうだけではないよね？
1 時間とかオンラインで話した内容なのにそんなに薄いわけではないはず」):

  1. `_MAX_TRANSCRIPT_CHARS = 24_000` で本文を**打ち切っていた**。日本語の会話は
     約 300〜400 字/分なので、**1 時間の会議でちょうど上限に達し、それ以降は
     末尾が丸ごと消えていた**。2 時間の会議なら後半 1 時間が存在しないことになる。
  2. `max_tokens=2048` (日本語で約 1,300〜1,600 字)。**厚い解析は物理的に不可能**な設定。
  3. 抽出項目が 要約・話者・要件・アクションの 4 つだけ。**決定事項・論点・
     数値/金額/期限・リスク・未決事項が丸ごと欠落**していた。

**GAP-184 の方針**:

  - **打ち切りをやめる**。長い会議はチャンクに分割し、各チャンクを解析してから
    統合する (map-reduce)。2 時間でも 3 時間でも全部読む。
  - **9 セクション**に拡張: 要約 / 話者 / 議題 / 決定事項 / 要件 / 論点(未決) /
    リスク / アクション / 事実(数値・日付・金額) / 次回。
  - 各項目に **`quote` (文字起こしからの引用)** を必須にする。人が「本当にそう
    言っていたか」を照合できる = 創作を検出できる。根拠を出せない項目は捨てる。
  - 実行は本人の Claude サブスク (Bridge)。未接続なら `bridge_offline` を上げ、
    呼び出し側が行を保留して後で再試行する (GAP-177)。
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Protocol

from src.llm.client import LLMMessage

#: 1 チャンクに流す本文の上限。Claude の入力窓ではなく「1 回の解析で扱える
#: 密度」で決める。細かすぎると文脈が切れ、大きすぎると取りこぼす。
CHUNK_CHARS = 10_000

#: チャンク間の重なり。話題が境目で分断されて片方に寄るのを防ぐ。
CHUNK_OVERLAP_CHARS = 400

#: 1 チャンクあたりの出力上限。旧 2048 では厚い解析が物理的に不可能だった。
CHUNK_MAX_TOKENS = 4_000

#: 統合後の全体要約の出力上限。
MERGE_MAX_TOKENS = 2_000

#: 安全弁。これを超えるチャンク数になる本文は先頭から順に処理して打ち切る
#: (打ち切った事実は結果に truncated として残す — 黙って捨てない)。
MAX_CHUNKS = 24

ANALYSIS_MODEL = os.environ.get("ATELIER_ANALYSIS_MODEL", "claude-sonnet-4-6")

_SCHEMA_DESC = (
    '{"summary": string (この区間で何が話されたかの要約), '
    '"speakers": [{"name": string, "role": string|null}], '
    '"agenda": [string], '
    '"decisions": [{"title": string, "detail": string, "decided_by": string|null, "quote": string}], '
    '"requirements": [{"title": string, "detail": string, '
    '"kind": "functional"|"non_functional"|"constraint", '
    '"priority": "must"|"should"|"could", "quote": string}], '
    '"open_questions": [{"question": string, "context": string, "quote": string}], '
    '"risks": [{"title": string, "impact": string, "quote": string}], '
    '"action_items": [{"title": string, "owner": string|null, "due": string|null, "quote": string}], '
    '"facts": [{"label": string, "value": string, "quote": string}], '
    '"next_meeting": {"date": string|null, "agenda": string|null}|null}'
)

_SYSTEM = (
    "あなたは開発案件の議事録を構造化する専門家です。"
    "与えられた打合せ文字起こしから JSON だけを出力してください。\n"
    f"スキーマ: {_SCHEMA_DESC}\n"
    "厳守事項:\n"
    "- **必ず `quote` に文字起こしからの実際の発言を引用**すること。"
    "引用できない項目は出力しない (推測・一般論を書かない)。\n"
    "- decisions は『決まったこと』。まだ決まっていないものは open_questions に入れる。\n"
    "- requirements は機能要件 (functional) / 非機能要件 (non_functional) / "
    "制約 (constraint) を区別し、発言の強さから priority を付ける。\n"
    "- facts には**数値・金額・日付・期限・件数・固有名詞**を漏らさず入れる"
    "(ここが最も取りこぼしやすい)。\n"
    "- 1 時間の打合せなら decisions・requirements・open_questions は"
    "合計 10 件以上あるのが普通。**薄くまとめないこと**。\n"
    "- JSON 以外の文字 (説明・コードフェンス) を出力しないこと。"
)

_MERGE_SYSTEM = (
    "あなたは議事録の編集者です。同じ打合せを時系列で分割解析した複数の要約が"
    "与えられます。全体を通した要約を日本語で書いてください。\n"
    '出力は JSON のみ: {"summary": string}\n'
    "- 打合せ全体の流れ (何を話し、何が決まり、何が残ったか) が分かる 5〜10 文。\n"
    "- 与えられた材料に無い事実を創作しないこと。"
)


class AnalysisError(Exception):
    """解析不可の分類 (code: bridge_offline / llm_failed / parse_failed / empty)。"""

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


#: GAP-177: 「今は無理だが後でやれば成功しうる」失敗。行を保留にして再試行する。
#: GAP-184: レート制限 (本人プランの 5 時間 / 7 日枠) も同じ扱いにする。
#: 上限は必ずリセットされるので「失敗」で確定させるのは嘘。
RETRYABLE_CODES = frozenset({"bridge_offline", "llm_unconfigured", "rate_limited"})


# --------------------------------------------------------------------------- #
# 分割
# --------------------------------------------------------------------------- #


def split_transcript(text: str) -> list[str]:
    """本文をチャンクに分割する (境目で話題が切れないよう重ねる)。

    打ち切らない。長い会議は「分けて全部読む」。
    """
    body = text.strip()
    if not body:
        return []
    if len(body) <= CHUNK_CHARS:
        return [body]
    chunks: list[str] = []
    start = 0
    while start < len(body) and len(chunks) < MAX_CHUNKS:
        end = min(start + CHUNK_CHARS, len(body))
        chunks.append(body[start:end])
        if end >= len(body):
            break
        start = end - CHUNK_OVERLAP_CHARS
    return chunks


# --------------------------------------------------------------------------- #
# 正規化
# --------------------------------------------------------------------------- #


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


def _s(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _opt(value: Any) -> str | None:
    out = _s(value)
    return out or None


def _items(payload: dict[str, Any], key: str) -> list[Any]:
    raw = payload.get(key)
    return list(raw) if isinstance(raw, list) else []


def _norm_speakers(payload: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for s in _items(payload, "speakers"):
        if isinstance(s, dict) and _s(s.get("name")):
            out.append({"name": _s(s.get("name")), "role": _opt(s.get("role"))})
        elif isinstance(s, str) and s.strip():
            out.append({"name": s.strip(), "role": None})
    return out


_KINDS = {"functional", "non_functional", "constraint"}
_PRIORITIES = {"must", "should", "could"}


def _norm_requirements(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """要件を正規化する。旧形式 (文字列だけ) も受ける (過去データ互換)。"""
    out: list[dict[str, Any]] = []
    for r in _items(payload, "requirements"):
        if isinstance(r, str):
            if r.strip():
                out.append(
                    {
                        "title": r.strip(),
                        "detail": "",
                        "kind": "functional",
                        "priority": "should",
                        "quote": "",
                    }
                )
            continue
        if not isinstance(r, dict) or not _s(r.get("title")):
            continue
        kind = _s(r.get("kind"))
        priority = _s(r.get("priority"))
        out.append(
            {
                "title": _s(r.get("title")),
                "detail": _s(r.get("detail")),
                "kind": kind if kind in _KINDS else "functional",
                "priority": priority if priority in _PRIORITIES else "should",
                "quote": _s(r.get("quote")),
            }
        )
    return out


def _norm_action_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for a in _items(payload, "action_items"):
        if isinstance(a, str):
            if a.strip():
                out.append({"title": a.strip(), "owner": None, "due": None, "quote": ""})
            continue
        if isinstance(a, dict) and _s(a.get("title")):
            out.append(
                {
                    "title": _s(a.get("title")),
                    "owner": _opt(a.get("owner")),
                    "due": _opt(a.get("due")),
                    "quote": _s(a.get("quote")),
                }
            )
    return out


def _norm_objects(
    payload: dict[str, Any], key: str, fields: tuple[str, ...], required: str
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in _items(payload, key):
        if isinstance(item, str):
            if item.strip():
                row = dict.fromkeys(fields, "")
                row[required] = item.strip()
                out.append(row)
            continue
        if isinstance(item, dict) and _s(item.get(required)):
            out.append({f: _s(item.get(f)) for f in fields})
    return out


def _norm_next_meeting(payload: dict[str, Any]) -> dict[str, Any] | None:
    nm = payload.get("next_meeting")
    if not isinstance(nm, dict):
        return None
    date = _opt(nm.get("date"))
    agenda = _opt(nm.get("agenda"))
    if date is None and agenda is None:
        return None
    return {"date": date, "agenda": agenda}


def normalize(payload: dict[str, Any]) -> dict[str, Any]:
    """スキーマ外キーを落とし、型を保証する (UI が undefined 参照で壊れない)。"""
    return {
        "summary": _s(payload.get("summary")),
        "speakers": _norm_speakers(payload),
        "agenda": [_s(a) for a in _items(payload, "agenda") if _s(a)],
        "decisions": _norm_objects(
            payload, "decisions", ("title", "detail", "decided_by", "quote"), "title"
        ),
        "requirements": _norm_requirements(payload),
        "open_questions": _norm_objects(
            payload, "open_questions", ("question", "context", "quote"), "question"
        ),
        "risks": _norm_objects(payload, "risks", ("title", "impact", "quote"), "title"),
        "action_items": _norm_action_items(payload),
        "facts": _norm_objects(payload, "facts", ("label", "value", "quote"), "label"),
        "next_meeting": _norm_next_meeting(payload),
    }


# --------------------------------------------------------------------------- #
# 統合 (map-reduce の reduce)
# --------------------------------------------------------------------------- #


def _key_of(item: dict[str, Any], field: str) -> str:
    """重複判定キー。表記ゆれを吸収するため記号と空白を落とす。"""
    return re.sub(r"[\s、。・,.\-—「」『』()（）]+", "", _s(item.get(field))).lower()


def merge_sections(parts: list[dict[str, Any]]) -> dict[str, Any]:
    """チャンクごとの解析結果を 1 つに統合する (重複は先勝ちで 1 件に)。"""
    merged: dict[str, Any] = {
        "summary": "",
        "speakers": [],
        "agenda": [],
        "decisions": [],
        "requirements": [],
        "open_questions": [],
        "risks": [],
        "action_items": [],
        "facts": [],
        "next_meeting": None,
    }
    dedupe_field = {
        "decisions": "title",
        "requirements": "title",
        "open_questions": "question",
        "risks": "title",
        "action_items": "title",
        "facts": "label",
    }
    seen: dict[str, set[str]] = {k: set() for k in dedupe_field}
    seen_speakers: set[str] = set()
    seen_agenda: set[str] = set()

    for part in parts:
        for sp in part.get("speakers", []):
            name = _s(sp.get("name"))
            if name and name not in seen_speakers:
                seen_speakers.add(name)
                merged["speakers"].append(sp)
        for topic in part.get("agenda", []):
            norm = re.sub(r"\s+", "", topic).lower()
            if norm and norm not in seen_agenda:
                seen_agenda.add(norm)
                merged["agenda"].append(topic)
        for key, field in dedupe_field.items():
            for item in part.get(key, []):
                k = _key_of(item, field)
                if k and k not in seen[key]:
                    seen[key].add(k)
                    merged[key].append(item)
        if merged["next_meeting"] is None and part.get("next_meeting"):
            merged["next_meeting"] = part["next_meeting"]
    return merged


# --------------------------------------------------------------------------- #
# 本体
# --------------------------------------------------------------------------- #


async def _analyze_chunk(
    chunk: str,
    *,
    index: int,
    total: int,
    client: _CompletionClient | None,
    actor_id: str,
) -> dict[str, Any]:
    from src.services.chat_sse.llm_chain import LLMUnavailable, llm_complete_or_injected

    position = (
        f"(この文字起こしは全 {total} 区間のうち {index + 1} 区間目です)\n" if total > 1 else ""
    )
    try:
        out, _provider = await llm_complete_or_injected(
            system_prompt=_SYSTEM,
            user_text=f"{position}文字起こし:\n{chunk}",
            actor_id=actor_id,
            max_tokens=CHUNK_MAX_TOKENS,
            fake=lambda: _fake_analysis(chunk),
            client=client,
            model=ANALYSIS_MODEL,
        )
    except LLMUnavailable as exc:
        raise _to_analysis_error(exc) from exc
    except AnalysisError:
        raise
    except Exception as e:
        raise AnalysisError("llm_failed", f"LLM 呼出に失敗: {e}") from e
    return normalize(_extract_json(out))


def _to_analysis_error(exc: Any) -> AnalysisError:
    """LLMUnavailable を解析エラーに翻訳する (再試行可否を落とさない)。"""
    code = getattr(exc, "code", "")
    message = getattr(exc, "message", str(exc))
    if code in ("bridge_offline", "unconfigured", "llm_unconfigured"):
        return AnalysisError("bridge_offline", message)
    if code in ("rate_limited", "rate_limit"):
        # GAP-184: 本人プランの上限は必ずリセットされる。失敗で確定させない。
        return AnalysisError("rate_limited", message)
    return AnalysisError("llm_failed", f"LLM 呼出に失敗: {message}")


async def _merge_summary(
    parts: list[dict[str, Any]],
    *,
    client: _CompletionClient | None,
    actor_id: str,
) -> str:
    """区間ごとの要約から全体の流れを書き直す。失敗したら連結でしのぐ。"""
    from src.services.chat_sse.llm_chain import llm_complete_or_injected

    material = "\n\n".join(
        f"[区間 {i + 1}] {p.get('summary', '')}" for i, p in enumerate(parts) if p.get("summary")
    )
    if not material:
        return ""
    try:
        out, _provider = await llm_complete_or_injected(
            system_prompt=_MERGE_SYSTEM,
            user_text=material,
            actor_id=actor_id,
            max_tokens=MERGE_MAX_TOKENS,
            fake=lambda: json.dumps({"summary": material}, ensure_ascii=False),
            client=client,
            model=ANALYSIS_MODEL,
        )
        return _s(_extract_json(out).get("summary")) or material
    except Exception:
        # 統合要約が書けなくても区間要約は残す (解析全体を捨てない)
        return material


async def analyze_transcript(
    transcript_text: str,
    *,
    client: _CompletionClient | None = None,
    actor_id: str = "",
) -> dict[str, Any]:
    """文字起こし本文を構造化解析する。失敗は AnalysisError。

    GAP-184: 本文を**打ち切らない**。長ければ分割して全部読み、統合して返す。
    GAP-177: 実行は本人の Claude サブスク (Bridge)。未接続や本人プランの上限中は
    `bridge_offline` / `rate_limited` を上げ、呼び出し側が行を保留して再試行する。
    """
    chunks = split_transcript(transcript_text)
    if not chunks:
        raise AnalysisError("empty", "文字起こし本文が空です")

    truncated = len(transcript_text.strip()) > CHUNK_CHARS and len(chunks) >= MAX_CHUNKS

    parts: list[dict[str, Any]] = []
    for i, chunk in enumerate(chunks):
        parts.append(
            await _analyze_chunk(
                chunk, index=i, total=len(chunks), client=client, actor_id=actor_id
            )
        )

    if len(parts) == 1:
        result = parts[0]
    else:
        result = merge_sections(parts)
        result["summary"] = await _merge_summary(parts, client=client, actor_id=actor_id)

    result["model"] = ANALYSIS_MODEL
    result["segments"] = len(chunks)
    result["source_chars"] = len(transcript_text.strip())
    if truncated:
        # 黙って捨てない。画面に「後半が解析されていない」と出せるようにする。
        result["truncated"] = True
    return result


def _fake_analysis(body: str) -> str:
    """ATELIER_ALLOW_FAKE_LLM=1 のみの決定的スタブ (配線検証用)。"""
    return json.dumps(
        {
            "summary": f"[fake LLM] 文字起こし {len(body)} 文字の要約",
            "speakers": [],
            "agenda": [],
            "decisions": [],
            "requirements": [],
            "open_questions": [],
            "risks": [],
            "action_items": [],
            "facts": [],
            "next_meeting": None,
        },
        ensure_ascii=False,
    )


__all__ = [
    "ANALYSIS_MODEL",
    "CHUNK_CHARS",
    "RETRYABLE_CODES",
    "AnalysisError",
    "analyze_transcript",
    "merge_sections",
    "normalize",
    "split_transcript",
]
