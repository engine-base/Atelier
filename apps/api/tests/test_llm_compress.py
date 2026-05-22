"""Unit tests for apps/api/src/llm/compress.py (T-F-15)."""

# pyright: reportPrivateUsage=false
from __future__ import annotations

import builtins
from typing import Any

import pytest

from src.llm.compress import (
    CompressionResult,
    LLMLinguaCompressor,
    SimpleCompressor,
    _approx_tokens,
    select_compressor,
)


@pytest.mark.unit
class TestApproxTokens:
    def test_empty(self) -> None:
        assert _approx_tokens("") == 0

    def test_whitespace_split(self) -> None:
        assert _approx_tokens("hello world foo") == 3


@pytest.mark.unit
class TestCompressionResult:
    def test_build_basic(self) -> None:
        r = CompressionResult.build("a b c d", "a b")
        assert r.original_tokens == 4
        assert r.compressed_tokens == 2
        assert r.ratio == 0.5

    def test_build_zero_original(self) -> None:
        r = CompressionResult.build("", "")
        assert r.original_tokens == 0
        assert r.ratio == 1.0


@pytest.mark.unit
class TestSimpleCompressor:
    def test_empty_text(self) -> None:
        c = SimpleCompressor()
        r = c.compress("")
        assert r.original_text == ""
        assert r.compressed_text == ""

    def test_invalid_target_ratio(self) -> None:
        c = SimpleCompressor()
        with pytest.raises(ValueError, match="target_ratio"):
            c.compress("hello", target_ratio=0.0)
        with pytest.raises(ValueError, match="target_ratio"):
            c.compress("hello", target_ratio=1.5)

    def test_collapses_whitespace(self) -> None:
        c = SimpleCompressor()
        r = c.compress("hello    world\nhello    world")
        # 連続空白 → 単一、連続重複行 → 1 つ
        assert r.compressed_text == "hello world"

    def test_strips_trailing_whitespace(self) -> None:
        c = SimpleCompressor()
        r = c.compress("line1   \nline2   ")
        assert r.compressed_text == "line1\nline2"

    def test_dedupes_consecutive_identical_lines(self) -> None:
        c = SimpleCompressor()
        r = c.compress("a\na\na\nb")
        assert r.compressed_text == "a\nb"


@pytest.mark.unit
class TestLLMLinguaCompressor:
    def test_import_error_when_not_installed(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        real_import = builtins.__import__

        def fake_import(
            name: str,
            globals_: Any = None,
            locals_: Any = None,
            fromlist: Any = (),
            level: int = 0,
        ) -> Any:
            if name == "llmlingua":
                raise ImportError("not installed")
            return real_import(name, globals_, locals_, fromlist, level)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        with pytest.raises(ImportError, match="llmlingua is not installed"):
            LLMLinguaCompressor()


@pytest.mark.unit
class TestSelectCompressor:
    def test_falls_back_to_simple_when_llmlingua_missing(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        real_import = builtins.__import__

        def fake_import(
            name: str,
            globals_: Any = None,
            locals_: Any = None,
            fromlist: Any = (),
            level: int = 0,
        ) -> Any:
            if name == "llmlingua":
                raise ImportError
            return real_import(name, globals_, locals_, fromlist, level)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        c = select_compressor()
        assert isinstance(c, SimpleCompressor)
