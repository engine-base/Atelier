"""GAP-194 / GAP-195: 運営への通知チャネル (メール / Slack)。

**どこで動くか**: 運営サーバー (Fly.io) の cron と、運営インフラの外側
(GitHub Actions の外形監視) の 2 か所から呼ばれる。
**誰の費用か**: 運営。Resend の無料枠 (月 3,000 通) 内に収まる設計で、
1 つの不具合につき冷却時間 (既定 60 分) に 1 通しか送らない。

送信先は環境変数で決まる。**設定されていなければ「送ったふり」をしない** —
skipped として理由つきで記録し、運営画面 (S-T05) に「送信先が未設定」と出す。
"""

from __future__ import annotations

import html
import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

import httpx
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from src.email import EmailMessage, ResendSender

logger = logging.getLogger(__name__)

AlertLevel = Literal["error", "warning", "recovery"]

_LEVEL_MARK: dict[AlertLevel, str] = {
    "error": "🔴",
    "warning": "🟡",
    "recovery": "🟢",
}


class AlertSettings(BaseSettings):
    """通知の設定。env prefix は ATELIER_ALERT_。"""

    model_config = SettingsConfigDict(
        env_prefix="ATELIER_ALERT_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    #: 通知先メールアドレス (カンマ区切り)。空なら メール通知は行わない。
    email_to: str = Field(default="")
    #: Slack Incoming Webhook URL。空なら Slack 通知は行わない。
    slack_webhook_url: str = Field(default="")
    #: 同じ不具合を再通知するまでの冷却時間 (分)。
    cooldown_minutes: int = Field(default=60, ge=1, le=10080)
    #: warning レベルも通知するか (既定 False — ノイズになるため)。
    notify_warnings: bool = Field(default=False)
    #: 1 回の実行で送る最大件数 (メール爆撃を防ぐ)。超過分は次回に回す。
    max_per_run: int = Field(default=5, ge=1, le=50)
    #: 通知本文に載せる運営画面の URL (空なら載せない)。
    dashboard_url: str = Field(default="")
    request_timeout_seconds: float = Field(default=10.0, gt=0)


@lru_cache(maxsize=1)
def _settings() -> AlertSettings:
    return AlertSettings()


def alert_settings() -> AlertSettings:
    """設定を返す (テストからは引数で差し替える)。"""
    return _settings()


def recipients(settings: AlertSettings | None = None) -> tuple[str, ...]:
    cfg = settings or alert_settings()
    return tuple(a.strip() for a in cfg.email_to.split(",") if a.strip())


def configured_channels(settings: AlertSettings | None = None) -> tuple[str, ...]:
    """実際に送れるチャネルを返す。空タプル = どこにも通知できない。"""
    cfg = settings or alert_settings()
    out: list[str] = []
    if recipients(cfg):
        out.append("email")
    if cfg.slack_webhook_url.strip():
        out.append("slack")
    return tuple(out)


@dataclass(frozen=True)
class AlertDelivery:
    """1 回の通知の結果。

    status:
        sent    = 1 つ以上のチャネルへ届いた
        failed  = チャネルはあるが全部失敗した (次回再試行する)
        skipped = 送信先が 1 つも設定されていない
    """

    status: Literal["sent", "failed", "skipped"]
    detail: str
    channels: tuple[str, ...]


def _plain_text(title: str, lines: list[str], dashboard_url: str) -> str:
    body = [title, ""]
    body.extend(lines)
    if dashboard_url:
        body.extend(["", f"運営画面: {dashboard_url}"])
    return "\n".join(body)


def _html_body(title: str, lines: list[str], dashboard_url: str) -> str:
    items = "".join(f"<li>{html.escape(line)}</li>" for line in lines)
    link = (
        f'<p><a href="{html.escape(dashboard_url, quote=True)}">運営画面で確認する</a></p>'
        if dashboard_url
        else ""
    )
    return (
        '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px">'
        f'<h2 style="font-size:16px;margin:0 0 8px">{html.escape(title)}</h2>'
        f'<ul style="padding-left:18px;margin:0">{items}</ul>'
        f"{link}"
        "</div>"
    )


async def _send_email(
    cfg: AlertSettings, subject: str, title: str, lines: list[str]
) -> tuple[bool, str]:
    try:
        result = await ResendSender().send(
            EmailMessage(
                to=recipients(cfg),
                subject=subject,
                html=_html_body(title, lines, cfg.dashboard_url),
                text=_plain_text(title, lines, cfg.dashboard_url),
                tags=(("kind", "alert"),),
            )
        )
    except Exception as exc:  # 通知の失敗でアプリを止めない
        logger.warning("alert email failed: %s", exc)
        return False, f"email 失敗: {type(exc).__name__}"
    if result.dry_run:
        return False, "email 未送信 (dry-run / API key 未設定)"
    return True, "email 送信"


async def _send_slack(cfg: AlertSettings, title: str, lines: list[str]) -> tuple[bool, str]:
    text = _plain_text(f"{title}", lines, cfg.dashboard_url)
    try:
        async with httpx.AsyncClient(timeout=cfg.request_timeout_seconds) as http:
            response = await http.post(cfg.slack_webhook_url.strip(), json={"text": text})
            response.raise_for_status()
    except Exception as exc:  # 通知の失敗でアプリを止めない
        logger.warning("alert slack failed: %s", exc)
        return False, f"slack 失敗: {type(exc).__name__}"
    return True, "slack 送信"


async def send_alert(
    *,
    title: str,
    lines: list[str],
    level: AlertLevel = "error",
    settings: AlertSettings | None = None,
) -> AlertDelivery:
    """通知を送る。設定されているチャネル全部に送り、1 つでも成功すれば sent。

    例外は投げない。呼び出し元 (cron / 監視) を通知の都合で落とさないため。
    """
    cfg = settings or alert_settings()
    channels = configured_channels(cfg)
    if not channels:
        return AlertDelivery(
            status="skipped",
            detail=("送信先が未設定 (ATELIER_ALERT_EMAIL_TO / ATELIER_ALERT_SLACK_WEBHOOK_URL)"),
            channels=(),
        )

    subject = f"{_LEVEL_MARK[level]} [Atelier] {title}"
    details: list[str] = []
    delivered: list[str] = []
    if "email" in channels:
        ok, detail = await _send_email(cfg, subject, title, lines)
        details.append(detail)
        if ok:
            delivered.append("email")
    if "slack" in channels:
        ok, detail = await _send_slack(cfg, subject, lines)
        details.append(detail)
        if ok:
            delivered.append("slack")

    return AlertDelivery(
        status="sent" if delivered else "failed",
        detail=" / ".join(details),
        channels=tuple(delivered),
    )


__all__ = [
    "AlertDelivery",
    "AlertLevel",
    "AlertSettings",
    "alert_settings",
    "configured_channels",
    "recipients",
    "send_alert",
]
