"""Bridge token 経路 — Atelier Bridge → cloud API の認証 + workspace scope 強制。

設計背景 (03_architecture/architecture.json):
  - execution_bridge: Atelier Bridge (Vibeyard fork) が SSE/WebSocket で cloud に接続。
  - access_control.service_role_bypass = true: Bridge は dispatcher 経由で
    service_role (RLS bypass) として DB を操作する。
  - authz_method = "RLS + Application Layer 二重チェック": service_role は RLS を
    bypass するため、アプリ層 (本モジュール) が Bridge token の workspace scope を
    検証し「その Bridge が触ってよい workspace か」を必ず enforce する。

⚠️ 設計前提 (AC 未確定のため要レビュー):
  Bridge token は HMAC-SHA256 署名トークン (JWT 互換の compact 形式) とし、
  claims に bridge_id / workspace_ids (許可 scope) / iat / exp を持つ。
  共有秘密鍵 (BRIDGE_TOKEN_SECRET 相当) は呼び出し側が環境変数等から渡す。
  実際の token 発行方式が異なる場合は本モジュールの形式を tickets.json AC に
  合わせて修正する (T-D-23 / T-D-34)。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass


class BridgeTokenError(RuntimeError):
    """Bridge token の検証失敗 (署名不一致 / 期限切れ / 形式不正)。"""


class BridgeScopeError(BridgeTokenError):
    """Bridge token の scope 外 workspace へのアクセス試行 (deny)。"""


@dataclass(frozen=True)
class BridgeTokenClaims:
    """検証済み Bridge token の claims。"""

    bridge_id: str
    workspace_ids: tuple[str, ...]
    issued_at: int
    expires_at: int

    def is_workspace_in_scope(self, workspace_id: str) -> bool:
        return workspace_id in self.workspace_ids


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def _sign(secret: str, signing_input: bytes) -> str:
    sig = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return _b64url_encode(sig)


def mint_bridge_token(
    secret: str,
    *,
    bridge_id: str,
    workspace_ids: list[str],
    ttl_sec: int = 3600,
) -> str:
    """HMAC-SHA256 署名の Bridge token を発行する。

    Raises:
        ValueError: secret / bridge_id が空、または ttl_sec が非正。
    """
    if not secret:
        raise ValueError("secret must not be empty")
    if not bridge_id:
        raise ValueError("bridge_id must not be empty")
    if ttl_sec <= 0:
        raise ValueError("ttl_sec must be positive")

    now = int(time.time())
    header = {"alg": "HS256", "typ": "BRIDGE"}
    payload = {
        "bridge_id": bridge_id,
        "workspace_ids": list(workspace_ids),
        "iat": now,
        "exp": now + ttl_sec,
    }
    header_b64 = _b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    return f"{header_b64}.{payload_b64}.{_sign(secret, signing_input)}"


def verify_bridge_token(secret: str, token: str, *, now: int | None = None) -> BridgeTokenClaims:
    """Bridge token を検証して claims を返す。

    Raises:
        BridgeTokenError: 形式不正 / 署名不一致 / 期限切れ。
    """
    parts = token.split(".")
    if len(parts) != 3:
        raise BridgeTokenError("malformed token: expected 3 segments")
    header_b64, payload_b64, sig_b64 = parts

    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected_sig = _sign(secret, signing_input)
    # 定数時間比較で署名検証 (timing attack 緩和)
    if not hmac.compare_digest(expected_sig, sig_b64):
        raise BridgeTokenError("signature mismatch")

    try:
        payload_raw = _b64url_decode(payload_b64)
        payload: dict[str, object] = json.loads(payload_raw)
    except (ValueError, json.JSONDecodeError) as exc:
        raise BridgeTokenError(f"malformed payload: {exc}") from exc

    bridge_id = payload.get("bridge_id")
    workspace_ids = payload.get("workspace_ids")
    iat = payload.get("iat")
    exp = payload.get("exp")
    if not isinstance(bridge_id, str) or not bridge_id:
        raise BridgeTokenError("missing bridge_id")
    if not isinstance(workspace_ids, list) or not all(isinstance(w, str) for w in workspace_ids):
        raise BridgeTokenError("missing or invalid workspace_ids")
    if not isinstance(iat, int) or not isinstance(exp, int):
        raise BridgeTokenError("missing iat/exp")

    current = int(time.time()) if now is None else now
    if current >= exp:
        raise BridgeTokenError("token expired")

    return BridgeTokenClaims(
        bridge_id=bridge_id,
        workspace_ids=tuple(workspace_ids),
        issued_at=iat,
        expires_at=exp,
    )


def assert_workspace_allowed(claims: BridgeTokenClaims, workspace_id: str) -> None:
    """Bridge token の scope に workspace_id が含まれなければ deny (アプリ層二重チェック)。

    service_role は RLS を bypass するため、Bridge 経由の DB 操作前に必ず本関数で
    対象 workspace が token scope 内であることを確認する。

    Raises:
        BridgeScopeError: workspace_id が token scope 外。
    """
    if not claims.is_workspace_in_scope(workspace_id):
        raise BridgeScopeError(
            f"bridge {claims.bridge_id} not authorized for workspace {workspace_id}"
        )
