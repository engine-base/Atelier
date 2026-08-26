"""認証まわりのメールが実際に送られるか (GAP-223)。

2026-08-26 の通し (J13-01「パスワードを再設定する」) で分かったこと:

  `request_password_reset` は再設定用トークンを作り、その hash を監査ログに
  記録したあと、**平文トークンを `_ = plain` で捨てていた**。受け取る手段が
  どこにも無いので、**パスワードを忘れた人は永久に復旧できなかった**。

  `_send_magic_link_email` も同じで、`_ = email; _ = link; return` という
  本番でも no-op のスタブだった。

同じリポジトリの招待メール・商談資料の送付・サポート・障害通知は
`ResendSender` で実際に送っている。**認証まわりの 2 本だけが繋ぎ忘れ**だった。

ここで固定するのは 3 つ:
  1. 再設定を要求したら**送信が呼ばれる**
  2. 送る本文に**その回のトークンが入っている** (別のリンクを送っていない)
  3. 送信に失敗しても呼び出し側の応答を変えない (宛先の存在を漏らさない)
"""

from __future__ import annotations

import os
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from src.services import auth as svc


@pytest.fixture
def public_base(monkeypatch: pytest.MonkeyPatch) -> str:
    base = "https://atelier.test"
    monkeypatch.setenv("ATELIER_PUBLIC_BASE_URL", base)
    return base


def _sent(sender: AsyncMock) -> Any:
    assert sender.await_count == 1, "メールが 1 通も送られていない"
    return sender.await_args.args[0]


@pytest.mark.asyncio
async def test_パスワード再設定でメールが送られる(public_base: str) -> None:
    sender = AsyncMock()
    with (
        patch("src.email.sender.ResendSender.send", sender),
        patch.object(svc, "_emit_token_audit", AsyncMock()),
        patch.object(svc, "_service_session_factory", _fake_factory()),
    ):
        await svc.request_password_reset(email="who@example.com", ip_address="127.0.0.1")

    msg = _sent(sender)
    assert msg.to == ("who@example.com",)
    assert "パスワード" in msg.subject
    # 受け取る手段が本文にある = トークンを捨てていない
    assert public_base in msg.text
    assert "token=" in msg.text


@pytest.mark.asyncio
async def test_送る本文にその回のトークンが入る(public_base: str) -> None:
    """別のリンクを送っていないこと。監査に残す hash と同じ token であること。"""
    sender = AsyncMock()
    audit = AsyncMock()
    with (
        patch("src.email.sender.ResendSender.send", sender),
        patch.object(svc, "_emit_token_audit", audit),
        patch.object(svc, "_service_session_factory", _fake_factory()),
    ):
        await svc.request_password_reset(email="who@example.com", ip_address=None)

    token_in_mail = _sent(sender).text.split("token=")[1].split()[0].strip()
    recorded_hash = audit.await_args.kwargs["token_hash"]
    assert svc._hash_token(token_in_mail) == recorded_hash  # pyright: ignore[reportPrivateUsage]


@pytest.mark.asyncio
async def test_サインイン用リンクも送られる(public_base: str) -> None:
    sender = AsyncMock()
    with (
        patch("src.email.sender.ResendSender.send", sender),
        patch.object(svc, "_emit_token_audit", AsyncMock()),
        patch.object(svc, "_service_session_factory", _fake_factory()),
    ):
        await svc.request_magic_link(email="who@example.com", redirect_url=None, ip_address=None)

    msg = _sent(sender)
    assert "サインイン" in msg.subject
    assert "token=" in msg.text


@pytest.mark.asyncio
async def test_送信に失敗しても呼び出し側は落ちない(public_base: str) -> None:
    """宛先が存在するかどうかを、応答から読み取られないようにする。"""
    boom = AsyncMock(side_effect=RuntimeError("resend down"))
    with (
        patch("src.email.sender.ResendSender.send", boom),
        patch.object(svc, "_emit_token_audit", AsyncMock()),
        patch.object(svc, "_service_session_factory", _fake_factory()),
    ):
        # 例外が漏れない = route は 202 を返し続ける
        await svc.request_password_reset(email="who@example.com", ip_address=None)


def test_スタブに戻っていないこと() -> None:
    """`_ = email` で捨てる実装に戻すと、上のテストは通るが本番で送られない
    ような書き方も有り得るので、送信呼び出しの存在自体を見る。"""
    import inspect

    src = inspect.getsource(svc._send_auth_email)  # pyright: ignore[reportPrivateUsage]
    assert "ResendSender" in src, "実際の送信経路を呼んでいない (スタブに戻っている)"


def _fake_factory() -> Any:
    """DB を使わずに request_* を通すためのセッション工場。"""
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _session() -> Any:
        session = AsyncMock()
        session.commit = AsyncMock()
        session.rollback = AsyncMock()
        yield session

    def _factory() -> Any:
        return _session

    return _factory


@pytest.fixture(autouse=True)
def _no_dry_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """dry-run 指定が残っていても、送信経路そのものを検査する。"""
    monkeypatch.delenv("ATELIER_EMAIL_DRY_RUN", raising=False)
    os.environ.setdefault("ATELIER_EMAIL_API_KEY", "test-key")
