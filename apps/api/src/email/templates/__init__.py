"""Email テンプレート (HTML build 済) を import する層。

React Email でビルドした HTML を packages/email/dist から読む方針。
ここでは template name → ビルド済 HTML パス の解決ヘルパだけ提供する。
"""

from __future__ import annotations

from pathlib import Path

_TEMPLATE_DIR = Path(__file__).resolve().parents[4] / "packages" / "email" / "dist"


def resolve_template_html(name: str) -> str:
    """テンプレート名 (e.g. 'welcome') からビルド済 HTML 文字列を返す。

    React Email がまだビルドされていない場合は FileNotFoundError を投げる。
    """
    candidate = _TEMPLATE_DIR / f"{name}.html"
    if not candidate.is_file():
        raise FileNotFoundError(
            f"email template '{name}' not built. "
            f"Run `pnpm --filter @atelier/email build` first. "
            f"Expected: {candidate}"
        )
    return candidate.read_text(encoding="utf-8")
