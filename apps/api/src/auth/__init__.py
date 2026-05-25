"""認証ユーティリティ (T-D-23)。

Bridge (Atelier Bridge desktop client) → cloud API の認証経路。
"""

from __future__ import annotations

from src.auth.bridge_token import (
    BridgeScopeError,
    BridgeTokenClaims,
    BridgeTokenError,
    assert_workspace_allowed,
    mint_bridge_token,
    verify_bridge_token,
)

__all__ = [
    "BridgeScopeError",
    "BridgeTokenClaims",
    "BridgeTokenError",
    "assert_workspace_allowed",
    "mint_bridge_token",
    "verify_bridge_token",
]
