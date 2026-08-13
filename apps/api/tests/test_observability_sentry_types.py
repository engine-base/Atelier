"""T-F-45: before_send が実 SDK の `EventProcessor` 契約に整合していることの検証。

`sentry-sdk` 実導入 (T-F-42) で初めて可視化された型不整合。旧シグネチャは
`(dict[str, Any], object) -> dict[str, Any]` で、実 SDK が要求する
`EventProcessor = (Event, Hint) -> Event | None` と噛み合っていなかった。

**`type: ignore` / `cast` / `Any` で黙らせるのではなく、実シグネチャに合わせて解決した**
ことを、型そのものと実挙動の両面から固定する。マスク挙動 (秘匿値の伏せ字) が
型修正で壊れていないことも併せて検証する。
"""

# pyright: reportPrivateUsage=false
from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any, cast

import pytest
from sentry_sdk.types import Event, Hint

import src.observability.sentry as sentry_mod
from src.observability.sentry import _scrub_sensitive_fields

_SOURCE = Path(sentry_mod.__file__ or "")


def _event(payload: dict[str, Any]) -> Event:
    """テスト用のイベントを組み立てる (Event は SDK 側の TypedDict)。"""
    return cast("Event", payload)


def _hint() -> Hint:
    return cast("Hint", {})


@pytest.mark.unit
class TestSignatureMatchesTheSdkContract:
    def test_annotations_are_event_and_hint(self) -> None:
        """引数・戻り値が SDK の Event / Hint で宣言されている。"""
        annotations = inspect.get_annotations(_scrub_sensitive_fields)

        assert annotations["event"] == "Event"
        assert annotations["_hint"] == "Hint"
        assert annotations["return"] == "Event | None"

    def test_accepted_as_a_before_send_callable(self) -> None:
        """実 SDK の init に before_send として渡せること (実 init で確認)。"""
        import sentry_sdk

        try:
            sentry_sdk.init(
                dsn="https://public@o0.ingest.de.sentry.io/1",
                before_send=_scrub_sensitive_fields,
            )
            client = sentry_sdk.get_client()
            assert client.is_active() is True
            assert client.options["before_send"] is _scrub_sensitive_fields
        finally:
            sentry_sdk.get_global_scope().set_client(None)

    def test_no_blanket_type_suppression_in_the_module(self) -> None:
        """UNWANTED: type: ignore / 全体抑止コメントで黙らせていないこと。"""
        source = _SOURCE.read_text(encoding="utf-8")

        assert "type: ignore" not in source
        assert "# pyright: report" not in source


@pytest.mark.unit
class TestRedactionStillWorks:
    """UNWANTED critical: 型を直す過程でマスクを落とさない。"""

    def test_sensitive_headers_are_filtered(self) -> None:
        out = _scrub_sensitive_fields(
            _event(
                {
                    "request": {
                        "headers": {
                            "Authorization": "Bearer secret-token",
                            "Cookie": "session=abc",
                            "X-API-Key": "sk-realkeymaterial",
                            "Content-Type": "application/json",
                        },
                    },
                },
            ),
            _hint(),
        )

        assert out is not None
        # Event の "request" は必須キーではないので .get() で取り出す
        request = cast("dict[str, Any] | None", out.get("request"))
        assert request is not None
        headers = cast("dict[str, Any]", request["headers"])
        assert headers["Authorization"] == "[Filtered]"
        assert headers["Cookie"] == "[Filtered]"
        assert headers["X-API-Key"] == "[Filtered]"
        assert headers["Content-Type"] == "application/json"

    def test_event_is_never_dropped(self) -> None:
        """None を返すとイベントが破棄される。本 hook は必ず返す。"""
        assert _scrub_sensitive_fields(_event({"level": "error"}), _hint()) is not None

    @pytest.mark.parametrize(
        "payload",
        [
            {"level": "error"},
            {"request": {"url": "https://example.com"}},
            {"request": {"headers": "not a dict"}},
            {"request": "not a dict"},
        ],
    )
    def test_non_header_shapes_are_passed_through(self, payload: dict[str, Any]) -> None:
        assert _scrub_sensitive_fields(_event(payload), _hint()) is not None
