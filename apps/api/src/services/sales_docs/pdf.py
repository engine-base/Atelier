# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportMissingTypeStubs=false
"""S-N01 ドラフトの PDF 出力 (GAP-018 — モックの「PDF」ボタンの実体)。

reportlab の内蔵 CID フォント (HeiseiKakuGo-W5) で日本語を実描画する。
summary (Markdown テキスト) を簡易レイアウト (見出し/本文) で流し込む。
"""

from __future__ import annotations

import io

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

_FONT = "HeiseiKakuGo-W5"
_MARGIN = 56
_BODY_SIZE = 10.5
_LINE_HEIGHT = 16


def _ensure_font() -> None:
    if _FONT not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(UnicodeCIDFont(_FONT))


def _wrap(line: str, width_chars: int) -> list[str]:
    if not line:
        return [""]
    return [line[i : i + width_chars] for i in range(0, len(line), width_chars)]


def render_pdf(*, title: str, meta_line: str, body: str) -> bytes:
    """ドラフト本文を A4 PDF に描画して bytes を返す。"""
    _ensure_font()
    buf = io.BytesIO()
    page_w, page_h = A4
    c = canvas.Canvas(buf, pagesize=A4)
    c.setTitle(title)

    y = page_h - _MARGIN

    def new_page() -> None:
        nonlocal y
        c.showPage()
        y = page_h - _MARGIN

    def draw(text_line: str, *, size: float, gap: float) -> None:
        nonlocal y
        if y < _MARGIN + gap:
            new_page()
        c.setFont(_FONT, size)
        c.drawString(_MARGIN, y, text_line)
        y -= gap

    # タイトル + メタ
    for chunk in _wrap(title, 26):
        draw(chunk, size=16, gap=24)
    draw(meta_line, size=9, gap=14)
    y -= 8
    c.line(_MARGIN, y, page_w - _MARGIN, y)
    y -= 18

    # 本文 (Markdown を簡易解釈: 見出しは太めサイズ、それ以外は本文)
    width_chars = int((page_w - _MARGIN * 2) / _BODY_SIZE)
    for raw in body.splitlines():
        line = raw.rstrip()
        if line.startswith("## "):
            y -= 6
            for chunk in _wrap(line[3:], 30):
                draw(chunk, size=13, gap=20)
        elif line.startswith("# "):
            y -= 6
            for chunk in _wrap(line[2:], 26):
                draw(chunk, size=15, gap=22)
        elif line.startswith("- "):
            for j, chunk in enumerate(_wrap(line[2:], width_chars - 2)):
                draw(("・" if j == 0 else "  ") + chunk, size=_BODY_SIZE, gap=_LINE_HEIGHT)
        else:
            for chunk in _wrap(line, width_chars):
                draw(chunk, size=_BODY_SIZE, gap=_LINE_HEIGHT)

    c.save()
    return buf.getvalue()
