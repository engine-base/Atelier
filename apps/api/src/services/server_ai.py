"""GAP-200: 「意味検索・文字起こしをサーバーで動かすか」を 1 箇所で答える。

**これまでの実態**: 本番 Docker イメージに `--extra localrag` を入れていない
ので fastembed / faster-whisper が**そもそも入っていない**。それなのに
画面には「ローカル埋め込み」「このサーバー内の faster-whisper」と出るコードが
あり、実際には動かない (= 検索は文字一致に落ち、文字起こしは利用者の PC 頼み)。

**この GAP でやること**: 「入っているか」を推測せず **実際に import して確かめ**、
入っていないなら**入っていないと表示する**。そして「入れる」という選択を
安全に取れるようにする (Dockerfile の `INSTALL_LOCALRAG` / deploy の `server_ai`)。

**方針 (費用の話)**: 既定は **入れない**。
  - モデルを同梱するとイメージが **約 2.6GB** 増える (実測: 埋め込み 2.1GB /
    whisper-small 464MB)。
  - 動かすには VM を 1GB 以上 (推奨 2GB) へ上げる必要がある
    (実測メモリ: 埋め込み 652MB〜1,554MB / whisper 302MB〜1,007MB)。
  - Fly.io の料金表では 256MB $2.02/月 → 2GB $11.11/月。**運営費用が約 5 倍**。
  - 一方、利用者の PC (Bridge) で動かせば運営費用は 0 円。
  → だから「入れられるようにする」が正解で、「既定で入れる」は正解ではない。
"""

from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass

#: イメージが localrag 同梱でビルドされたか (Dockerfile が ENV で埋める)。
BUNDLED_ENV = "ATELIER_SERVER_AI_BUNDLED"
#: 取り込んだモデルの置き場 (Dockerfile が ENV で埋める)。
MODEL_CACHE_ENV = "ATELIER_MODEL_CACHE"

#: イメージ肥大の実測値 (docs と画面で同じ数字を使う)。
IMAGE_SIZE_NOTE = "埋め込み 2.1GB + whisper-small 464MB ≒ 約 2.6GB"
#: 必要メモリの実測値。
MEMORY_NOTE = "埋め込み 652MB〜1,554MB / whisper 302MB〜1,007MB (VM は 1GB 以上、推奨 2GB)"


@dataclass(frozen=True)
class ServerAiStatus:
    """サーバー側で AI を動かせるかの実態。**推測しない**。"""

    #: ビルド時に同梱すると宣言されていたか
    declared: bool
    #: 実際に埋め込みライブラリが import できるか
    embedding_installed: bool
    #: 実際に文字起こしライブラリが import できるか
    transcribe_installed: bool
    #: 取り込んだモデルの置き場 (未設定なら None)
    model_cache: str | None

    @property
    def usable(self) -> bool:
        return self.embedding_installed or self.transcribe_installed

    @property
    def mismatch(self) -> bool:
        """「入れたつもりで入っていない」状態か。**一番見つけたい状態**。"""
        return self.declared and not (self.embedding_installed and self.transcribe_installed)


def _installed(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):  # pragma: no cover - 壊れた環境のみ
        return False


def server_ai_status(env: dict[str, str] | None = None) -> ServerAiStatus:
    src = env if env is not None else dict(os.environ)
    cache = (src.get(MODEL_CACHE_ENV) or "").strip()
    return ServerAiStatus(
        declared=(src.get(BUNDLED_ENV) or "").strip() == "1",
        embedding_installed=_installed("fastembed"),
        transcribe_installed=_installed("faster_whisper"),
        model_cache=cache or None,
    )


def describe_server_ai(status: ServerAiStatus | None = None) -> tuple[str, str, str]:
    """(状態, 説明, 次にやること) を返す。画面と起動ログで同じ文言を使う。

    状態は "ok" / "warn" / "off"。**動いていないのに動いているように書かない**。
    """
    st = status or server_ai_status()
    if st.mismatch:
        missing: list[str] = []
        if not st.embedding_installed:
            missing.append("意味検索 (fastembed)")
        if not st.transcribe_installed:
            missing.append("文字起こし (faster-whisper)")
        return (
            "warn",
            "サーバー実行が有効と宣言されていますが、実際には "
            + " / ".join(missing)
            + " が入っていません",
            "deploy を server_ai=true でやり直してください "
            "(イメージのビルドに失敗している可能性があります)",
        )
    if st.usable:
        parts: list[str] = []
        if st.embedding_installed:
            parts.append("意味検索")
        if st.transcribe_installed:
            parts.append("文字起こし")
        return (
            "ok",
            "このサーバーで " + " / ".join(parts) + " を実行します (運営の費用)",
            "",
        )
    return (
        "off",
        "サーバーでは実行しません (意味検索は文字一致、文字起こしは利用者の PC)。"
        f"運営費用は増えません。同梱すると {IMAGE_SIZE_NOTE}",
        f"サーバーで動かすなら: fly.toml の memory を 2048mb へ上げ、deploy を "
        f"server_ai=true で実行 ({MEMORY_NOTE})",
    )


__all__ = [
    "BUNDLED_ENV",
    "IMAGE_SIZE_NOTE",
    "MEMORY_NOTE",
    "MODEL_CACHE_ENV",
    "ServerAiStatus",
    "describe_server_ai",
    "server_ai_status",
]
