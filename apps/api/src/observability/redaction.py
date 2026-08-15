r"""秘匿値マスクの語彙を集約する単一モジュール (T-F-48 / GAP-116)。

**なぜ 1 モジュールに集約するのか**
マスク規則が経路ごとに散っていると、片方だけ塞がれた形が必ず生まれる。実際 T-F-39 の
初回実装では `Authorization: Bearer <JWT>` が Better Stack 経路で素通りし、
`sentry.py` の `_SENSITIVE_HEADER_KEYS` には `cookie` があるのに Better Stack 側の語彙には
無い、という不揃いも残っていた。**語彙をここに一本化し、全経路がここを参照する。**

対象とする形式:

| 形式 | 例 | 出力 |
|---|---|---|
| key-value | `api_key=sk-…` / `token: …` | `api_key=[REDACTED]` |
| 認証スキーム付き | `Authorization: Bearer …` / `Basic …` / `Token …` | `Authorization:[REDACTED]` |
| 単体の認証スキーム | `Bearer <token>` | `Bearer [REDACTED]` |
| JSON の引用符形 | `{"token": "abc123"}` | `"token": "[REDACTED]"` |
| Cookie | `Set-Cookie: session=…` | `Set-Cookie:[REDACTED]` |
| 接続文字列 | `postgres://u:p@h/db` / `redis://:p@h` (ユーザ名省略形) | `postgres://[REDACTED]@h/db` |
| プロバイダ鍵 | `sk-…` / `sk_live_…` / `sk_test_…` | `[REDACTED]` |

適用順は重要。`Authorization: Bearer <JWT>` は key-value 規則が
`(?:Bearer|Basic|…)\s+` を**明示的に食わない**と `\S+` が "Bearer" で止まり、
トークン本体が素通りする (T-F-39 の QA_FAIL-2)。
"""

from __future__ import annotations

import base64
import binascii
import re
from collections.abc import Callable
from typing import Any, cast

REDACTED = "[REDACTED]"
"""ログ集約経路のマスク文字列。"""

FILTERED = "[Filtered]"
"""Sentry 経路のヘッダマスク文字列 (Sentry 側の慣習に合わせた表記)。"""

# ─────────────────────────────────────────────────────────────────────────────
# 語彙 — ここが全経路の唯一の定義
# ─────────────────────────────────────────────────────────────────────────────
_SECRET_WORDS = (
    "api[_-]?key",
    "token",
    "password",
    "passwd",
    "secret",
    "authorization",
    "cookie",
    "session",
    "credential",
)
"""秘匿とみなすキー語彙。key-value 形式・キー名判定・JSON 引用符形で共有する。"""

_AUTH_SCHEMES = "Bearer|Basic|Token|Digest"
"""`Authorization` に付く認証スキーム。値の一部として明示的に食う必要がある。"""

SENSITIVE_KEY_RE = re.compile(rf"({'|'.join(_SECRET_WORDS)}|dsn)", re.IGNORECASE)
"""この語を含むキーの値は中身を見ずに伏せる。"""

SENSITIVE_HEADER_KEYS = frozenset(
    {
        "authorization",
        "cookie",
        "set-cookie",
        "x-api-key",
        "x-auth-token",
        "x-supabase-auth",
    },
)
"""HTTP ヘッダ名の秘匿候補 (完全一致・case-insensitive)。"""

# 接続文字列の資格情報。`redis://:pass@host` のユーザ名省略形も拾う。
_URL_CREDENTIALS_RE = re.compile(
    r"(?P<scheme>\b[a-z][a-z0-9+.\-]*://)[A-Za-z0-9_\-.%]*:[A-Za-z0-9_\-.%]+@",
)

# JSON の引用符形 `"token": "abc123"`。キーだけ残して値を伏せる。
_JSON_SECRET_RE = re.compile(
    rf'(?P<key>"(?:{"|".join(_SECRET_WORDS)})")\s*:\s*"[^"]*"',
    re.IGNORECASE,
)

# `api_key=xxx` / `token: xxx` / `Authorization: Bearer xxx` / `Set-Cookie: session=…`
_KEYED_SECRET_RE = re.compile(
    rf"(?i)\b(?P<key>{'|'.join(_SECRET_WORDS)})\b"
    rf"\s*(?P<sep>[=:])\s*(?:(?:{_AUTH_SCHEMES})\s+)?\S+",
)

# 単体で現れる認証スキーム。**スキームによって条件を分ける。**
#
# `Bearer` は T-F-39 から無条件でマスクしてきた。ここに後付けの条件を課すと
# `Bearer abcdefghijklmnop` (英字のみ) が素通しになり **退行**する。
# `bearer` は実在のログ本文にまず現れない語なので、無条件で問題ない。
_BARE_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-=+/]+")

# 一方 `Token` / `Digest` / `Basic` は T-F-48 で新規に足したもので、
# **英単語として頻出する**ため無条件にすると通常のログ本文を壊す:
#   "invalid token signature"          -> "invalid token [REDACTED]"
#   "Basic authentication is disabled" -> "Basic [REDACTED] is disabled"
# エラー可視化基盤がエラーメッセージを読めなくする本末転倒 (D-FAIL-1) なので、
# **後続が「資格情報の形」のとき**だけ発火させる。判定は `_is_credential_shaped()`。
_BARE_ADDED_SCHEME_RE = re.compile(
    r"(?i)\b(?P<scheme>Token|Digest|Basic)\s+(?P<value>[A-Za-z0-9._\-=+/]+)",
)

