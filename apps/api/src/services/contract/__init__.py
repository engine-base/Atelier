"""API 契約凍結サービス層 (T-A-45)。

openapi.yaml を信頼源として screen coverage を算出し、admin による
契約凍結を audit_logs に記録する。

screen coverage: 04_functional_breakdown/screens.json で宣言された全
screen_id を 100% カバーすることが Gate #9 と同じ条件。

凍結状態は append-only な audit_logs (action='contract.freeze' /
'contract.unfreeze') を信頼源として動的算出する。
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

import yaml
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.contract import (
    FreezeStatus,
    ScreenCoverageEntry,
    ScreenCoverageReport,
)

# 信頼源パス (repo ルートからの相対)
_OPENAPI_PATH = Path(__file__).resolve().parents[5] / "07_api_design" / "openapi.yaml"
_SCREENS_PATH = Path(__file__).resolve().parents[5] / "04_functional_breakdown" / "screens.json"


def _load_openapi() -> dict[str, Any]:
    """openapi.yaml を一回 load する。"""
    return cast("dict[str, Any]", yaml.safe_load(_OPENAPI_PATH.read_text()))


def _load_screen_ids() -> list[str]:
    """screens.json から screen id 一覧を取り出す。

    Atelier の screens.json は `items` キー配下に screen 配列を持つ
    (v3 schema, T-D-25 前後で確定)。
    """
    raw = json.loads(_SCREENS_PATH.read_text())
    if isinstance(raw, list):
        screens = raw
    elif isinstance(raw, dict):
        screens = raw.get("items") or raw.get("screens") or []
    else:
        screens = []
    ids: list[str] = []
    for s in screens:
        if not isinstance(s, dict):
            continue
        sid = s.get("id") or s.get("screen_id")
        if isinstance(sid, str):
            ids.append(sid)
    return ids


_HTTP_METHODS = ("get", "post", "put", "patch", "delete", "head", "options")


def compute_screen_coverage() -> ScreenCoverageReport:
    """openapi.yaml の x-screen-ids と screens.json を照合する。"""
    spec = _load_openapi()
    screen_ids = _load_screen_ids()
    screen_map: dict[str, list[str]] = {sid: [] for sid in screen_ids}

    paths_block = spec.get("paths") or {}
    for path, ops in paths_block.items():
        if not isinstance(ops, dict):
            continue
        for method, op in ops.items():
            if method.lower() not in _HTTP_METHODS or not isinstance(op, dict):
                continue
            refs = op.get("x-screen-ids") or []
            if not isinstance(refs, list):
                continue
            label = f"{method.upper()} {path}"
            for sid in refs:
                if isinstance(sid, str) and sid in screen_map:
                    screen_map[sid].append(label)

    entries = [
        ScreenCoverageEntry(
            screen_id=sid, endpoint_count=len(endpoints), endpoints=sorted(set(endpoints))
        )
        for sid, endpoints in screen_map.items()
    ]
    entries.sort(key=lambda e: e.screen_id)
    covered = sum(1 for e in entries if e.endpoint_count > 0)
    uncovered = [e.screen_id for e in entries if e.endpoint_count == 0]
    pct = (covered / len(entries) * 100.0) if entries else 0.0
    return ScreenCoverageReport(
        total_screens=len(entries),
        covered_screens=covered,
        uncovered_screens=uncovered,
        coverage_pct=pct,
        entries=entries,
        evaluated_at=datetime.now(UTC),
    )


def count_paths_and_methods() -> tuple[int, int]:
    """openapi.yaml の path 数 / 全 operation 数を返す。"""
    spec = _load_openapi()
    paths_block = spec.get("paths") or {}
    total_paths = len(paths_block)
    total_methods = 0
    for ops in paths_block.values():
        if not isinstance(ops, dict):
            continue
        for method in ops:
            if method.lower() in _HTTP_METHODS:
                total_methods += 1
    return total_paths, total_methods


async def get_freeze_status(session: AsyncSession) -> FreezeStatus:
    """audit_logs から現在の凍結状態を計算する (動的判定)。"""
    res = await session.execute(
        text(
            "select action, actor_id, after, created_at "
            "from public.audit_logs "
            "where action in ('contract.freeze', 'contract.unfreeze') "
            "order by created_at desc limit 1"
        )
    )
    row = res.first()
    total_paths, total_methods = count_paths_and_methods()
    if row is None:
        return FreezeStatus(
            frozen=False,
            frozen_at=None,
            frozen_by_user_id=None,
            last_note=None,
            total_paths=total_paths,
            total_methods=total_methods,
            evaluated_at=datetime.now(UTC),
        )

    after_val = row.after
    if isinstance(after_val, str):
        after_dict: dict[str, Any] = json.loads(after_val) if after_val else {}
    elif isinstance(after_val, dict):
        after_dict = after_val
    else:
        after_dict = {}
    note = after_dict.get("note") if isinstance(after_dict.get("note"), str) else None

    return FreezeStatus(
        frozen=(str(row.action) == "contract.freeze"),
        frozen_at=row.created_at,
        frozen_by_user_id=str(row.actor_id),
        last_note=note,
        total_paths=total_paths,
        total_methods=total_methods,
        evaluated_at=datetime.now(UTC),
    )


class ContractError(Exception):
    """凍結状態の整合性違反 (重複 freeze / 100% 未満 / 未凍結 unfreeze)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def freeze_contract(
    session: AsyncSession, *, actor_id: str, note: str | None
) -> FreezeStatus:
    """openapi 凍結を試行する。

    要件:
      - 既に frozen な場合 409 (重複凍結禁止)
      - screen coverage が 100% でなければ 412 (Gate #9 と同条件)
      - 成功時 audit_logs.contract.freeze を記録
    """
    current = await get_freeze_status(session)
    if current.frozen:
        raise ContractError("already_frozen", "contract is already frozen")
    report = compute_screen_coverage()
    if report.coverage_pct < 100.0:
        raise ContractError(
            "screen_coverage_lt_100",
            f"screen coverage is {report.coverage_pct:.2f}% (< 100%); "
            f"uncovered: {report.uncovered_screens}",
        )
    await AuditWriter(session).write(
        AuditEvent(
            action="contract.freeze",
            target_type="openapi",
            actor_type="user",
            actor_id=actor_id,
            target_id=actor_id,
            after={
                "note": note,
                "total_paths": current.total_paths,
                "total_methods": current.total_methods,
                "coverage_pct": report.coverage_pct,
            },
        )
    )
    await session.commit()
    return await get_freeze_status(session)


async def unfreeze_contract(
    session: AsyncSession, *, actor_id: str, note: str | None
) -> FreezeStatus:
    """凍結解除 (例: 仕様変更を伴う Wave 3 突入時)。

    要件: 現在 frozen でなければ 409。
    """
    current = await get_freeze_status(session)
    if not current.frozen:
        raise ContractError("not_frozen", "contract is not frozen")
    await AuditWriter(session).write(
        AuditEvent(
            action="contract.unfreeze",
            target_type="openapi",
            actor_type="user",
            actor_id=actor_id,
            target_id=actor_id,
            after={"note": note},
        )
    )
    await session.commit()
    return await get_freeze_status(session)
