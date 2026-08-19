"""GAP-133: ローカル埋め込み + provider 抽象化の unit tests。

実モデル DL を要する経路は e2e (.qa/gap-133) が担当。ここでは純粋部分
(パディング / env 判定 / provider 分岐) を検証する。
"""

from __future__ import annotations

from typing import Any, ClassVar

import pytest

from src.embeddings import local as local_emb
from src.services import knowledge as kn

# ---------------------------------------------------------------------------
# パディング (cosine 順位不変のゼロパディング / 超過は拒否)
# ---------------------------------------------------------------------------


def test_pad_to_target_pads_and_keeps_exact() -> None:
    padded = local_emb.pad_to_target([1.0, 2.0])
    assert len(padded) == local_emb.TARGET_DIMENSIONS
    assert padded[:2] == [1.0, 2.0]
    assert all(v == 0.0 for v in padded[2:])
    exact = [0.5] * local_emb.TARGET_DIMENSIONS
    assert local_emb.pad_to_target(exact) == exact


def test_pad_to_target_rejects_oversize() -> None:
    """1024 次元超は切り詰めが検索順位を壊すため誠実に拒否する。"""
    with pytest.raises(ValueError):
        local_emb.pad_to_target([0.1] * (local_emb.TARGET_DIMENSIONS + 1))


# ---------------------------------------------------------------------------
# env 判定
# ---------------------------------------------------------------------------


def test_local_enabled_and_model_env() -> None:
    assert local_emb.local_embedding_enabled({}) is True
    assert local_emb.local_embedding_enabled({local_emb.ENABLE_ENV: "0"}) is False
    assert local_emb.local_embedding_model({}) == local_emb.DEFAULT_MODEL
    assert local_emb.local_embedding_model({local_emb.MODEL_ENV: "my/model"}) == "my/model"
    assert local_emb.local_model_tag({local_emb.MODEL_ENV: "my/model"}) == "local:my/model"


# ---------------------------------------------------------------------------
# provider 分岐 (_embed_text): Voyage → ローカル → (None, None)
# ---------------------------------------------------------------------------


class _FakeVoyage:
    def __init__(self, *_: Any, **__: Any) -> None: ...

    async def embed_query(self, _q: str) -> list[float]:
        return [0.1] * 1024

    async def embed(self, _texts: list[str], **__: Any) -> Any:
        class _R:
            embeddings: ClassVar[list[list[float]]] = [[0.2] * 1024]

        return _R()


@pytest.mark.asyncio
async def test_embed_text_uses_voyage_only_when_explicitly_allowed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GAP-180: 明示 opt-in があるときだけ Voyage を使う。"""
    monkeypatch.setenv("VOYAGE_API_KEY", "test-key")
    monkeypatch.setenv("ATELIER_ALLOW_VOYAGE", "1")
    monkeypatch.setattr(kn, "VoyageClient", _FakeVoyage)
    vec, tag = await kn._embed_text("query 文", input_type="query")  # pyright: ignore[reportPrivateUsage]
    assert tag == "voyage-3-large" and vec is not None and len(vec) == 1024


@pytest.mark.asyncio
async def test_embed_text_ignores_voyage_key_without_opt_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GAP-180: キーが env にあるだけでは課金経路に切り替わらない。"""
    monkeypatch.setenv("VOYAGE_API_KEY", "test-key")
    monkeypatch.delenv("ATELIER_ALLOW_VOYAGE", raising=False)
    monkeypatch.setattr(local_emb, "local_available", lambda: True)
    monkeypatch.setattr(local_emb, "is_ready", lambda: True)

    async def _fake_q(_q: str) -> list[float]:
        return [0.5] * 1024

    monkeypatch.setattr(local_emb, "embed_query", _fake_q)
    monkeypatch.setattr(local_emb, "local_model_tag", lambda env=None: "local:test-model")
    vec, tag = await kn._embed_text("query 文", input_type="query")  # pyright: ignore[reportPrivateUsage]
    assert tag == "local:test-model" and vec is not None


@pytest.mark.asyncio
async def test_embed_text_skips_local_while_model_loading(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """初回モデル DL 中 (is_ready=False) はブロックせず (None, None) で degrade。"""
    monkeypatch.delenv("VOYAGE_API_KEY", raising=False)
    monkeypatch.setattr(local_emb, "local_available", lambda: True)
    monkeypatch.setattr(local_emb, "is_ready", lambda: False)
    vec, tag = await kn._embed_text("x")  # pyright: ignore[reportPrivateUsage]
    assert vec is None and tag is None


@pytest.mark.asyncio
async def test_embed_text_falls_to_local(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("VOYAGE_API_KEY", raising=False)
    monkeypatch.setattr(local_emb, "local_available", lambda: True)
    monkeypatch.setattr(local_emb, "is_ready", lambda: True)

    async def _fake_q(_q: str) -> list[float]:
        return [0.3] * 1024

    async def _fake_d(_texts: list[str]) -> list[list[float]]:
        return [[0.4] * 1024]

    monkeypatch.setattr(local_emb, "embed_query", _fake_q)
    monkeypatch.setattr(local_emb, "embed_documents", _fake_d)
    vec, tag = await kn._embed_text("query 文", input_type="query")  # pyright: ignore[reportPrivateUsage]
    assert tag == f"local:{local_emb.DEFAULT_MODEL}" and vec == [0.3] * 1024
    vec2, tag2 = await kn._embed_text("doc 文")  # pyright: ignore[reportPrivateUsage]
    assert tag2 == f"local:{local_emb.DEFAULT_MODEL}" and vec2 == [0.4] * 1024


@pytest.mark.asyncio
async def test_embed_text_none_when_no_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("VOYAGE_API_KEY", raising=False)
    monkeypatch.setattr(local_emb, "local_available", lambda: False)
    vec, tag = await kn._embed_text("x")  # pyright: ignore[reportPrivateUsage]
    assert vec is None and tag is None


def test_search_response_has_honest_mode_default() -> None:
    from src.schemas.knowledge import KnowledgeSearchResponse

    r = KnowledgeSearchResponse(query="q", hits=[], total=0)
    assert r.search_mode == "text_fallback"
