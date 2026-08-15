"""T-F-54: 英単語コーパスに対する誤マスクの検証と、**根拠コメントの真偽の固定** (GAP-124)。

qa が英単語 68 語 × 6 スキーム = 408 件を掃いて **18 件 (3 語)** の誤マスクを検出した:

| 語 | 長さ | なぜ誤マスクされたか |
|---|---|---|
| `file` | 4 | base64 として復号でき中身が印字可能 (`~)^`) だった |
| `responsibilities` | 16 | 長さ条件 (16 以上) に掛かった |
| `internationalization` | 20 | 同上 |

これらは `redaction.py` のコメントが主張していた
「実在メッセージの最長語は `authentication` (14)」「英単語は 4 の倍数長にならないか
復号しても非 ASCII になる」という**一般命題の反証例**でもある。
**判定の根拠を偽るコメントは、次に触る人を誤らせる点で型の嘘と同じ**なので、
本テストは「誤マスクが消えたこと」だけでなく**コメントの主張が真であること**も固定する。
"""

from __future__ import annotations

import base64
import re

import pytest

from src.observability.redaction import (
    MIN_CONSONANT_RUN,
    MIN_OPAQUE_CREDENTIAL_LENGTH,
    REDACTED,
    redact_text,
)

#: 条件を課すスキーム。`Bearer` は無条件マスクなので別扱い (T-F-48 で復元した挙動)。
GUARDED_SCHEMES = ("Basic", "Token", "Digest")

#: qa が検出した誤マスク 3 語。これらは無改変でなければならない。
QA_FALSE_POSITIVES = ("file", "responsibilities", "internationalization")

#: 一般的な英単語コーパス (ログ本文・エラーメッセージに現れうる語)。
ENGLISH_CORPUS = (
    "authentication",
    "authorization",
    "expired",
    "mismatch",
    "signature",
    "disabled",
    "endpoint",
    "usage",
    "invalid",
    "missing",
    "required",
    "configuration",
    "connection",
    "timeout",
    "unavailable",
    "forbidden",
    "conflict",
    "duplicate",
    "rejected",
    "failed",
    "succeeded",
    "pending",
    "processing",
    "cancelled",
    "unknown",
    "internal",
    "gateway",
    "unsupported",
    "malformed",
    "truncated",
    "exceeded",
    "throttled",
    "quota",
    "limit",
    "file",
    "files",
    "directory",
    "database",
    "migration",
    "transaction",
    "rollback",
    "responsibilities",
    "internationalization",
    "implementation",
    "documentation",
    "verification",
    "notification",
    "subscription",
    "authentication",
    "authorization",
)

#: 資格情報の形をしたトークン。T-F-49 で新規保護したものを含む。マスクされ続けること。
CREDENTIAL_TOKENS = (
    "YWRtaWthYWRtaWthYWRt",
    "abcdefghijklmnop",
    "ABCDEFGHIJKLMNOP",
    "dXNlcjpwYXNzd29yZA==",
    "YWRtaW46YWRtaW4=",
    "0123456789abcdef",
    "eyJhbGciOi.JIUzI1",
)


@pytest.mark.unit
class TestQaDetectedFalsePositives:
    """qa が検出した 18 件 (3 語 × 6 スキーム) が解消していること。"""

    @pytest.mark.parametrize("word", QA_FALSE_POSITIVES)
    @pytest.mark.parametrize("scheme", GUARDED_SCHEMES)
    def test_no_longer_masked(self, scheme: str, word: str) -> None:
        message = f"{scheme} {word}"

        assert redact_text(message) == message


@pytest.mark.unit
class TestEnglishCorpus:
    """英単語コーパス全体で誤マスクが 0 件であること。"""

    @pytest.mark.parametrize("word", sorted(set(ENGLISH_CORPUS)))
    @pytest.mark.parametrize("scheme", GUARDED_SCHEMES)
    def test_word_is_untouched(self, scheme: str, word: str) -> None:
        message = f"{scheme} {word}"

        assert redact_text(message) == message

    def test_corpus_false_positive_count_is_zero(self) -> None:
        """件数としても 0 であることを 1 本のテストで示す (qa の 18 件に対応)。"""
        masked = [
            f"{scheme} {word}"
            for scheme in GUARDED_SCHEMES
            for word in sorted(set(ENGLISH_CORPUS))
            if redact_text(f"{scheme} {word}") != f"{scheme} {word}"
        ]

        assert masked == []


@pytest.mark.unit
class TestCredentialsStillMasked:
    """UNWANTED: 誤マスクを減らす過程で T-F-49 の保護を落とさない (退行 0)。"""

    @pytest.mark.parametrize("token", CREDENTIAL_TOKENS)
    @pytest.mark.parametrize("scheme", GUARDED_SCHEMES)
    def test_credential_is_masked(self, scheme: str, token: str) -> None:
        assert redact_text(f"{scheme} {token}") == f"{scheme} {REDACTED}"

    @pytest.mark.parametrize("word", (*QA_FALSE_POSITIVES, "authentication"))
    def test_bearer_remains_unconditional(self, word: str) -> None:
        """tier_3: Bearer は英単語が続いても伏せる (T-F-48 で復元した挙動)。"""
        assert redact_text(f"Bearer {word}") == f"Bearer {REDACTED}"


