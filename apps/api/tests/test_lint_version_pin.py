"""commit 時と CI で同じ ruff を使う (GAP-221)。

`.lintstagedrc.json` はバージョンを指定せずに `uv tool run ruff` を呼んでいた。
CI は `ruff==0.8.4` を固定している。整形の規則はバージョンで変わるので、
**commit のたびに片方が直し、CI がもう一方に直せと言う**状態になっていた。
実際 `apps/api/tests/rls/t-i-0{7,8}.py` が両者で食い違い、Gate #1 が落ちていた。

道具のバージョンがズレた門は、コードの良し悪しではなく**環境の差**で落ちる。
落ち続ける門は読まれなくなるので、ここで固定する。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def _ci_pin() -> str:
    text = (ROOT / ".github/workflows/v3-gate.yml").read_text(encoding="utf-8")
    m = re.search(r"ruff==(\d+\.\d+\.\d+)", text)
    assert m, "v3-gate.yml に ruff のバージョン固定が見当たらない"
    return m.group(1)


def _lintstaged_pins() -> list[str]:
    cfg = json.loads((ROOT / ".lintstagedrc.json").read_text(encoding="utf-8"))
    out: list[str] = []
    for commands in cfg.values():
        for cmd in commands:
            m = re.search(r"ruff@(\d+\.\d+\.\d+)", cmd)
            if "ruff" in cmd:
                assert m, f"ruff のバージョンが固定されていない: {cmd}"
                out.append(m.group(1))
    return out


def test_commit時とCIで同じruffを使う() -> None:
    pins = _lintstaged_pins()
    assert pins, ".lintstagedrc.json に ruff の呼び出しが無い"
    ci = _ci_pin()
    assert set(pins) == {ci}, f"lint-staged {sorted(set(pins))} と CI {ci} が違う"
