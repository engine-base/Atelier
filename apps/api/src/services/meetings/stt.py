"""GAP-181: 議事録の文字起こし経路 (既定 = OSS ローカルの faster-whisper)。

**これまでの実態**: 文字起こしは OpenAI Whisper API (`ATELIER_OPENAI_API_KEY`) 決め打ちで、
- 従量課金 ($0.006/分) が運営負担で発生し、
- **お客様の会議音声そのものが OpenAI に送信され**、
- キーが無ければ議事録機能は丸ごと使えない
状態だった。しかもこのキーは .env.example にも SECRETS.md にも書かれていなかった。

経営者判断 (2026-08-19「2 はその OSS で進めましょう」):
既定を **faster-whisper** (OSS / MIT) に切り替える。OpenAI Whisper と**同じ重み**を
CTranslate2 で動かす実装なので文字起こし精度は同等、費用は 0 円、音声は外部に出ない。
API 経路は削除せず、`ATELIER_ALLOW_WHISPER_API=1` を明示したときだけ使う
(キーがあるだけでは使わない — GAP-178 / GAP-180 と同じ設計)。
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import httpx

logger = logging.getLogger(__name__)

PROVIDER_ENV = "ATELIER_STT_PROVIDER"
ALLOW_API_ENV = "ATELIER_ALLOW_WHISPER_API"
OPENAI_KEY_ENV = "ATELIER_OPENAI_API_KEY"
LOCAL_MODEL_ENV = "ATELIER_LOCAL_WHISPER_MODEL"
API_MODEL_ENV = "ATELIER_WHISPER_MODEL"

#: CPU でも実用的に回り、日本語の会議音声で十分な既定。より高精度にしたい場合は
#: ATELIER_LOCAL_WHISPER_MODEL=medium / large-v3 に上げる (遅くなる)。
DEFAULT_LOCAL_MODEL = "small"
DEFAULT_API_MODEL = "whisper-1"

WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions"

STTProvider = Literal["local", "openai", "none"]
STTState = Literal["ready", "unavailable"]

_lock = threading.Lock()
_model_cache: dict[str, Any] = {}


class STTUnavailable(Exception):
    """文字起こしができない。code は監査・再試行判定に使う。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class STTRoute:
    provider: STTProvider
    state: STTState
    reason: str
    payer: str
    model: str | None
    next_steps: list[str] = field(default_factory=list[str])
    warnings: list[str] = field(default_factory=list[str])


def faster_whisper_available() -> bool:
    """faster-whisper が入っているか (optional dep — 未導入なら誠実に使えないと言う)。"""
    try:
        import faster_whisper  # noqa: F401  # pyright: ignore[reportMissingImports]
    except Exception:
        return False
    return True


def local_model_name(env: dict[str, str] | None = None) -> str:
    src = env if env is not None else dict(os.environ)
    return (src.get(LOCAL_MODEL_ENV) or "").strip() or DEFAULT_LOCAL_MODEL


def whisper_api_allowed(env: dict[str, str] | None = None) -> bool:
    """OpenAI Whisper API を使ってよいか。**明示的な opt-in がある場合のみ**。"""
    src = env if env is not None else dict(os.environ)
    return (src.get(ALLOW_API_ENV) or "").strip() == "1" and bool(
        (src.get(OPENAI_KEY_ENV) or "").strip()
    )


def resolve_stt_route(env: dict[str, str] | None = None) -> STTRoute:
    """文字起こしが今どの経路で動くかを返す。"""
    src = env if env is not None else dict(os.environ)
    warnings: list[str] = []
    requested = (src.get(PROVIDER_ENV) or "").strip().lower()
    has_key = bool((src.get(OPENAI_KEY_ENV) or "").strip())
    opt_in = (src.get(ALLOW_API_ENV) or "").strip() == "1"

    if has_key and not opt_in:
        warnings.append(
            f"{OPENAI_KEY_ENV} は設定されていますが、明示 opt-in ({ALLOW_API_ENV}=1) が"
            "無いため使用しません (課金しません / 音声を外部に送りません)"
        )
    if requested in ("openai", "api", "whisper") and not opt_in:
        warnings.append(
            f"{PROVIDER_ENV}={requested} が指定されていますが {ALLOW_API_ENV}=1 が無いため"
            "ローカル (faster-whisper) で処理します"
        )

    if requested in ("openai", "api", "whisper") and whisper_api_allowed(src):
        return STTRoute(
            provider="openai",
            state="ready",
            reason="OpenAI Whisper API で文字起こしします (明示的に有効化されています)",
            payer="運営負担 ($0.006/分) — 音声が OpenAI へ送信されます",
            model=(src.get(API_MODEL_ENV) or "").strip() or DEFAULT_API_MODEL,
            warnings=warnings,
        )

    model = local_model_name(src)
    if not faster_whisper_available():
        return STTRoute(
            provider="none",
            state="unavailable",
            reason="文字起こしの部品 (faster-whisper) がこのサーバーに入っていません",
            payer="費用なし",
            model=None,
            next_steps=[
                "サーバーで `uv sync --extra localrag` を実行して faster-whisper を導入する",
                f"どうしても外部 API を使う場合は {ALLOW_API_ENV}=1 と {OPENAI_KEY_ENV} を設定する"
                " (運営に従量課金が発生し、音声が OpenAI へ送信されます)",
            ],
            warnings=warnings,
        )
    return STTRoute(
        provider="local",
        state="ready",
        reason=f"このサーバー内の faster-whisper ({model}) で文字起こしします",
        payer="費用なし (音声は外部に出ません)",
        model=model,
        warnings=warnings,
    )


