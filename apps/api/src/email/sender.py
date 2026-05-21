"""Resend API ラッパー。"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any, cast

import httpx
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

RESEND_API_BASE = "https://api.resend.com"


class EmailSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ATELIER_EMAIL_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    api_key: str = Field(default="", description="Resend API key")
    from_address: str = Field(
        default="Atelier <noreply@atelier.local>",
        description='RFC 5322 形式の From アドレス',
    )
    dry_run: bool = Field(
        default=False, description="True で API を呼ばずに結果を擬似的に返す"
    )
    request_timeout_seconds: float = Field(default=10.0, gt=0)


@lru_cache(maxsize=1)
def _settings() -> EmailSettings:
    return EmailSettings()


@dataclass(frozen=True)
class EmailMessage:
    to: tuple[str, ...]
    subject: str
    html: str
    text: str | None = None
    reply_to: str | None = None
    tags: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class EmailSendResult:
    id: str
    dry_run: bool


class ResendSender:
    """Resend 送信クライアント。"""

    def __init__(self, settings: EmailSettings | None = None) -> None:
        self._settings = settings or _settings()

    async def send(self, message: EmailMessage) -> EmailSendResult:
        if self._settings.dry_run or not self._settings.api_key:
            return EmailSendResult(id="dry-run", dry_run=True)

        payload: dict[str, Any] = {
            "from": self._settings.from_address,
            "to": list(message.to),
            "subject": message.subject,
            "html": message.html,
        }
        if message.text is not None:
            payload["text"] = message.text
        if message.reply_to is not None:
            payload["reply_to"] = message.reply_to
        if message.tags:
            payload["tags"] = [
                {"name": k, "value": v} for k, v in message.tags
            ]

        async with httpx.AsyncClient(
            timeout=self._settings.request_timeout_seconds
        ) as http:
            response = await http.post(
                f"{RESEND_API_BASE}/emails",
                headers={
                    "Authorization": f"Bearer {self._settings.api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            response.raise_for_status()
            body = cast(dict[str, Any], response.json())

        return EmailSendResult(id=str(body.get("id", "")), dry_run=False)
