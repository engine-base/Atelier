"""GAP-186: 議事録の抽出項目を「確認して採用」→ 要件・タスク・決定へ反映する。

経営者指示「1,2 だね」の ①:
    議事録の解析結果 (GAP-184 で 9 セクションに厚くした) を、人が確認して
    採用したものだけプロジェクトの実データに落とす。

**自動反映はしない。** AI の抽出をそのまま正にすると、聞き間違い・言い過ぎが
そのままプロジェクトの要件として固定される。GAP-156 (既存資料の取り込み) と
同じで「提案 → 人がチェック → 確定」の形にする。

反映先は議事録の項目ごとに決まっている:

    要件 (requirements)     → tasks   … 実装単位に落ちるもの
    アクション (action_items) → tasks   … 誰が何をいつまでに
    決定事項 (decisions)      → decisions (decided)   … 決まったこと
    未決事項 (open_questions) → decisions (unresolved) … まだ決まっていないこと

リスク・数値・議題は「読むためのもの」なので反映先を持たない (無理に
タスク化すると台帳がノイズで埋まる)。

採用したものは meeting_adoptions に台帳として残す。二重採用の防止と、
「この要件はどの議事録から来たか」の追跡を兼ねる。
"""

from __future__ import annotations

import logging
import re
import uuid as uuid_mod
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter

logger = logging.getLogger(__name__)

#: 採用できる種別と、その反映先。
KIND_TARGET: dict[str, str] = {
    "requirement": "task",
    "action": "task",
    "decision": "decision",
    "open_question": "decision",
}

#: 議事録の解析 JSON における配列名 (種別 → キー)。
KIND_SECTION: dict[str, str] = {
    "requirement": "requirements",
    "action": "action_items",
    "decision": "decisions",
    "open_question": "open_questions",
}

#: 種別ごとの「見出しに使うフィールド」(GAP-184 の normalize と一致させる)。
KIND_TITLE_FIELD: dict[str, str] = {
    "requirement": "title",
    "action": "title",
    "decision": "title",
    "open_question": "question",
}

#: 要件の種類 → タスク種別。非機能・制約は実装の土台側に寄せる。
REQUIREMENT_TASK_TYPE: dict[str, str] = {
    "functional": "feature",
    "non_functional": "infrastructure",
    "constraint": "foundation",
}

#: 要件の優先度 → タスク優先度。
REQUIREMENT_PRIORITY: dict[str, str] = {
    "must": "high",
    "should": "medium",
    "could": "low",
}

#: 工数は議事録には書かれていない。作った時点では未確定である旨を本文に残す。
DEFAULT_ESTIMATED_HOURS = 4

_HOURS_UNKNOWN_NOTE = "工数は議事録に書かれていないため未確定です。分解時に見直してください。"

#: 1 回の採用で作れる上限 (誤操作で台帳が溢れるのを防ぐ)。
MAX_ADOPT_PER_CALL = 50


