"""GAP-180: 埋め込み (意味検索) の実行経路を 1 箇所で決める。

**これまでの実態**: `VOYAGE_API_KEY` が環境変数に「あるだけ」で Voyage
(従量課金・運営負担・本文が外部へ送信される) が使われる作りだった。GAP-178 で
LLM 側は「env を消さないと使われる」設計をやめたのに、埋め込みは同じ問題を
残していた。また、ローカル埋め込みが未準備 (モデル未 DL) のときに何が起きて
いるのかを画面から確認する手段が無く、利用者には「検索の精度が落ちている」
理由が見えなかった。

方針 (経営者判断 2026-08-19):
- 既定は **ローカル埋め込み**。利用者にもサーバー費用にも課金が発生しない。
- Voyage は **今は使わない**。ただし将来使う可能性があるので削除はせず、
  `ATELIER_ALLOW_VOYAGE=1` を明示したときだけ有効になる (キーがあるだけでは
  絶対に使わない)。
- どちらも使えないときは黙って劣化させず、「キーワード一致のみ」であることと
  復旧手順を画面に出す。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Literal

#: Voyage を実際に使うための明示スイッチ。キーの有無だけでは有効にならない。
ALLOW_VOYAGE_ENV = "ATELIER_ALLOW_VOYAGE"
VOYAGE_KEY_ENV = "VOYAGE_API_KEY"

EmbeddingProvider = Literal["local", "voyage", "none"]
#: ready = すぐ使える / preparing = 準備中 (モデル DL 中など) / unavailable = 使えない
EmbeddingState = Literal["ready", "preparing", "unavailable"]


@dataclass(frozen=True)
class EmbeddingRoute:
    provider: EmbeddingProvider
    state: EmbeddingState
    #: 画面に出す 1 行説明
    reason: str
    #: 誰の費用か
    payer: str
    #: 現在のモデル空間タグ (埋め込みと必ず対で扱う)
    model_tag: str | None
    #: 復旧・準備のために利用者/運営がやること (無ければ空)
    next_steps: list[str] = field(default_factory=list[str])
    warnings: list[str] = field(default_factory=list[str])

    @property
    def semantic_enabled(self) -> bool:
        return self.provider != "none" and self.state == "ready"


def voyage_allowed(env: dict[str, str] | None = None) -> bool:
    """Voyage を使ってよいか。**明示的な opt-in がある場合のみ True**。"""
    src = env if env is not None else dict(os.environ)
    allowed = (src.get(ALLOW_VOYAGE_ENV) or "").strip() == "1"
    has_key = bool((src.get(VOYAGE_KEY_ENV) or "").strip())
    return allowed and has_key


def resolve_embedding_route(env: dict[str, str] | None = None) -> EmbeddingRoute:
    """今この瞬間、意味検索が何で動いているかを返す。"""
    src = env if env is not None else dict(os.environ)
    from src.embeddings import local as local_emb

    warnings: list[str] = []
    has_voyage_key = bool((src.get(VOYAGE_KEY_ENV) or "").strip())
    voyage_opt_in = (src.get(ALLOW_VOYAGE_ENV) or "").strip() == "1"

    if voyage_opt_in and not has_voyage_key:
        warnings.append(
            f"{ALLOW_VOYAGE_ENV}=1 が設定されていますが {VOYAGE_KEY_ENV} がありません "
            "(ローカル埋め込みで動作します)"
        )
    if has_voyage_key and not voyage_opt_in:
        warnings.append(
            f"{VOYAGE_KEY_ENV} は設定されていますが、明示 opt-in "
            f"({ALLOW_VOYAGE_ENV}=1) が無いため使用しません (課金しません)"
        )

    if voyage_allowed(src):
        return EmbeddingRoute(
            provider="voyage",
            state="ready",
            reason="Voyage AI で意味検索を行います (明示的に有効化されています)",
            payer="運営負担 (Voyage の従量課金)",
            model_tag="voyage-3-large",
            warnings=warnings,
        )

    if not local_emb.local_embedding_enabled(src):
        return EmbeddingRoute(
            provider="none",
            state="unavailable",
            reason="ローカル埋め込みが明示的に無効化されています (キーワード一致のみ)",
            payer="費用なし",
            model_tag=None,
            next_steps=[f"{local_emb.ENABLE_ENV} の設定 (0) を外すと意味検索が戻ります"],
            warnings=warnings,
        )

    if not local_emb.local_available():
        return EmbeddingRoute(
            provider="none",
            state="unavailable",
            reason="意味検索の部品 (fastembed) がこのサーバーに入っていません (キーワード一致のみ)",
            payer="費用なし",
            model_tag=None,
            next_steps=[
                "サーバーで `uv sync` を実行して fastembed を導入する",
                "導入後は API 再起動でモデルの準備が自動で始まります",
            ],
            warnings=warnings,
        )

    model = local_emb.local_embedding_model(src)
    if not local_emb.is_ready():
        return EmbeddingRoute(
            provider="local",
            state="preparing",
            reason=(
                f"ローカルモデル ({model}) を準備中です。"
                "完了するまでは キーワード一致で検索し、完了後に自動で埋め込みを補完します"
            ),
            payer="費用なし (このサーバー内で計算)",
            model_tag=local_emb.local_model_tag(src),
            next_steps=[
                "初回のみモデルのダウンロードに数分かかります",
                "「今すぐ準備する」で手動開始・再試行もできます",
            ],
            warnings=warnings,
        )

    return EmbeddingRoute(
        provider="local",
        state="ready",
        reason=f"ローカルモデル ({model}) で意味検索を行います",
        payer="費用なし (このサーバー内で計算)",
        model_tag=local_emb.local_model_tag(src),
        warnings=warnings,
    )


def describe_embedding_route(env: dict[str, str] | None = None) -> str:
    """起動ログ用の 1 行要約。"""
    route = resolve_embedding_route(env)
    base = f"embedding route={route.provider} state={route.state} payer={route.payer}"
    return base + ("｜" + " / ".join(route.warnings) if route.warnings else "")


__all__ = [
    "ALLOW_VOYAGE_ENV",
    "VOYAGE_KEY_ENV",
    "EmbeddingRoute",
    "describe_embedding_route",
    "resolve_embedding_route",
    "voyage_allowed",
]
