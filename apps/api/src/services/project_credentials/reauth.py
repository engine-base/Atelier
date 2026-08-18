"""GAP-131: reveal 再認証の TTL レジストリ (プロセス内)。

パスワード再入力に成功したユーザーは、短時間 (既定 300 秒) だけパスワード
なしで reveal を続けられる (Claude Code の「一度許可したら少しの間は聞かない」
と同じ体感)。TTL が切れたら再びパスワードを要求する。

プロセス内メモリで持つ (セルフホスト単一プロセス前提 — pc_approvals と同じ
制約。マルチワーカー構成ではワーカーごとに再認証が要るだけで、緩くはならない)。
"""

from __future__ import annotations

import os
import time

TTL_ENV = "ATELIER_VAULT_REAUTH_TTL_SECONDS"
DEFAULT_TTL_SECONDS = 300.0

_granted: dict[str, float] = {}


def reauth_ttl_seconds(env: dict[str, str] | None = None) -> float:
    """再認証の有効秒数 (env で調整可能、不正値・非正値は既定に落とす)。"""
    e = env if env is not None else dict(os.environ)
    raw = (e.get(TTL_ENV) or "").strip()
    if raw:
        try:
            value = float(raw)
            if value > 0:
                return value
        except ValueError:
            pass
    return DEFAULT_TTL_SECONDS


def grant(user_id: str, *, now: float | None = None) -> None:
    """パスワード照合成功を記録し、TTL の間 reveal を許可する。"""
    t = time.time() if now is None else now
    _granted[user_id] = t + reauth_ttl_seconds()


def is_valid(user_id: str, *, now: float | None = None) -> bool:
    """有効な再認証が残っているか。期限切れは掃除してから False。"""
    t = time.time() if now is None else now
    expiry = _granted.get(user_id)
    if expiry is None:
        return False
    if t >= expiry:
        del _granted[user_id]
        return False
    return True


def clear(user_id: str | None = None) -> None:
    """再認証を失効させる (None で全消去 — テスト用)。"""
    if user_id is None:
        _granted.clear()
    else:
        _granted.pop(user_id, None)
