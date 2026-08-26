"""リクエストの形が合わないとき (422) に何を返すか (GAP-222)。

2026-08-26 の通し (J10-02) で、登録の必須項目を 1 つ落として送ったら
**入力したパスワードがそのまま応答に返ってきた**。

  {"detail":[{"type":"missing","loc":["body","display_name"],"msg":"Field required",
              "input":{"email":"...","password":"Atelier-Journey-2026!"}}]}

FastAPI の既定は送られてきた本文をエコーバックする。ブラウザの開発者ツール・
プロキシ・アクセスログ・エラー収集のどこに残ってもおかしくない。
`msg` も英語で、GAP-216/218 で route 側に張った網には掛からない
(schema 検証は route に入る前に起きるため)。

ここで固定するのは 3 つ:
  1. 入力値を 1 文字も返さない
  2. どの項目かは日本語の名前で伝える (利用者が直せるように)
  3. 何が悪いかも日本語 (英語の既定文を出さない)
"""

from __future__ import annotations

import re

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel, Field

from src.errors import FIELD_NAMES, validation_detail

SECRET = "Atelier-Journey-2026!"


class _Signup(BaseModel):
    email: str
    password: str
    display_name: str
    consents: list[str] = Field(min_length=2)


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.exception_handler(RequestValidationError)
    async def _handler(_req: object, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": validation_detail(exc.errors())})

    @app.post("/signup")
    async def _signup(body: _Signup) -> dict[str, str]:  # pyright: ignore[reportUnusedFunction]
        return {"ok": body.email}

    return app


async def _post(payload: dict[str, object]) -> tuple[int, object]:
    transport = ASGITransport(app=_build_app(), raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/signup", json=payload)
    return res.status_code, res.json()["detail"]


@pytest.mark.asyncio
async def test_送ったパスワードを返さない() -> None:
    status, detail = await _post({"email": "a@example.com", "password": SECRET, "consents": []})
    assert status == 422
    assert isinstance(detail, str)
    assert SECRET not in detail
    assert "a@example.com" not in detail


@pytest.mark.asyncio
async def test_どの項目かを日本語で伝える() -> None:
    _, detail = await _post({"email": "a@example.com", "password": SECRET, "consents": ["x", "y"]})
    assert isinstance(detail, str)
    assert "表示名" in detail
    # 内部名をそのまま出さない
    assert "display_name" not in detail


@pytest.mark.asyncio
async def test_英語の既定メッセージを出さない() -> None:
    _, detail = await _post({"email": "a@example.com", "password": SECRET, "consents": []})
    assert isinstance(detail, str)
    for english in ("Field required", "List should have", "value is not", "Input should"):
        assert english not in detail
    assert not re.search(r"[A-Za-z]{4,}", detail), f"英語が残っている: {detail}"


@pytest.mark.asyncio
async def test_項目が複数欠けても全部日本語() -> None:
    _, detail = await _post({"consents": []})
    assert isinstance(detail, str)
    assert "メールアドレス" in detail
    assert "パスワード" in detail
    assert not re.search(r"[A-Za-z]{4,}", detail)


def test_知らない項目でも内部名を出さない() -> None:
    detail = validation_detail([{"type": "missing", "loc": ["body", "some_internal_field"]}])
    assert "some_internal_field" not in detail
    assert "入力内容" in detail


def test_知らない種類でも英語を出さない() -> None:
    detail = validation_detail([{"type": "brand_new_pydantic_type", "loc": ["body", "email"]}])
    assert not re.search(r"[A-Za-z]{4,}", detail), detail


@pytest.mark.parametrize(("field", "label"), sorted(FIELD_NAMES.items()))
def test_項目名の表が日本語(field: str, label: str) -> None:
    assert not re.search(r"[A-Za-z]", label), f"{field}: 英字が混じっている — {label}"