class AdoptError(Exception):
    """採用操作の状態不整合 (code: not_found / invalid_state / too_many)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def item_key(kind: str, title: str) -> str:
    """議事録側の 1 項目を指す安定キー。

    見出しの表記ゆれ (空白・全角半角) で別項目に見えないよう正規化する。
    解析をやり直しても同じ項目なら同じキーになるので、二重採用を防げる。
    """
    normalized = re.sub(r"\s+", " ", str(title)).strip().lower()
    return f"{kind}:{normalized}"[:400]


@dataclass(frozen=True)
class AdoptableItem:
    """画面に出す 1 項目。採用済みなら反映先へのリンクも持つ。"""

    kind: str
    key: str
    title: str
    detail: str
    quote: str
    meta: dict[str, str]
    adopted: bool
    target_type: str | None
    target_id: str | None


def _str(value: Any) -> str:
    return "" if value is None else str(value)


def extract_items(analysis: dict[str, Any]) -> list[dict[str, Any]]:
    """解析結果から「採用できる項目」だけを取り出す (反映先を持つ 4 種)。

    見出しが空の項目は落とす — 空の箱をタスクにしない。
    """
    out: list[dict[str, Any]] = []
    for kind, section in KIND_SECTION.items():
        raw = analysis.get(section)
        if not isinstance(raw, list):
            continue
        field = KIND_TITLE_FIELD[kind]
        for entry in raw:  # pyright: ignore[reportUnknownVariableType]
            if not isinstance(entry, dict):
                continue
            item: dict[str, Any] = entry  # pyright: ignore[reportUnknownVariableType]
            title = _str(item.get(field)).strip()
            if title == "":
                continue
            meta: dict[str, str] = {}
            for name in ("kind", "priority", "owner", "due", "decided_by", "context"):
                value = _str(item.get(name)).strip()
                if value != "":
                    meta[name] = value
            out.append(
                {
                    "kind": kind,
                    "key": item_key(kind, title),
                    "title": title,
                    "detail": _str(item.get("detail")).strip(),
                    "quote": _str(item.get("quote")).strip(),
                    "meta": meta,
                }
            )
    return out


async def _meeting_row(session: AsyncSession, *, meeting_id: str) -> Any:
    try:
        meeting_id = str(uuid_mod.UUID(meeting_id))
    except ValueError:
        raise AdoptError("not_found", "議事録が見つかりません。") from None
    row = (
        await session.execute(
            text(
                "select id, project_id, file_name, parse_result_path, analysis_pending_since "
                "from public.external_uploads "
                "where id = cast(:i as uuid) and deleted_at is null"
            ),
            {"i": meeting_id},
        )
    ).first()
    if row is None:
        raise AdoptError("not_found", "議事録が見つかりません。")
    return row


async def load_meeting_analysis(row: Any) -> dict[str, Any]:
    """GAP-187: 保存済みの解析結果を読む公開入口 (フェーズ提案が使う)。

    row は external_uploads の parse_result_path / analysis_pending_since を
    持つ行。まだ解析が無ければ AdoptError で正直に断る。
    """
    return await _load_analysis(row)


async def _load_analysis(row: Any) -> dict[str, Any]:
    """保存済みの解析結果を読む。まだ無ければ正直に断る。"""
    if row.parse_result_path is None:
        raise AdoptError("invalid_state", "この議事録はまだ文字起こしが終わっていません。")
    from src.services.meetings.worker import load_result

    result = await load_result(str(row.parse_result_path))
    analysis = result.get("analysis")
    if not isinstance(analysis, dict):
        if row.analysis_pending_since is not None:
            raise AdoptError(
                "invalid_state",
                "解析がまだ保留中です。「解析を再開」で実行してから採用してください。",
            )
        raise AdoptError("invalid_state", "この議事録には構造化解析の結果がありません。")
    return analysis  # pyright: ignore[reportUnknownVariableType]


async def _adopted_map(session: AsyncSession, *, meeting_id: str) -> dict[str, tuple[str, str]]:
    """この議事録で採用済みの (kind, key) → (target_type, target_id)。"""
    res = await session.execute(
        text(
            "select kind, item_key, target_type, target_id from public.meeting_adoptions "
            "where meeting_id = cast(:i as uuid)"
        ),
        {"i": meeting_id},
    )
    return {f"{r.kind}:{r.item_key}": (str(r.target_type), str(r.target_id)) for r in res.all()}


async def list_adoptable(session: AsyncSession, *, meeting_id: str) -> list[AdoptableItem]:
    """この議事録から採用できる項目 (採用済みの印つき)。"""
    row = await _meeting_row(session, meeting_id=meeting_id)
    analysis = await _load_analysis(row)
    adopted = await _adopted_map(session, meeting_id=str(row.id))
    items: list[AdoptableItem] = []
    for raw in extract_items(analysis):
        kind = str(raw["kind"])
        key = str(raw["key"])
        hit = adopted.get(f"{kind}:{key}")
        items.append(
            AdoptableItem(
                kind=kind,
                key=key,
                title=str(raw["title"]),
                detail=str(raw["detail"]),
                quote=str(raw["quote"]),
                meta=dict(raw["meta"]),
                adopted=hit is not None,
                target_type=None if hit is None else hit[0],
                target_id=None if hit is None else hit[1],
            )
        )
    return items


def _task_body(item: dict[str, Any]) -> str:
    """タスク本文。**引用を必ず残す** — 人が「創作していないか」を確かめられる。"""
    lines: list[str] = []
    detail = str(item.get("detail") or "")
    if detail:
        lines.append(detail)
    meta: dict[str, str] = dict(item.get("meta") or {})
    if meta.get("owner"):
        lines.append(f"担当（議事録での発言）: {meta['owner']}")
    if meta.get("due"):
        lines.append(f"期限（議事録での発言）: {meta['due']}")
    quote = str(item.get("quote") or "")
    if quote:
        lines.append(f"議事録の該当箇所: 「{quote}」")
    lines.append(_HOURS_UNKNOWN_NOTE)
    return "\n".join(lines)


def _decision_body(item: dict[str, Any]) -> str:
    """決定・未決の本文。こちらも引用を残す。"""
    lines: list[str] = [str(item["title"])]
    detail = str(item.get("detail") or "")
    if detail:
        lines.append(detail)
    meta: dict[str, str] = dict(item.get("meta") or {})
    if meta.get("context"):
        lines.append(f"背景: {meta['context']}")
    if meta.get("decided_by"):
        lines.append(f"決めた人（議事録での発言）: {meta['decided_by']}")
    quote = str(item.get("quote") or "")
    if quote:
        lines.append(f"議事録の該当箇所: 「{quote}」")
    return "\n".join(lines)[:2000]


async def _create_task(
    session: AsyncSession, *, actor_id: str, project_id: str, item: dict[str, Any]
) -> str:
    from src.schemas.tasks import TaskCreate
    from src.services import tasks as task_svc

    meta: dict[str, str] = dict(item.get("meta") or {})
    kind = str(item["kind"])
    if kind == "requirement":
        task_type = REQUIREMENT_TASK_TYPE.get(meta.get("kind", ""), "feature")
        priority = REQUIREMENT_PRIORITY.get(meta.get("priority", ""), "medium")
        category = "要件（議事録）"
    else:
        task_type = "feature"
        priority = "medium"
        category = "アクション（議事録）"

    created = await task_svc.create_task(
        session,
        actor_id=actor_id,
        data=TaskCreate(
            project_id=project_id,
            category=category,
            title=str(item["title"])[:200],
            type=task_type,  # pyright: ignore[reportArgumentType]
            estimated_hours=DEFAULT_ESTIMATED_HOURS,
            description=_task_body(item),
            priority=priority,  # pyright: ignore[reportArgumentType]
        ),
    )
    return created.id


async def _create_decision(
    session: AsyncSession, *, project_id: str, item: dict[str, Any], file_name: str
) -> str | None:
    from src.schemas.decisions import DecisionCreate
    from src.services import decisions as decision_svc

    status = "decided" if item["kind"] == "decision" else "unresolved"
    created = await decision_svc.create_decision(
        session,
        data=DecisionCreate(
            project_id=project_id,
            status=status,  # pyright: ignore[reportArgumentType]
            body=_decision_body(item),
            reflected_to=f"議事録: {file_name}"[:500],
            # 会議で人が決めた/人が保留したもの — AI が勝手に決めたのではない
            with_user=True,
        ),
    )
    return None if created is None else created.id


@dataclass(frozen=True)
class AdoptResult:
    """採用の結果。何ができて何を飛ばしたかを正直に返す。"""

    created: list[dict[str, str]]
    already: list[str]
    missing: list[str]
    message: str


async def adopt(
    session: AsyncSession, *, meeting_id: str, actor_id: str, keys: list[str]
) -> AdoptResult:
    """選ばれた項目だけを実データに落とす (人が押したときだけ動く)。

    - すでに採用済みのものは作り直さない (二重に増やさない)
    - 議事録に無いキーは黙って無視せず missing として返す
    - 1 件の失敗で全部を落とさない — できたものは残し、残りを正直に報告する
    """
    if not keys:
        raise AdoptError("invalid_state", "採用する項目が選ばれていません。")
    if len(keys) > MAX_ADOPT_PER_CALL:
        raise AdoptError("too_many", f"一度に採用できるのは {MAX_ADOPT_PER_CALL} 件までです。")

    row = await _meeting_row(session, meeting_id=meeting_id)
    analysis = await _load_analysis(row)
    project_id = str(row.project_id)
    file_name = str(row.file_name)
    by_key = {str(i["key"]): i for i in extract_items(analysis)}
    adopted = await _adopted_map(session, meeting_id=str(row.id))

    created: list[dict[str, str]] = []
    already: list[str] = []
    missing: list[str] = []

    for key in keys:
        item = by_key.get(key)
        if item is None:
            missing.append(key)
            continue
        kind = str(item["kind"])
        if f"{kind}:{key}" in adopted:
            already.append(key)
            continue

        target_type = KIND_TARGET[kind]
        if target_type == "task":
            target_id = await _create_task(
                session, actor_id=actor_id, project_id=project_id, item=item
            )
        else:
            target_id = await _create_decision(
                session, project_id=project_id, item=item, file_name=file_name
            )
        if target_id is None:
            # RLS で弾かれた等 — 嘘の成功を出さず missing として返す
            missing.append(key)
            continue

        await session.execute(
            text(
                "insert into public.meeting_adoptions "
                "(meeting_id, project_id, kind, item_key, target_type, target_id, adopted_by) "
                "values (cast(:m as uuid), cast(:p as uuid), :k, :key, :tt, "
                " cast(:ti as uuid), cast(:u as uuid)) "
                "on conflict (meeting_id, kind, item_key) do nothing"
            ),
            {
                "m": str(row.id),
                "p": project_id,
                "k": kind,
                "key": key,
                "tt": target_type,
                "ti": target_id,
                "u": actor_id,
            },
        )
        created.append(
            {
                "key": key,
                "kind": kind,
                "title": str(item["title"]),
                "target_type": target_type,
                "target_id": target_id,
            }
        )

    await AuditWriter(session).write(
        AuditEvent(
            action="meeting.analysis.adopt",
            target_type="external_upload",
            actor_type="user",
            actor_id=actor_id,
            target_id=str(row.id),
            after={
                "created": len(created),
                "already": len(already),
                "missing": len(missing),
            },
        )
    )

    parts: list[str] = []
    if created:
        tasks = sum(1 for c in created if c["target_type"] == "task")
        decs = len(created) - tasks
        made: list[str] = []
        if tasks:
            made.append(f"タスク {tasks} 件")
        if decs:
            made.append(f"決定・未決 {decs} 件")
        parts.append(f"{'・'.join(made)} を作成しました。")
    if already:
        parts.append(f"{len(already)} 件はすでに採用済みのため作成していません。")
    if missing:
        parts.append(f"{len(missing)} 件は議事録側に見つからず採用できませんでした。")
    if not parts:
        parts.append("採用できる項目がありませんでした。")

    return AdoptResult(created, already, missing, "".join(parts))


__all__ = [
    "DEFAULT_ESTIMATED_HOURS",
    "KIND_SECTION",
    "KIND_TARGET",
    "MAX_ADOPT_PER_CALL",
    "AdoptError",
    "AdoptResult",
    "AdoptableItem",
    "adopt",
    "extract_items",
    "item_key",
    "list_adoptable",
    "load_meeting_analysis",
]
