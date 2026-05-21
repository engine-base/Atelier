"""Unit tests for apps/api/src/email/templates/__init__.py.

resolve_template_html の path 解決と FileNotFoundError を検証。
Coverage target: >= 80%.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.email.templates import resolve_template_html


@pytest.mark.unit
class TestResolveTemplateHtml:
    def test_raises_when_template_not_built(self) -> None:
        with pytest.raises(FileNotFoundError, match="welcome"):
            resolve_template_html("welcome")

    def test_returns_html_string_when_built(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        import src.email.templates as templates_mod

        fake_dir = tmp_path / "dist"
        fake_dir.mkdir()
        (fake_dir / "welcome.html").write_text("<!doctype html><p>hello</p>", encoding="utf-8")
        monkeypatch.setattr(templates_mod, "_TEMPLATE_DIR", fake_dir)
        html = resolve_template_html("welcome")
        assert "<!doctype html>" in html
        assert "hello" in html

    def test_unknown_template_raises_with_expected_path(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        import src.email.templates as templates_mod

        monkeypatch.setattr(templates_mod, "_TEMPLATE_DIR", tmp_path)
        with pytest.raises(FileNotFoundError) as ei:
            resolve_template_html("unknown_template")
        assert "unknown_template" in str(ei.value)
        assert "pnpm --filter @atelier/email build" in str(ei.value)
