"""T-I-16 F-CUC01-04 継続更新サイクル試験.

F-CUC (continuous update cycle) の中核は「user-scope knowledge を workspace
common に昇格する継続フロー」。実 service `src.services.knowledge.promote_knowledge`
の各ガード分岐を DB-free stub session で exercise する。

検証する不変条件:
  - employee_specific scope は昇格不可 (EMPLOYEE_SPECIFIC)
  - 他人名義の knowledge は昇格不可 (NOT_USER_OWNED)
  - 存在しない knowledge は NOT_FOUND
これらは継続更新サイクルが「不正な昇格を弾く」ことを保証する。
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass

from src.services.knowledge import PromoteResult, promote_knowledge

from ._stub import StubResult, StubSession


@dataclass
class _KnRow:
    account_id: str
    account_type: str
    scope: str
    confidence_score: float | None


def test_promote_not_found() -> None:
    """knowledge が存在しないと NOT_FOUND (実 promote_knowledge)."""
    session = StubSession([StubResult(rows=None)])
    code, resp = asyncio.run(
        promote_knowledge(
            session,  # type: ignore[arg-type]
            actor_id="u1",
            knowledge_id=str(uuid.uuid4()),
            target_workspace_id=str(uuid.uuid4()),
            confidence_score=None,
        )
    )
    assert code == PromoteResult.NOT_FOUND
    assert resp is None


def test_promote_employee_specific_rejected() -> None:
    """employee_specific scope は昇格不可 (R-T08 整合)."""
    session = StubSession(
        [
            StubResult(
                rows=[
                    _KnRow(
                        account_id="u1",
                        account_type="user",
                        scope="employee_specific",
                        confidence_score=0.5,
                    )
                ]
            )
        ]
    )
    code, _ = asyncio.run(
        promote_knowledge(
            session,  # type: ignore[arg-type]
            actor_id="u1",
            knowledge_id=str(uuid.uuid4()),
            target_workspace_id=str(uuid.uuid4()),
            confidence_score=None,
        )
    )
    assert code == PromoteResult.EMPLOYEE_SPECIFIC


def test_promote_not_user_owned_rejected() -> None:
    """他人名義 (account_id != actor) の knowledge は昇格不可."""
    session = StubSession(
        [
            StubResult(
                rows=[
                    _KnRow(
                        account_id="someone_else",
                        account_type="user",
                        scope="common",
                        confidence_score=0.5,
                    )
                ]
            )
        ]
    )
    code, _ = asyncio.run(
        promote_knowledge(
            session,  # type: ignore[arg-type]
            actor_id="u1",
            knowledge_id=str(uuid.uuid4()),
            target_workspace_id=str(uuid.uuid4()),
            confidence_score=None,
        )
    )
    assert code == PromoteResult.NOT_USER_OWNED


def test_promote_result_codes_complete() -> None:
    """継続更新サイクルが扱う PromoteResult 定数が揃っていること."""
    codes = {
        PromoteResult.SUCCESS,
        PromoteResult.NOT_FOUND,
        PromoteResult.NOT_USER_OWNED,
        PromoteResult.EMPLOYEE_SPECIFIC,
        PromoteResult.NOT_MEMBER,
    }
    assert codes == {
        "success",
        "not_found",
        "not_user_owned",
        "employee_specific",
        "not_member",
    }
