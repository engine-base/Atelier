"""エンドポイント別レート制限 — openapi.yaml の x-rate-limit 契約の実装。

契約 (07_api_design/openapi.yaml) が宣言する 5 endpoint:
  - POST /auth/signin                            5/min/ip
  - POST /tasks/{id}/play                        10/min/user
  - GET  /knowledge/search                       60/min/user
  - GET  /executions/{execution_id}/logs/stream  60/min/user
  - POST /chat/threads/{thread_id}/stream        30/min/user

実装: プロセス内 sliding-window (deque of monotonic timestamps)。
現構成は uvicorn 単一 worker (Dockerfile 参照) のためプロセス内で正確。
水平スケール時は Redis 等の共有ストアへ差し替えること (キー設計は同じ)。

テスト時は環境変数 ATELIER_RATE_LIMIT_DISABLED=1 で無効化できる
(signin 系テストは同一 TestClient IP で連打するため)。
"""

from __future__ import annotations

import os
import time
from collections import deque
from threading import Lock
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

from src.dependencies import CurrentUser, get_current_user


class SlidingWindowLimiter:
    """key ごとの sliding-window カウンタ。thread-safe。"""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = {}
        self._lock = Lock()

    def check(self, key: str, times: int, per_seconds: float) -> float | None:
        """許可なら None、超過なら「次に空くまでの秒数」を返す (状態は更新)。"""
        now = time.monotonic()
        with self._lock:
            q = self._hits.setdefault(key, deque())
            cutoff = now - per_seconds
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= times:
                return per_seconds - (now - q[0])
            q.append(now)
            return None

    def reset(self) -> None:
        """テスト用: 全カウンタを破棄する。"""
        with self._lock:
            self._hits.clear()


limiter = SlidingWindowLimiter()
"""プロセス共有の唯一のインスタンス (route 依存はこれを参照する)。"""


def _disabled() -> bool:
    return os.environ.get("ATELIER_RATE_LIMIT_DISABLED") == "1"


def _reject(retry_after: float) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        "rate limit exceeded",
        headers={"Retry-After": str(max(1, int(retry_after + 0.999)))},
    )


def rate_limit_user(times: int, per_seconds: float = 60.0):
    """認証ユーザー単位の x-rate-limit (`N/min/user`) 依存。"""

    async def dep(
        request: Request,
        user: Annotated[CurrentUser, Depends(get_current_user)],
    ) -> None:
        if _disabled():
            return
        key = f"{request.url.path.split('?')[0]}:{request.method}:user:{user.id}"
        retry = limiter.check(key, times, per_seconds)
        if retry is not None:
            raise _reject(retry)

    return dep


def rate_limit_ip(times: int, per_seconds: float = 60.0):
    """接続元 IP 単位の x-rate-limit (`N/min/ip`) 依存 (未認証 endpoint 用)。"""

    async def dep(request: Request) -> None:
        if _disabled():
            return
        host = request.client.host if request.client else "unknown"
        key = f"{request.url.path.split('?')[0]}:{request.method}:ip:{host}"
        retry = limiter.check(key, times, per_seconds)
        if retry is not None:
            raise _reject(retry)

    return dep
