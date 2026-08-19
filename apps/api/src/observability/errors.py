"""GAP-182: 自前のエラー記録 (Sentry を使わない選択の実体)。

**これまでの実態**: `observability/sentry.py` と `apps/web/lib/sentry.client.ts` に
初期化コードだけがあり、(a) `main.py` から一度も呼ばれておらず (b) SDK も
依存に入っていなかった。つまり**本番でエラーが起きても誰も気づけない**状態で、
それなのに `docs/PROJECT-STATE.md` には「Sentry EU 接続済」と書かれていた。

経営者判断 (2026-08-19「B で進めて」):
外部 SaaS には送らない。スタックトレースも URL もユーザー ID も外に出さず、
自分たちの DB (`public.error_log`) に貯めて運営画面で見る。追加費用ゼロ。

安全側の設計:
- 記録は **best-effort**。ログを書けなくてもリクエスト処理は絶対に止めない。
- 秘匿値 (token / key / authorization / パスワード等) はマスクしてから保存する。
- テナントからは読めない (RLS で policy を一切与えていない)。運営 admin のみ。
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import traceback
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import text

logger = logging.getLogger(__name__)

ErrorSource = Literal["api", "web", "worker"]
ErrorLevel = Literal["error", "warning"]

_MESSAGE_MAX = 1000
_STACK_MAX = 8000

#: 値をマスクする対象。値そのものを保存しない (漏らさない)。
_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._\-/+=]{8,}"),
    re.compile(r"(?i)\b(sk|pa|pk|rk)-[A-Za-z0-9._\-]{8,}"),
    re.compile(r"(?i)\b(eyJ[A-Za-z0-9._\-]{20,})"),  # JWT
    re.compile(r"(?i)(postgres(?:ql)?(?:\+\w+)?://)[^\s\"']+"),
    re.compile(
        r"(?i)\b(password|passwd|secret|token|api[_-]?key|authorization)"
        r"([\"']?\s*[:=]\s*[\"']?)([^\s\"',;)]+)"
    ),
)


def redact(value: str | None) -> str | None:
    """秘匿値をマスクする。**保存前に必ず通す**。"""
    if not value:
        return value
    out = value
    out = _SECRET_PATTERNS[0].sub(r"\1 [FILTERED]", out)
    out = _SECRET_PATTERNS[1].sub("[FILTERED-KEY]", out)
    out = _SECRET_PATTERNS[2].sub("[FILTERED-JWT]", out)
    out = _SECRET_PATTERNS[3].sub(r"\1[FILTERED]", out)
    out = _SECRET_PATTERNS[4].sub(r"\1\2[FILTERED]", out)
    return out


def fingerprint(*, source: str, kind: str, path: str | None, stack: str | None) -> str:
    """同種エラーをまとめる key。件数を数えて「増えているか」を見るために使う。"""
    head = ""
    if stack:
        lines = [ln.strip() for ln in stack.splitlines() if ln.strip().startswith("File ")]
        head = lines[-1] if lines else ""
    raw = f"{source}|{kind}|{path or ''}|{head}"
    # 暗号用途ではなく「同種をまとめる識別子」なので sha1 で十分 (短く読める)
    return hashlib.sha1(raw.encode("utf-8"), usedforsecurity=False).hexdigest()[:16]


@dataclass(frozen=True)
class ErrorEntry:
    id: str
    occurred_at: datetime
    source: str
    level: str
    kind: str
    message: str
    path: str | None
    method: str | None
    status_code: int | None
    fingerprint: str
    count_24h: int


def _service_factory() -> Any:
    from src.services.project_credentials import (
        _service_session_factory,  # pyright: ignore[reportPrivateUsage]
    )

    return _service_session_factory()


async def record_error(
    *,
    source: ErrorSource,
    kind: str,
    message: str,
    path: str | None = None,
    method: str | None = None,
    status_code: int | None = None,
    user_id: str | None = None,
    stack: str | None = None,
    context: dict[str, Any] | None = None,
    level: ErrorLevel = "error",
) -> str | None:
    """エラーを 1 件記録する。失敗しても呼び出し元を止めない (None を返すだけ)。"""
    safe_message = (redact(message) or "")[:_MESSAGE_MAX]
    safe_stack = redact(stack) or None
    if safe_stack is not None:
        safe_stack = safe_stack[:_STACK_MAX]
    fp = fingerprint(source=source, kind=kind, path=path, stack=safe_stack)
    try:
        async with _service_factory()() as session:
            res = await session.execute(
                text(
                    "insert into public.error_log "
                    "(source, level, kind, message, path, method, status_code, "
                    " user_id, fingerprint, stack, context) "
                    "values (:src, :lvl, :kind, :msg, :path, :method, :status, "
                    " cast(nullif(:uid, '') as uuid), :fp, :stack, cast(:ctx as jsonb)) "
                    "returning id"
                ),
                {
                    "src": source,
                    "lvl": level,
                    "kind": kind[:200],
                    "msg": safe_message,
                    "path": (path or "")[:500] or None,
                    "method": (method or "")[:10] or None,
                    "status": status_code,
                    "uid": user_id or "",
                    "fp": fp,
                    "stack": safe_stack,
                    "ctx": json.dumps(context or {}, ensure_ascii=False, default=str),
                },
            )
            new_id = str(res.scalar_one())
            await session.commit()
            return new_id
    except Exception:  # 記録できなくてもアプリは止めない
        logger.exception("error_log insert failed (kind=%s path=%s)", kind, path)
        return None


async def record_exception(
    exc: BaseException,
    *,
    source: ErrorSource = "api",
    path: str | None = None,
    method: str | None = None,
    status_code: int | None = 500,
    user_id: str | None = None,
    context: dict[str, Any] | None = None,
) -> str | None:
    """例外オブジェクトから 1 件記録する。"""
    stack = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    return await record_error(
        source=source,
        kind=type(exc).__name__,
        message=str(exc) or type(exc).__name__,
        path=path,
        method=method,
        status_code=status_code,
        user_id=user_id,
        stack=stack,
        context=context,
    )


async def list_errors(*, limit: int = 50, hours: int = 168) -> list[ErrorEntry]:
    """直近のエラーを新しい順で返す (運営 admin 用)。"""
    limit = max(1, min(limit, 200))
    async with _service_factory()() as session:
        res = await session.execute(
            text(
                "select e.id, e.occurred_at, e.source, e.level, e.kind, e.message, "
                "       e.path, e.method, e.status_code, e.fingerprint, "
                "       (select count(*) from public.error_log c "
                "         where c.fingerprint = e.fingerprint "
                "           and c.occurred_at > now() - interval '24 hours') as count_24h "
                "from public.error_log e "
                "where e.occurred_at > now() - make_interval(hours => :h) "
                "order by e.occurred_at desc limit :lim"
            ),
            {"lim": limit, "h": max(1, hours)},
        )
        return [
            ErrorEntry(
                id=str(r.id),
                occurred_at=r.occurred_at,
                source=str(r.source),
                level=str(r.level),
                kind=str(r.kind),
                message=str(r.message),
                path=None if r.path is None else str(r.path),
                method=None if r.method is None else str(r.method),
                status_code=None if r.status_code is None else int(r.status_code),
                fingerprint=str(r.fingerprint),
                count_24h=int(r.count_24h),
            )
            for r in res.all()
        ]


async def error_count(*, hours: int = 24) -> int:
    """直近 N 時間のエラー件数 (運営ヘルスチェック用)。"""
    try:
        async with _service_factory()() as session:
            res = await session.execute(
                text(
                    "select count(*) from public.error_log "
                    "where occurred_at > now() - make_interval(hours => :h)"
                ),
                {"h": max(1, hours)},
            )
            return int(res.scalar_one())
    except Exception:  # pragma: no cover - 健全性表示のために例外を伝播しない
        logger.exception("error_log count failed")
        return 0


async def purge_old_errors(session: Any, *, days: int = 30) -> int:
    """保持期間を過ぎたエラーを物理削除する (無限に太らせない)。"""
    res = await session.execute(
        text(
            "delete from public.error_log "
            "where occurred_at < now() - make_interval(days => :d) returning id"
        ),
        {"d": max(1, days)},
    )
    return len(res.all())


__all__ = [
    "ErrorEntry",
    "error_count",
    "fingerprint",
    "list_errors",
    "purge_old_errors",
    "record_error",
    "record_exception",
    "redact",
]
