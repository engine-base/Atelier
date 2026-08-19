"""GAP-185: 止まった処理を「言えば再開できる」ようにする。

経営者判断 (2026-08-19):
> 「自動はしなくていいけど、止まった状態で進めてと言ったりしたら
>   再開はできる状態にしておかないとね」

止まる理由は 2 つあり、どちらも**時間が経てば解消する**ものだけを対象にする:
  - `bridge_offline`  : 利用者の PC が繋がっていなかった
  - `rate_limited`    : 本人の Claude プラン枠が上限だった (5 時間 / 7 日)

恒久的な失敗 (parse_failed 等) は「再開」ではなく作り直しなので対象外。
自動での再開はしない (勝手にプラン枠を使わない)。**人が押したときだけ動く**。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ResumeResult:
    """再開の結果。画面にそのまま出せる日本語つき。"""

    status: str  # "done" | "still_pending" | "not_pending" | "not_found"
    message: str


async def analysis_pending(session: AsyncSession, *, meeting_id: str) -> bool:
    """この議事録は「解析だけ保留」の状態か。"""
    row = (
        await session.execute(
            text(
                "select analysis_pending_since from public.external_uploads "
                "where id = cast(:i as uuid) and deleted_at is null"
            ),
            {"i": meeting_id},
        )
    ).first()
    return row is not None and row.analysis_pending_since is not None


async def resume_analysis(session: AsyncSession, *, meeting_id: str) -> ResumeResult:
    """保留中の解析を**今すぐ**やり直す (人が押したときだけ動く)。

    文字起こしは終わっているので再実行しない (二重に PC を使わせない)。
    まだ PC が未接続 / 上限中なら保留のまま残し、その旨を返す。
    """
    row = (
        await session.execute(
            text(
                "select id, parse_result_path, uploaded_by_user_id, analysis_pending_since "
                "from public.external_uploads "
                "where id = cast(:i as uuid) and deleted_at is null"
            ),
            {"i": meeting_id},
        )
    ).first()
    if row is None:
        return ResumeResult("not_found", "議事録が見つかりません。")
    if row.analysis_pending_since is None:
        return ResumeResult(
            "not_pending",
            "この議事録に保留中の解析はありません（解析済みか、まだ文字起こしの途中です）。",
        )

    from src.services.meetings.worker import retry_analysis_one

    done = await retry_analysis_one(session, row)
    if done:
        return ResumeResult("done", "解析を実行しました。結果を更新しています。")
    return ResumeResult(
        "still_pending",
        "まだ実行できませんでした。お使いのパソコン (Bridge) の接続と、"
        "Claude プランの利用枠の状態を確認してから、もう一度お試しください。",
    )


async def list_pending_analyses(session: AsyncSession, *, limit: int = 50) -> list[dict[str, Any]]:
    """保留中の解析一覧 (画面で「止まっているもの」を出すため)。"""
    limit = max(1, min(limit, 200))
    res = await session.execute(
        text(
            "select id, file_name, analysis_pending_since "
            "from public.external_uploads "
            "where analysis_pending_since is not null and deleted_at is null "
            "order by analysis_pending_since asc limit :lim"
        ),
        {"lim": limit},
    )
    return [
        {
            "id": str(r.id),
            "file_name": str(r.file_name),
            "pending_since": r.analysis_pending_since,
        }
        for r in res.all()
    ]


__all__ = ["ResumeResult", "analysis_pending", "list_pending_analyses", "resume_analysis"]
