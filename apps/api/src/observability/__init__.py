"""Atelier 観測基盤。

GAP-182 (経営者判断 2026-08-19「B で進めて」):
**外部の監視 SaaS は使わない。** 以前はここに Sentry の初期化コードだけがあり、
(a) main.py から一度も呼ばれず (b) SDK も依存に入っていなかったため、
本番でエラーが起きても誰も気づけない状態だった (docs には「Sentry EU 接続済」と
書かれていたが事実ではない)。

現在: `errors.py` が例外を自分たちの DB (`public.error_log`) に記録し、
運営メニュー > 監査ログ画面の「エラーログ」で確認する。スタックトレース・URL・
ユーザー ID を外部に出さず、追加費用もゼロ。
"""

from .errors import list_errors, record_error, record_exception

__all__ = [
    "list_errors",
    "record_error",
    "record_exception",
]