@pytest.mark.unit
class TestCommentClaimsAreTrue:
    """**コメントに書いた根拠が実際に真であること**を固定する。

    偽の一般命題をコメントに残すと、次に触る人が同じ穴を掘り直す。
    """

    def test_authentication_is_the_longest_word_in_real_messages(self) -> None:
        """「実在メッセージでスキーム語の直後に現れる最長語は authentication (14)」。

        これは**実在メッセージに限定した**主張であって、英単語一般の主張ではない。
        一般命題としては偽であることを次のテストで明示する。
        """
        real_message_words = (
            "signature",
            "expired",
            "is",
            "not",
            "configured",
            "endpoint",
            "usage",
            "authentication",
        )

        assert max(len(w) for w in real_message_words) == len("authentication") == 14
        assert MIN_OPAQUE_CREDENTIAL_LENGTH > 14

    def test_length_threshold_is_not_a_universal_claim(self) -> None:
        """反証: 16 文字以上の英単語は実在する。長さだけでは判別できない。"""
        counterexamples = [w for w in ENGLISH_CORPUS if len(w) >= MIN_OPAQUE_CREDENTIAL_LENGTH]

        assert "responsibilities" in counterexamples
        assert "internationalization" in counterexamples
        # 長さ条件だけなら誤マスクされる → looks_opaque との併用が必要
        for word in counterexamples:
            assert redact_text(f"Basic {word}") == f"Basic {word}"

    def test_english_words_can_decode_as_printable_base64(self) -> None:
        """反証: 「英単語は復号できないか非 ASCII になる」は偽。`file` が反例。"""
        decoded = base64.b64decode("file", validate=True)

        assert all(32 <= byte < 127 for byte in decoded)
        # それでもマスクされない = 長さ下限を併用しているため
        assert redact_text("Basic file") == "Basic file"

    def test_the_conjunction_separates_the_corpus_from_tokens(self) -> None:
        """分離しているのは**長さと子音 run の連言**であることを数値で確認する。

        どちらか片方では分離しない: `subscription` は子音 run 4 (ただし 12 文字)、
        `responsibilities` は 16 文字 (ただし run 2)。両方を満たす英単語がコーパスに
        無いことが、誤マスク 0 の実体である。
        """
        vowels = set("aeiouAEIOU")

        def max_run(word: str) -> int:
            longest = current = 0
            for char in word:
                if char.isalpha() and char not in vowels:
                    current += 1
                    longest = max(longest, current)
                else:
                    current = 0
            return longest

        # 片方だけを満たす語は実在する (= 片方だけでは判別できない)
        assert max_run("subscription") >= MIN_CONSONANT_RUN
        assert len("subscription") < MIN_OPAQUE_CREDENTIAL_LENGTH
        assert len("responsibilities") >= MIN_OPAQUE_CREDENTIAL_LENGTH
        assert max_run("responsibilities") < MIN_CONSONANT_RUN

        # 連言を満たす英単語はコーパスに無い
        both = [
            w
            for w in ENGLISH_CORPUS
            if len(w) >= MIN_OPAQUE_CREDENTIAL_LENGTH and max_run(w) >= MIN_CONSONANT_RUN
        ]
        assert both == []

        # 不透明トークンは連言を満たす
        assert len("abcdefghijklmnop") >= MIN_OPAQUE_CREDENTIAL_LENGTH
        assert max_run("abcdefghijklmnop") >= MIN_CONSONANT_RUN


@pytest.mark.unit
class TestDocumentedResidualLimit:
    """既知の限界がコメントの記述どおりに実在することを固定する (隠さない)。"""

    def test_vowel_interleaved_long_token_is_not_masked(self) -> None:
        """反例として明記した `abababababababab` が実際に素通しすること。"""
        message = "Basic abababababababab"

        assert len("abababababababab") >= MIN_OPAQUE_CREDENTIAL_LENGTH
        assert redact_text(message) == message

    def test_header_form_still_catches_it(self) -> None:
        """取りこぼしがそのまま漏洩にならない — ヘッダ形は key-value 規則が拾う。"""
        out = redact_text("Authorization: Basic abababababababab")

        assert "abababababababab" not in out
        assert REDACTED in out


@pytest.mark.unit
class TestSourceCommentsHaveNoFalseUniversalClaims:
    """ソースのコメントに、偽の一般命題が言い切りで残っていないこと。"""

    def test_module_documents_counterexamples(self) -> None:
        from pathlib import Path

        import src.observability.redaction as redaction_mod

        source = Path(redaction_mod.__file__ or "").read_text(encoding="utf-8")

        # 反証例が明記されていること
        assert "responsibilities" in source
        assert "internationalization" in source
        assert "file" in source
        # 「既知の限界」が節として存在すること
        assert "既知の限界" in source
        assert "abababababababab" in source

    def test_no_universal_claim_about_english_words(self) -> None:
        """『英単語は〜ならない』という言い切りが残っていないこと。"""
        from pathlib import Path

        import src.observability.redaction as redaction_mod

        source = Path(redaction_mod.__file__ or "").read_text(encoding="utf-8")

        # 旧コメントの言い切り表現
        assert "英単語は長さが 4 の倍数にならないか復号しても非 ASCII になる" not in source
        assert re.search(r"英単語は.*必ず", source) is None
