"""T-A-58 回帰: content-url が **要求された format の属性だけ**を参照すること。

GAP-110。旧実装は `{"html": out.html_path, "json": out.json_path, "md": out.md_path}[format]`
と 3 属性を eager に辞書化していたため、未要求 format の列を持たないオブジェクト
(部分投影のクエリ結果や、実カラム形状に満たないテストダブル) で
`AttributeError: 'types.SimpleNamespace' object has no attribute 'json_path'` になった。

本ファイルは **属性が欠落していても要求 format が解決できれば 200 を返す**こと、
かつ 404 / 409 / 502 / 503 の応答コードが従来どおりであることを固定する。
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src import storage_signing
from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.routes.outputs import router
from src.services import outputs as outputs_svc

SIGNED = "/object/sign/outputs/estimate-v2.html?token=abc"


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="u1", role="authenticated", claims={}
    )
    app.dependency_overrides[get_rls_session] = lambda: SimpleNamespace()
    return app


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = ""

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeClient:
    def __init__(self, *_a: Any, **_k: Any) -> None:
        pass

    async def __aenter__(self) -> _FakeClient:
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False

    async def post(
        self,
        url: str,
        headers: dict[str, str] | None = None,
        json: dict[str, Any] | None = None,
    ) -> _FakeResponse:
        return _FakeResponse(200, {"signedURL": SIGNED})


def _patch_get_output(monkeypatch: pytest.MonkeyPatch, result: object) -> None:
    async def _fake(_session: Any, _output_id: str) -> object:
        return result

    monkeypatch.setattr(outputs_svc, "get_output", _fake)


def _configure_storage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "https://proj.supabase.co")
    monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "svc-key")
    monkeypatch.setattr(storage_signing.httpx, "AsyncClient", _FakeClient)


@pytest.mark.unit
class TestRequestedFormatOnly:
    def test_html_succeeds_when_other_format_attributes_are_absent(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """EVENT-DRIVEN: json_path / md_path が**存在しない**行でも html は 200。"""
        _configure_storage(monkeypatch)
        _patch_get_output(
            monkeypatch,
            SimpleNamespace(html_path="outputs/estimate-v2.html"),  # 意図的に 1 属性のみ
        )

        with TestClient(_app()) as client:
            res = client.get("/outputs/o1/content-url", params={"format": "html"})

        assert res.status_code == 200
        assert res.json()["data"]["url"].endswith(SIGNED)

    @pytest.mark.parametrize("fmt", ["html", "json", "md"])
    def test_each_format_resolves_its_own_attribute(
        self,
        monkeypatch: pytest.MonkeyPatch,
        fmt: str,
    ) -> None:
        """要求 format の属性だけを持つ行でも、その format は 200 になる。"""
        _configure_storage(monkeypatch)
        _patch_get_output(monkeypatch, SimpleNamespace(**{f"{fmt}_path": f"outputs/x.{fmt}"}))

        with TestClient(_app()) as client:
            res = client.get("/outputs/o1/content-url", params={"format": fmt})

        assert res.status_code == 200


@pytest.mark.unit
class TestResponseCodesUnchanged:
    def test_409_when_requested_format_is_missing(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """UNWANTED: 未生成 format は 409 のまま (存在しない版を偽装しない)。"""
        _configure_storage(monkeypatch)
        _patch_get_output(
            monkeypatch,
            SimpleNamespace(html_path="outputs/x.html", json_path=None, md_path=None),
        )

        with TestClient(_app()) as client:
            res = client.get("/outputs/o1/content-url", params={"format": "md"})

        assert res.status_code == 409

    def test_409_when_attribute_is_entirely_absent(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """属性ごと欠けている場合も 500 ではなく 409 (未生成扱い)。"""
        _configure_storage(monkeypatch)
        _patch_get_output(monkeypatch, SimpleNamespace(html_path="outputs/x.html"))

        with TestClient(_app()) as client:
            res = client.get("/outputs/o1/content-url", params={"format": "md"})

        assert res.status_code == 409

    def test_404_when_output_is_invisible(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _configure_storage(monkeypatch)
        _patch_get_output(monkeypatch, None)

        with TestClient(_app()) as client:
            res = client.get("/outputs/missing/content-url")

        assert res.status_code == 404

    def test_503_when_storage_is_unconfigured(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("ATELIER_SUPABASE_ADMIN_API_URL", raising=False)
        monkeypatch.delenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", raising=False)
        _patch_get_output(monkeypatch, SimpleNamespace(html_path="outputs/x.html"))

        with TestClient(_app()) as client:
            res = client.get("/outputs/o1/content-url")

        assert res.status_code == 503

    def test_502_when_signing_backend_fails(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _configure_storage(monkeypatch)

        class _ErrorClient(_FakeClient):
            async def post(
                self,
                url: str,
                headers: dict[str, str] | None = None,
                json: dict[str, Any] | None = None,
            ) -> _FakeResponse:
                return _FakeResponse(500, {"message": "boom"})

        monkeypatch.setattr(storage_signing.httpx, "AsyncClient", _ErrorClient)
        _patch_get_output(monkeypatch, SimpleNamespace(html_path="outputs/x.html"))

        with TestClient(_app()) as client:
            res = client.get("/outputs/o1/content-url")

        assert res.status_code == 502

    def test_422_for_an_unsupported_format(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Literal 検証は従来どおり (属性名を getattr で組み立てても緩まない)。"""
        _configure_storage(monkeypatch)
        _patch_get_output(monkeypatch, SimpleNamespace(html_path="outputs/x.html"))

        with TestClient(_app()) as client:
            res = client.get("/outputs/o1/content-url", params={"format": "__init__"})

        assert res.status_code == 422
