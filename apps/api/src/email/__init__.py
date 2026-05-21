"""Email 送信層。

Provider: Resend (selected-stack.json#email)
- HTTP API 経由で送信。Webhook で配信状態を受信 (将来)。
- HTML テンプレートは packages/email (React Email) 側でビルド済 HTML を渡す。
- 開発/テスト時は ATELIER_EMAIL_DRY_RUN=1 で実送信を抑止。
"""

from .sender import EmailMessage, EmailSendResult, EmailSettings, ResendSender

__all__ = [
    "EmailMessage",
    "EmailSendResult",
    "EmailSettings",
    "ResendSender",
]