def describe_stt_route(env: dict[str, str] | None = None) -> str:
    route = resolve_stt_route(env)
    base = f"stt route={route.provider} state={route.state} model={route.model} payer={route.payer}"
    return base + ("｜" + " / ".join(route.warnings) if route.warnings else "")


# --------------------------------------------------------------------------- #
# ローカル (faster-whisper)
# --------------------------------------------------------------------------- #


def _get_model(name: str) -> Any:
    """モデルを 1 度だけロードして使い回す (毎回ロードすると分単位で遅い)。"""
    with _lock:
        cached = _model_cache.get(name)
        if cached is not None:
            return cached
    from faster_whisper import (  # pyright: ignore[reportMissingImports]
        WhisperModel,
    )

    # CPU + int8: Fly.io の標準インスタンスでも動く構成。GPU がある環境では
    # ATELIER_LOCAL_WHISPER_DEVICE=cuda で切り替えられる。
    device = (os.environ.get("ATELIER_LOCAL_WHISPER_DEVICE") or "cpu").strip()
    compute = (os.environ.get("ATELIER_LOCAL_WHISPER_COMPUTE") or "").strip() or (
        "float16" if device == "cuda" else "int8"
    )
    model = WhisperModel(name, device=device, compute_type=compute)
    with _lock:
        _model_cache[name] = model
    return model


def _transcribe_local_sync(media_path: str, *, model_name: str) -> dict[str, Any]:
    model = _get_model(model_name)
    segments, info = model.transcribe(media_path, vad_filter=True, beam_size=5)
    out_segments: list[dict[str, Any]] = []
    for i, seg in enumerate(segments):
        out_segments.append(
            {
                "id": i,
                "start": float(seg.start),
                "end": float(seg.end),
                "text": str(seg.text).strip(),
            }
        )
    text = "".join(s["text"] for s in out_segments).strip()
    return {
        "text": text,
        "segments": out_segments,
        "language": str(getattr(info, "language", "") or ""),
        "duration": float(getattr(info, "duration", 0.0) or 0.0),
        "provider": "local",
        "model": model_name,
    }


async def _transcribe_local(media: bytes, *, file_name: str, model_name: str) -> dict[str, Any]:
    suffix = Path(file_name).suffix or ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(media)
        tmp_path = tmp.name
    try:
        return await asyncio.to_thread(_transcribe_local_sync, tmp_path, model_name=model_name)
    except Exception as exc:  # モデル DL 失敗 / 破損音声など
        raise STTUnavailable("local_transcribe_failed", f"faster-whisper 失敗: {exc}") from exc
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# --------------------------------------------------------------------------- #
# OpenAI Whisper API (明示 opt-in 時のみ)
# --------------------------------------------------------------------------- #


async def _transcribe_openai(
    media: bytes, *, file_name: str, mime_type: str, model: str
) -> dict[str, Any]:
    api_key = (os.environ.get(OPENAI_KEY_ENV) or "").strip()
    async with httpx.AsyncClient(timeout=600.0) as client:
        r = await client.post(
            WHISPER_API_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (file_name, media, mime_type)},
            data={"model": model, "response_format": "verbose_json"},
        )
    if r.status_code >= 400:
        raise STTUnavailable(
            "whisper_failed", f"whisper api failed: {r.status_code} {r.text[:200]}"
        )
    body: dict[str, Any] = r.json()
    body["provider"] = "openai"
    body["model"] = model
    return body


async def transcribe(media: bytes, *, file_name: str, mime_type: str) -> dict[str, Any]:
    """音声/動画を文字起こしする。返り値は verbose_json 互換 + provider/model。

    使えないときは黙って空文字を返さず STTUnavailable を上げる (偽の成功を作らない)。
    """
    route = resolve_stt_route()
    if route.provider == "none" or route.model is None:
        raise STTUnavailable("stt_unavailable", route.reason)
    if route.provider == "openai":
        return await _transcribe_openai(
            media, file_name=file_name, mime_type=mime_type, model=route.model
        )
    return await _transcribe_local(media, file_name=file_name, model_name=route.model)


__all__ = [
    "ALLOW_API_ENV",
    "DEFAULT_LOCAL_MODEL",
    "OPENAI_KEY_ENV",
    "PROVIDER_ENV",
    "STTRoute",
    "STTUnavailable",
    "describe_stt_route",
    "faster_whisper_available",
    "local_model_name",
    "resolve_stt_route",
    "transcribe",
    "whisper_api_allowed",
]
