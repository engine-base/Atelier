"""GAP-180: 埋め込み経路の決定を固定する unit tests。

要点は 2 つ:
  1. Voyage は **キーがあるだけでは使わない** (明示 opt-in が要る)
  2. 使えない状態を「使えている」ように見せない (state と復旧手順を返す)
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.embeddings.route import (
    ALLOW_VOYAGE_ENV,
    VOYAGE_KEY_ENV,
    resolve_embedding_route,
    voyage_allowed,
)


class TestVoyageOptIn:
    def test_key_alone_does_not_enable_voyage(self) -> None:
        """GAP-178 と同じ「env を消さないと使われる」設計を埋め込みでも排除する。"""
        env = {VOYAGE_KEY_ENV: "pa-secret"}
        assert voyage_allowed(env) is False
        route = resolve_embedding_route(env)
        assert route.provider != "voyage"
        assert any("明示 opt-in" in w for w in route.warnings)

    def test_opt_in_without_key_warns_and_falls_back(self) -> None:
        env = {ALLOW_VOYAGE_ENV: "1"}
        assert voyage_allowed(env) is False
        route = resolve_embedding_route(env)
        assert route.provider != "voyage"
        assert any(VOYAGE_KEY_ENV in w for w in route.warnings)

    def test_explicit_opt_in_with_key_uses_voyage(self) -> None:
        """将来使う可能性があるので「設置できる状態」は保つ (削除しない)。"""
        env = {ALLOW_VOYAGE_ENV: "1", VOYAGE_KEY_ENV: "pa-secret"}
        assert voyage_allowed(env) is True
        route = resolve_embedding_route(env)
        assert route.provider == "voyage"
        assert route.state == "ready"
        assert "運営負担" in route.payer


class TestLocalStates:
    def test_disabled_local_is_reported_as_unavailable_with_next_step(self) -> None:
        route = resolve_embedding_route({"ATELIER_LOCAL_EMBEDDING": "0"})
        assert route.provider == "none"
        assert route.state == "unavailable"
        assert route.semantic_enabled is False
        assert route.next_steps  # 直し方を必ず出す

    def test_missing_component_explains_how_to_install(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from src.embeddings import local as local_emb

        monkeypatch.setattr(local_emb, "local_available", lambda: False)
        route = resolve_embedding_route({})
        assert route.provider == "none"
        assert route.state == "unavailable"
        assert any("uv sync" in step for step in route.next_steps)

    def test_model_not_loaded_yet_is_preparing_not_broken(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from src.embeddings import local as local_emb

        monkeypatch.setattr(local_emb, "local_available", lambda: True)
        monkeypatch.setattr(local_emb, "is_ready", lambda: False)
        route = resolve_embedding_route({})
        assert route.provider == "local"
        assert route.state == "preparing"
        assert route.semantic_enabled is False
        assert "費用なし" in route.payer

    def test_ready_local_is_free(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from src.embeddings import local as local_emb

        monkeypatch.setattr(local_emb, "local_available", lambda: True)
        monkeypatch.setattr(local_emb, "is_ready", lambda: True)
        route = resolve_embedding_route({})
        assert route.provider == "local"
        assert route.state == "ready"
        assert route.semantic_enabled is True
        assert route.model_tag is not None
        assert "費用なし" in route.payer
