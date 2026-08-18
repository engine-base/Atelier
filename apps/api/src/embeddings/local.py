"""GAP-133: ローカル埋め込み (fastembed / ONNX — 課金ゼロの意味検索)。

Anthropic (Claude) には埋め込み API が無いため、サブスクで代替できない
唯一の部品が埋め込みだった。本モジュールは Voyage (従量課金) の代わりに
**実行ホスト上のローカルモデル**で埋め込みを生成する。

方針 (経営者すり合わせ済「ローカルでできてユーザー負担が無いならそちら」):
- 既定モデル: intfloat/multilingual-e5-large (1024 次元 = 既存 pgvector
  スキーマにそのまま適合。日本語実用水準。初回のみ約 2.2GB を自動 DL)
- 低スペック機向け: ATELIER_LOCAL_EMBEDDING_MODEL で軽量モデルに切替可
  (例: sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 = 0.22GB /
  384 次元)。1024 次元未満はゼロパディングで格納する — 同一モデル同士の
  cosine 順位はパディングで不変 (数学的に同値) なので検索品質は落ちない。
  1024 次元超のモデルは切り詰めが順位を壊すため**拒否**する (誠実設計)。
- モデルが違えばベクトル空間が違う: 埋め込みには必ずモデルタグを付与し、
  検索は同一タグの行だけを対象にする (knowledge_nodes.embedding_model)。
  モデル切替後は scripts/reembed_knowledge.py で全件再埋め込みする。
- 無効化: ATELIER_LOCAL_EMBEDDING="0" (Voyage 未設定なら ilike に戻る)。
- 企業プロキシ等: ATELIER_CA_BUNDLE で モデル DL の CA バンドルを指定可。

fastembed は optional dep (未導入環境では import 失敗 → 利用不可として
誠実に degrade)。埋め込みは CPU 拘束のため asyncio.to_thread で回す。
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from typing import Any

logger = logging.getLogger(__name__)

ENABLE_ENV = "ATELIER_LOCAL_EMBEDDING"
MODEL_ENV = "ATELIER_LOCAL_EMBEDDING_MODEL"
CA_ENV = "ATELIER_CA_BUNDLE"

DEFAULT_MODEL = "intfloat/multilingual-e5-large"

# 既存スキーマ (voyage_embedding domain = vector(1024)) に合わせる
TARGET_DIMENSIONS = 1024

_lock = threading.Lock()
_model_cache: dict[str, Any] = {}


def local_embedding_enabled(env: dict[str, str] | None = None) -> bool:
    """既定 ON。ATELIER_LOCAL_EMBEDDING="0" で明示 OFF。"""
    e = env if env is not None else dict(os.environ)
    return (e.get(ENABLE_ENV) or "").strip() != "0"


def local_embedding_model(env: dict[str, str] | None = None) -> str:
    e = env if env is not None else dict(os.environ)
    return (e.get(MODEL_ENV) or "").strip() or DEFAULT_MODEL


def local_model_tag(env: dict[str, str] | None = None) -> str:
    """embedding_model 列に入れるタグ (モデル空間の識別子)。"""
    return f"local:{local_embedding_model(env)}"


def fastembed_available() -> bool:
    try:
        import fastembed  # noqa: F401  # pyright: ignore[reportMissingImports,reportUnusedImport]
    except Exception:
        return False
    return True


def local_available() -> bool:
    """ローカル埋め込みが使える状態か (有効 + fastembed 導入済)。"""
    return local_embedding_enabled() and fastembed_available()


def pad_to_target(vec: list[float]) -> list[float]:
    """1024 次元へゼロパディング (cosine 順位不変)。超過は誠実に拒否。"""
    if len(vec) > TARGET_DIMENSIONS:
        raise ValueError(
            f"embedding model dimension {len(vec)} exceeds storage dimension "
            f"{TARGET_DIMENSIONS} — このモデルは使えません (切り詰めは検索順位を壊すため拒否)"
        )
    if len(vec) < TARGET_DIMENSIONS:
        return list(vec) + [0.0] * (TARGET_DIMENSIONS - len(vec))
    return list(vec)


def _configure_hub_ca() -> None:
    """ATELIER_CA_BUNDLE 指定時、モデル DL の HTTP クライアントに CA を設定する。

    企業プロキシ (TLS 再終端) 環境で huggingface からの初回 DL を通すための
    正式な設定口。未指定なら何もしない。
    """
    ca = (os.environ.get(CA_ENV) or "").strip()
    if not ca:
        return
    # xet ネイティブダウンローダ (Rust) はここで設定する CA を読まないため、
    # カスタム CA 環境では従来の HTTP ダウンロード経路に固定する。
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    try:
        import httpx  # pyright: ignore[reportMissingImports]
        import huggingface_hub  # pyright: ignore[reportMissingImports]

        def _client() -> Any:
            return httpx.Client(verify=ca, follow_redirects=True, timeout=None)

        if hasattr(huggingface_hub, "set_client_factory"):  # hub >= 1.0 (httpx)
            huggingface_hub.set_client_factory(_client)
            if hasattr(huggingface_hub, "set_async_client_factory"):
                huggingface_hub.set_async_client_factory(
                    lambda: httpx.AsyncClient(verify=ca, follow_redirects=True, timeout=None)
                )
        else:  # hub 0.x (requests)
            huggingface_hub.configure_http_backend(backend_factory=_client)
    except Exception as exc:  # 設定失敗は DL 時の素のエラーに任せる
        logger.warning("ATELIER_CA_BUNDLE の適用に失敗: %s", exc)


def _get_model(name: str) -> Any:
    """TextEmbedding をプロセス内キャッシュ (初回はモデル DL が走る)。"""
    with _lock:
        model = _model_cache.get(name)
        if model is None:
            _configure_hub_ca()
            from fastembed import TextEmbedding  # pyright: ignore[reportMissingImports]

            logger.info("local embedding model loading: %s (初回はダウンロードが走ります)", name)
            model = TextEmbedding(name)
            _model_cache[name] = model
        return model


def _embed_sync(texts: list[str], *, is_query: bool) -> list[list[float]]:
    model = _get_model(local_embedding_model())
    if is_query:
        raw = list(model.query_embed(texts))
    else:
        # e5 系は passage prefix が推奨 — fastembed の passage_embed が面倒を見る
        raw = (
            list(model.passage_embed(texts))
            if hasattr(model, "passage_embed")
            else list(model.embed(texts))
        )
    return [pad_to_target([float(x) for x in v]) for v in raw]


async def embed_documents(texts: list[str]) -> list[list[float]]:
    """文書側の埋め込み (1024 次元パディング済)。CPU 拘束なので別スレッド。"""
    return await asyncio.to_thread(_embed_sync, texts, is_query=False)


async def embed_query(query: str) -> list[float]:
    """検索クエリ側の埋め込み (1024 次元パディング済)。"""
    result = await asyncio.to_thread(_embed_sync, [query], is_query=True)
    return result[0]
