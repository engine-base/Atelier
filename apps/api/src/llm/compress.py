# pyright: reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownLambdaType=false
"""LLMLingua プロンプト圧縮ラッパ (T-F-15)。

LLMLingua-2 (microsoft/LLMLingua) は long context を 20× まで圧縮しつつ
タスク性能を維持する手法。Atelier では RAG context や議事録要約の前処理に使う。

参照:
- https://github.com/microsoft/LLMLingua
- LLMLingua-2: BERT classifier ベースの token-level pruning

設計方針:
- llmlingua パッケージは torch + transformers 依存で重い。本モジュールは
  Protocol で interface を切り、実体は遅延 import + 失敗時 fallback (no-op)。
- 単純なヒューリスティック fallback (`SimpleCompressor`) も提供。テスト環境
  および LLMLingua 未インストール環境で動作させる。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class CompressionResult:
    """圧縮結果。original / compressed と比率を保持。"""

    original_text: str
    compressed_text: str
    original_tokens: int
    """approximate token 数 (whitespace split による粗い見積)。"""
    compressed_tokens: int
    ratio: float
    """compressed / original。1.0 = 無圧縮、0.5 = 半分。"""

    @classmethod
    def build(cls, original: str, compressed: str) -> CompressionResult:
        orig_tokens = _approx_tokens(original)
        comp_tokens = _approx_tokens(compressed)
        ratio = comp_tokens / orig_tokens if orig_tokens > 0 else 1.0
        return cls(
            original_text=original,
            compressed_text=compressed,
            original_tokens=orig_tokens,
            compressed_tokens=comp_tokens,
            ratio=ratio,
        )


class Compressor(Protocol):
    """圧縮器の interface。target_ratio に近づけて返す。"""

    def compress(self, text: str, *, target_ratio: float = 0.5) -> CompressionResult: ...


class SimpleCompressor:
    """ヒューリスティック fallback。重複/whitespace のみ畳む安全な実装。

    LLMLingua 未インストール環境のためのデフォルト。target_ratio はベスト
    エフォートでヒットさせるが、保証はしない (情報損失を避けるため)。
    """

    def compress(
        self,
        text: str,
        *,
        target_ratio: float = 0.5,
    ) -> CompressionResult:
        if not text:
            return CompressionResult.build("", "")
        if not 0.0 < target_ratio <= 1.0:
            raise ValueError(
                f"target_ratio must be in (0, 1], got {target_ratio}",
            )
        # 1) 連続空白 → 単一空白、2) 連続改行 → 単一改行、3) 行末空白除去
        lines = [line.rstrip() for line in text.split("\n")]
        deduped: list[str] = []
        prev = ""
        for line in lines:
            collapsed = " ".join(line.split())
            if collapsed == prev:
                continue
            deduped.append(collapsed)
            prev = collapsed
        compressed = "\n".join(deduped).strip()
        return CompressionResult.build(text, compressed)


class LLMLinguaCompressor:
    """LLMLingua-2 backend。遅延 import で torch/transformers を回避。

    インストールされていない場合は ImportError を init で raise する。
    呼び出し側は try/except でフォールバック (SimpleCompressor) に切り替える。
    """

    def __init__(
        self, *, model_name: str = "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank"
    ) -> None:
        try:
            from llmlingua import PromptCompressor  # type: ignore[import-not-found]
        except ImportError as exc:
            raise ImportError(
                "llmlingua is not installed. Install with `uv add llmlingua` "
                "or use SimpleCompressor as a fallback.",
            ) from exc
        self._impl: object = PromptCompressor(model_name=model_name, use_llmlingua2=True)

    def compress(
        self,
        text: str,
        *,
        target_ratio: float = 0.5,
    ) -> CompressionResult:
        if not text:
            return CompressionResult.build("", "")
        if not 0.0 < target_ratio <= 1.0:
            raise ValueError(
                f"target_ratio must be in (0, 1], got {target_ratio}",
            )
        # LLMLingua API: compress_prompt(text, rate=...)
        result: object = self._impl.compress_prompt(  # type: ignore[attr-defined]
            text,
            rate=target_ratio,
        )
        compressed_text: str = getattr(result, "get", lambda *_: None)("compressed_prompt") or str(
            result
        )
        return CompressionResult.build(text, compressed_text)


def select_compressor() -> Compressor:
    """環境に応じて LLMLingua / Simple を自動選択する factory。"""
    try:
        return LLMLinguaCompressor()
    except ImportError:
        return SimpleCompressor()


def _approx_tokens(text: str) -> int:
    """whitespace split による粗い token 数推定。

    実際の token は tokenizer 依存だが、SimpleCompressor の比率算出には十分。
    """
    return len(text.split()) if text else 0


__all__ = [
    "CompressionResult",
    "Compressor",
    "LLMLinguaCompressor",
    "SimpleCompressor",
    "select_compressor",
]
