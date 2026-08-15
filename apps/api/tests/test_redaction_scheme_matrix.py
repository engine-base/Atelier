"""T-F-49: 認証スキーム × 後続トークンの形 のマトリクス検証 (GAP-122)。

単体形の `Basic` / `Token` / `Digest` に続く**英字のみの資格情報**が素通ししていた。
単純に条件を緩めると D-FAIL-1 (英単語 "token" / "basic" への誤爆で実在エラーメッセージを
破壊) を再発させるため、**後続語の文字種ではなく「資格情報の形かどうか」**で判定する。

判定 (`_is_credential_shaped`) の 3 条件:
  1. 数字か記号 (`._-=+/`) を含む — JWT / hex / パディング付き base64
  2. base64 として復号でき中身が印字可能 ASCII — 英字のみの base64 資格情報
  3. 16 文字以上 — 不透明トークン

`Bearer` にはこの条件を課さない (T-F-48 で復元した無条件マスクを維持)。
"""

# pyright: reportPrivateUsage=false
from __future__ import annotations

import pytest

from src.observability.redaction import (
    MIN_OPAQUE_CREDENTIAL_LENGTH,
    REDACTED,
    _decodes_as_printable_base64,
    _is_credential_shaped,
    redact_text,
)

#: 条件を課すスキーム (T-F-48 で追加した語。英単語として頻出する)
GUARDED_SCHEMES = ("Basic", "Token", "Digest")

#: 資格情報の形をした後続トークン。どのスキームでも伏せられるべき。
CREDENTIAL_TOKENS = (
    ("英字のみ base64", "YWRtaWthYWRtaWthYWRt"),
    ("英字のみ 16 文字", "abcdefghijklmnop"),
    ("英大文字のみ 16 文字", "ABCDEFGHIJKLMNOP"),
    ("パディング付き base64", "dXNlcjpwYXNzd29yZA=="),
    ("user:pass の base64", "YWRtaW46YWRtaW4="),
    ("hex", "0123456789abcdef"),
    ("JWT 風", "eyJhbGciOi.JIUzI1"),
)

#: 実在するエラーメッセージに出る英単語。どのスキームでも伏せてはいけない。
PROSE_WORDS = (
    "authentication",
    "expired",
    "mismatch",
    "signature",
    "disabled",
    "endpoint",
    "usage",
    "invalid",
)


@pytest.mark.unit
class TestCredentialShapeDiscriminator:
    @pytest.mark.parametrize(("label", "token"), CREDENTIAL_TOKENS)
    def test_credential_tokens_are_recognised(self, label: str, token: str) -> None:
        assert _is_credential_shaped(token) is True, label

    @pytest.mark.parametrize("word", PROSE_WORDS)
    def test_prose_words_are_not_credentials(self, word: str) -> None:
        assert _is_credential_shaped(word) is False, word

    def test_threshold_is_above_the_longest_real_prose_word(self) -> None:
        """しきい値の根拠を固定する。実在メッセージの最長語 (authentication=14) を超えること。"""
        assert max(len(w) for w in PROSE_WORDS) < MIN_OPAQUE_CREDENTIAL_LENGTH

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("YWRtaWthYWRtaWthYWRt", True),  # -> "admikaadmikaadm"
            ("dXNlcjpwYXNzd29yZA==", True),  # -> "user:password"
            ("YWRtaW46YWRtaW4=", True),  # -> "admin:admin"
            ("authentication", False),  # 長さが 4 の倍数でない
            ("mismatch", False),  # 復号すると非印字
            ("abcdefghijklmnop", False),  # 復号すると非印字 (長さ条件で別途拾う)
        ],
    )
    def test_base64_printable_check(self, value: str, expected: bool) -> None:
        assert _decodes_as_printable_base64(value) is expected


@pytest.mark.unit
class TestSchemeMatrix:
    """スキーム × トークンの全組み合わせ。"""

    @pytest.mark.parametrize("scheme", GUARDED_SCHEMES)
    @pytest.mark.parametrize(("label", "token"), CREDENTIAL_TOKENS)
    def test_credentials_are_masked(self, scheme: str, label: str, token: str) -> None:
        out = redact_text(f"{scheme} {token}")

        assert out == f"{scheme} {REDACTED}", f"{scheme} / {label}"
        assert token not in out

    @pytest.mark.parametrize("scheme", GUARDED_SCHEMES)
    @pytest.mark.parametrize("word", PROSE_WORDS)
    def test_prose_is_untouched(self, scheme: str, word: str) -> None:
        """UNWANTED critical: D-FAIL-1 の過剰マスクを再発させない。"""
        message = f"{scheme} {word} is not a credential"

        assert redact_text(message) == message

    @pytest.mark.parametrize(("label", "token"), CREDENTIAL_TOKENS)
    def test_bearer_stays_unconditional(self, label: str, token: str) -> None:
        """tier_3: Bearer は T-F-48 で復元した無条件マスクのまま。"""
        assert redact_text(f"Bearer {token}") == f"Bearer {REDACTED}", label

    @pytest.mark.parametrize("word", PROSE_WORDS)
    def test_bearer_masks_even_plain_words(self, word: str) -> None:
        """Bearer は英単語が続いても伏せる (束 C からの挙動。`bearer` は本文に出ない語)。"""
        assert redact_text(f"Bearer {word}") == f"Bearer {REDACTED}"


@pytest.mark.unit
class TestRealMessagesStayIntact:
    """本 API に実在するエラーメッセージ (D-FAIL-1 の出典) を丸ごと固定する。"""

    @pytest.mark.parametrize(
        "message",
        [
            "invalid token signature",
            "token expired",
            "client portal token is not valid here",
            "bridge token not configured (set ATELIER_BRIDGE_TOKEN)",
            "refresh token is invalid or expired",
            "Supabase token endpoint failed: 500",
            "Basic authentication is disabled for this endpoint",
            "1 リクエスト分の token usage",
            "Token expired",
            "Digest mismatch",
        ],
    )
    def test_message_is_unchanged(self, message: str) -> None:
        assert redact_text(message) == message
