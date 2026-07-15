"""ConsentEntry.version 検証の非 PG ユニットテスト (バグ #25)。

DB CHECK 制約 consents_version_semver_or_date と同一の semver/日付形式を
Pydantic 境界で強制し、不正入力が 500 でなく 422 になることを保証する。
schemas/auth.py の reject 分岐 (Gate #4 touched-file coverage) を非 PG で網羅する。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.schemas.auth import ConsentEntry


@pytest.mark.unit
@pytest.mark.parametrize("version", ["1", "1.0", "1.0.0", "10.20.30", "2026-07-15"])
def test_valid_versions_accepted(version: str) -> None:
    entry = ConsentEntry(type="terms_of_service", version=version, accepted=True)
    assert entry.version == version


@pytest.mark.unit
@pytest.mark.parametrize(
    "version",
    ["v1", "1.0.0-beta", "abc", "", "2026/07/15", "1.", ".1", "2026-7-15", "latest"],
)
def test_invalid_versions_rejected(version: str) -> None:
    with pytest.raises(ValidationError):
        ConsentEntry(type="privacy_policy", version=version, accepted=True)