_BASE64_RE = re.compile(r"[A-Za-z0-9+/]+={0,2}")
_CREDENTIAL_SYMBOLS = frozenset("0123456789._-=+/")
MIN_OPAQUE_CREDENTIAL_LENGTH = 16
"""英字のみの不透明トークンを資格情報とみなす下限。

この値は当てずっぽうではなく、両端から決めている:
- **下限側**: 本 API の実在エラーメッセージで認証スキーム語の直後に来る最長の英単語は
  `authentication` (14 文字)。16 ならそれを超える。
- **上限側**: 実運用の不透明トークン (base64 / hex / ランダム文字列) は 16 文字を下回らない。
`Bearer` にはこの条件を課さない (無条件マスク) ので、JWT の保護には影響しない。
"""


def _decodes_as_printable_base64(value: str) -> bool:
    """base64 として復号でき、中身が印字可能 ASCII なら True。

    `YWRtaWthYWRtaWthYWRt` のような**英字のみの base64 資格情報**を、
    英単語と区別するための構造判定。英単語は長さが 4 の倍数にならないか、
    復号しても非 ASCII になるためここで落ちる。
    """
    if len(value) % 4 != 0 or _BASE64_RE.fullmatch(value) is None:
        return False
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return False
    return bool(decoded) and all(32 <= byte < 127 for byte in decoded)


def _is_credential_shaped(value: str) -> bool:
    """後続トークンが「資格情報の形」かどうか。

    英単語を巻き込まないよう、**文字種だけで決めない**。次のいずれかを満たすとき資格情報:

    1. 数字か記号 (`._-=+/`) を含む — JWT / hex / パディング付き base64
    2. base64 として復号でき中身が印字可能 ASCII — 英字のみの base64 資格情報
    3. 16 文字以上 — 不透明トークン (上記 MIN_OPAQUE_CREDENTIAL_LENGTH の根拠を参照)

    `authentication` (14) / `expired` (7) / `mismatch` (8) / `signature` (9) は
    いずれも 3 条件すべてを満たさないため無改変で通る。
    """
    if any(ch in _CREDENTIAL_SYMBOLS for ch in value):
        return True
    if _decodes_as_printable_base64(value):
        return True
    return len(value) >= MIN_OPAQUE_CREDENTIAL_LENGTH


# プロバイダ発行鍵の代表形 (Anthropic / OpenAI / Stripe)
_PROVIDER_KEY_RES: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bsk-[A-Za-z0-9_\-]{12,}"),
    re.compile(r"\bsk_(?:live|test)_[A-Za-z0-9]{12,}"),
)


def _mask_url_credentials(match: re.Match[str]) -> str:
    return f"{match.group('scheme')}{REDACTED}@"


def _mask_json_secret(match: re.Match[str]) -> str:
    return f'{match.group("key")}: "{REDACTED}"'


def _mask_keyed_secret(match: re.Match[str]) -> str:
    return f"{match.group('key')}{match.group('sep')}{REDACTED}"


def _mask_bare_bearer(match: re.Match[str]) -> str:
    # 大文字小文字は入力どおりに残す (束 C からの挙動)。
    return f"{match.group(0).split()[0]} {REDACTED}"


def _mask_bare_scheme(match: re.Match[str]) -> str:
    """資格情報の形のときだけ伏せる。英文はそのまま返す (D-FAIL-1 再発防止)。"""
    if not _is_credential_shaped(match.group("value")):
        return match.group(0)
    return f"{match.group('scheme')} {REDACTED}"


REDACTION_RULES: tuple[tuple[re.Pattern[str], Callable[[re.Match[str]], str]], ...] = (
    # 適用順を変えないこと。key-value より先に JSON 引用符形を処理しないと
    # `"token": "abc"` が key-value 規則に部分一致して引用符が壊れる。
    (_URL_CREDENTIALS_RE, _mask_url_credentials),
    (_JSON_SECRET_RE, _mask_json_secret),
    (_KEYED_SECRET_RE, _mask_keyed_secret),
    (_BARE_BEARER_RE, _mask_bare_bearer),
    (_BARE_ADDED_SCHEME_RE, _mask_bare_scheme),
    *((pattern, lambda _match: REDACTED) for pattern in _PROVIDER_KEY_RES),
)
"""秘匿値の形と伏せ方 (適用順)。"""


def redact_text(text: str) -> str:
    """本文から秘匿値らしき部分を伏せる。全経路が共有する唯一の実装。"""
    redacted = text
    for pattern, replacement in REDACTION_RULES:
        redacted = pattern.sub(replacement, redacted)
    return redacted


def redact_mapping(values: dict[str, Any]) -> dict[str, Any]:
    """キー名が秘匿候補なら値を伏せ、文字列値には本文マスクも適用する。"""
    result: dict[str, Any] = {}
    for key, value in values.items():
        if SENSITIVE_KEY_RE.search(key):
            result[key] = REDACTED
        elif isinstance(value, str):
            result[key] = redact_text(value)
        elif isinstance(value, dict):
            # ログの extra は任意キーを取りうるのでキーを str に正規化してから再帰。
            nested = cast("dict[object, Any]", value)
            result[key] = redact_mapping({str(k): v for k, v in nested.items()})
        else:
            result[key] = value
    return result


def is_sensitive_header(name: object) -> bool:
    """ヘッダ名が秘匿候補なら True (case-insensitive 比較)。"""
    if not isinstance(name, str):
        return False
    return name.lower() in SENSITIVE_HEADER_KEYS


__all__ = [
    "FILTERED",
    "REDACTED",
    "REDACTION_RULES",
    "SENSITIVE_HEADER_KEYS",
    "SENSITIVE_KEY_RE",
    "is_sensitive_header",
    "redact_mapping",
    "redact_text",
]
