"""統合試験用の最小 AsyncSession stub (DB-free).

実 service 関数 (services.tasks.play_task 等) を Postgres なしで exercise する
ための共通スタブ。test_play_task_unit.py の _StubSession を Bundle P 用に
切り出し、複数 integration ファイルから再利用する。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class StubResult:
    """execute() の戻り値スタブ。scalar_one() / first() / fetchall() を提供。"""

    value: Any = None
    rows: list[Any] | None = None

    def scalar_one(self) -> Any:
        return self.value

    def scalar(self) -> Any:
        return self.value

    def first(self) -> Any:
        if self.rows:
            return self.rows[0]
        return None

    def fetchall(self) -> list[Any]:
        return list(self.rows or [])

    def all(self) -> list[Any]:
        return list(self.rows or [])

    def __iter__(self):  # type: ignore[no-untyped-def]
        return iter(self.rows or [])


class StubSession:
    """最小 AsyncSession 互換。execute() は queue した結果を順に返す。"""

    def __init__(self, responses: list[StubResult] | None = None) -> None:
        self._responses = list(responses or [])
        self.executed: list[tuple[str, dict[str, Any]]] = []
        self.committed = False
        self.rolled_back = False

    async def execute(self, statement: Any, params: dict[str, Any] | None = None) -> StubResult:
        self.executed.append((str(statement), params or {}))
        if not self._responses:
            return StubResult()
        return self._responses.pop(0)

    async def commit(self) -> None:
        self.committed = True

    async def rollback(self) -> None:
        self.rolled_back = True
