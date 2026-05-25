"""Unit tests for apps/api/src/auth/bridge_token.py (T-D-23)。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import pytest

from src.auth import (
    BridgeScopeError,
    BridgeTokenError,
    assert_workspace_allowed,
    mint_bridge_token,
    verify_bridge_token,
)

SECRET = "test-bridge-secret"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _make_token(secret: str, payload: dict[str, object]) -> str:
    """任意 payload を署名して compact token を作る (verify 側検証用)。"""
    header_b64 = _b64url(json.dumps({"alg": "HS256", "typ": "BRIDGE"}).encode())
    payload_b64 = _b64url(json.dumps(payload).encode())
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    sig = _b64url(hmac.new(secret.encode(), signing_input, hashlib.sha256).digest())
    return f"{header_b64}.{payload_b64}.{sig}"


@pytest.mark.unit
class TestMintAndVerify:
    def test_round_trip(self) -> None:
        token = mint_bridge_token(
            SECRET, bridge_id="bridge-1", workspace_ids=["ws-a", "ws-b"], ttl_sec=60
        )
        claims = verify_bridge_token(SECRET, token)
        assert claims.bridge_id == "bridge-1"
        assert claims.workspace_ids == ("ws-a", "ws-b")
        assert claims.expires_at > claims.issued_at

    def test_empty_secret_raises(self) -> None:
        with pytest.raises(ValueError, match="secret"):
            mint_bridge_token("", bridge_id="b", workspace_ids=[])

    def test_empty_bridge_id_raises(self) -> None:
        with pytest.raises(ValueError, match="bridge_id"):
            mint_bridge_token(SECRET, bridge_id="", workspace_ids=[])

    def test_non_positive_ttl_raises(self) -> None:
        with pytest.raises(ValueError, match="ttl_sec"):
            mint_bridge_token(SECRET, bridge_id="b", workspace_ids=[], ttl_sec=0)


@pytest.mark.unit
class TestVerifyFailures:
    def test_malformed_segments(self) -> None:
        with pytest.raises(BridgeTokenError, match="3 segments"):
            verify_bridge_token(SECRET, "only.two")

    def test_signature_mismatch(self) -> None:
        token = mint_bridge_token(SECRET, bridge_id="b", workspace_ids=["ws"], ttl_sec=60)
        with pytest.raises(BridgeTokenError, match="signature mismatch"):
            verify_bridge_token("wrong-secret", token)

    def test_expired(self) -> None:
        token = mint_bridge_token(SECRET, bridge_id="b", workspace_ids=["ws"], ttl_sec=1)
        with pytest.raises(BridgeTokenError, match="expired"):
            verify_bridge_token(SECRET, token, now=int(time.time()) + 10)

    def test_missing_bridge_id(self) -> None:
        token = _make_token(SECRET, {"workspace_ids": ["ws"], "iat": 1, "exp": 9999999999})
        with pytest.raises(BridgeTokenError, match="bridge_id"):
            verify_bridge_token(SECRET, token)

    def test_invalid_workspace_ids(self) -> None:
        token = _make_token(
            SECRET, {"bridge_id": "b", "workspace_ids": "ws", "iat": 1, "exp": 9999999999}
        )
        with pytest.raises(BridgeTokenError, match="workspace_ids"):
            verify_bridge_token(SECRET, token)

    def test_missing_iat_exp(self) -> None:
        token = _make_token(SECRET, {"bridge_id": "b", "workspace_ids": ["ws"]})
        with pytest.raises(BridgeTokenError, match="iat/exp"):
            verify_bridge_token(SECRET, token)

    def test_malformed_payload_json(self) -> None:
        header_b64 = _b64url(json.dumps({"alg": "HS256"}).encode())
        payload_b64 = _b64url(b"not-json{{{")
        signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
        sig = _b64url(hmac.new(SECRET.encode(), signing_input, hashlib.sha256).digest())
        with pytest.raises(BridgeTokenError, match="malformed payload"):
            verify_bridge_token(SECRET, f"{header_b64}.{payload_b64}.{sig}")


@pytest.mark.unit
class TestScopeEnforcement:
    def test_in_scope_allowed(self) -> None:
        claims = verify_bridge_token(
            SECRET,
            mint_bridge_token(SECRET, bridge_id="b", workspace_ids=["ws-a"], ttl_sec=60),
        )
        assert claims.is_workspace_in_scope("ws-a") is True
        # scope 内なので例外を投げない (raise したらテスト失敗)
        assert_workspace_allowed(claims, "ws-a")

    def test_out_of_scope_denied(self) -> None:
        claims = verify_bridge_token(
            SECRET,
            mint_bridge_token(SECRET, bridge_id="b", workspace_ids=["ws-a"], ttl_sec=60),
        )
        assert claims.is_workspace_in_scope("ws-b") is False
        with pytest.raises(BridgeScopeError, match="not authorized for workspace ws-b"):
            assert_workspace_allowed(claims, "ws-b")
