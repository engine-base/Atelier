"""GAP-200: サーバー実行を選んだときに、モデルを**ビルド時**に取り込む。

実行時に落としに行くと:
  - 最初の 1 人だけ数分待たされる (何が起きているか画面から分からない)
  - ディスクや権限で失敗しても「検索の精度が落ちた」としか見えない
  - machine が入れ替わるたびに落とし直す (Fly の auto-stop と相性が悪い)

だから **入れると決めたときは、イメージに焼く**。入れない (既定) なら
このスクリプトはそもそも呼ばれない。

単独実行:
    ATELIER_MODEL_CACHE=/app/.models python apps/api/scripts/prefetch_models.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# apps/api を import path に入れる (src.* を読むため)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

CACHE_ENV = "ATELIER_MODEL_CACHE"


def cache_dir() -> Path:
    raw = (os.environ.get(CACHE_ENV) or "").strip()
    return Path(raw) if raw else Path.cwd() / ".models"


def prefetch_embedding(target: Path) -> tuple[bool, str]:
    """埋め込みモデル (multilingual-e5-large / ONNX) を取り込む。"""
    try:
        from fastembed import TextEmbedding
    except ImportError as exc:
        return False, f"fastembed が入っていません: {exc}"
    try:
        from src.embeddings.local import DEFAULT_MODEL, MODEL_ENV

        name = (os.environ.get(MODEL_ENV) or "").strip() or DEFAULT_MODEL
    except Exception:  # pragma: no cover - import 経路が違う環境向け
        name = "intfloat/multilingual-e5-large"
    try:
        model = TextEmbedding(model_name=name, cache_dir=str(target))
        list(model.embed(["ウォームアップ"]))
    except Exception as exc:
        return False, f"埋め込みモデルの取得に失敗: {type(exc).__name__}: {exc}"
    return True, f"埋め込みモデル {name} を取り込みました"


def prefetch_whisper(target: Path) -> tuple[bool, str]:
    """文字起こしモデル (faster-whisper) を取り込む。"""
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        return False, f"faster-whisper が入っていません: {exc}"
    try:
        from src.services.meetings.stt import DEFAULT_LOCAL_MODEL, LOCAL_MODEL_ENV

        size = (os.environ.get(LOCAL_MODEL_ENV) or "").strip() or DEFAULT_LOCAL_MODEL
    except Exception:  # pragma: no cover - import 経路が違う環境向け
        size = "small"
    try:
        WhisperModel(size, device="cpu", compute_type="int8", download_root=str(target))
    except Exception as exc:
        return False, f"文字起こしモデルの取得に失敗: {type(exc).__name__}: {exc}"
    return True, f"文字起こしモデル {size} を取り込みました"


def main() -> int:
    target = cache_dir()
    target.mkdir(parents=True, exist_ok=True)
    results = [prefetch_embedding(target), prefetch_whisper(target)]
    for ok, message in results:
        print(("OK  " if ok else "NG  ") + message)
    # **1 つでも失敗したらビルドを失敗させる**。
    # 「入れたつもりで入っていない」イメージを本番へ出さないため。
    return 0 if all(ok for ok, _ in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
