"""Unit tests for apps/api/src/db/base.py.

Coverage target: >= 80% lines for src/db/base.py and src/db/__init__.py.
"""

from __future__ import annotations

import pytest
from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

from src.db import Base, metadata
from src.db.base import NAMING_CONVENTION


@pytest.mark.unit
class TestNamingConvention:
    def test_contains_all_postgres_constraint_keys(self) -> None:
        assert set(NAMING_CONVENTION.keys()) == {"ix", "uq", "ck", "fk", "pk"}

    def test_naming_convention_keys_use_postgres_token_syntax(self) -> None:
        for key, template in NAMING_CONVENTION.items():
            assert template.startswith(key + "_"), f"{key} prefix expected"
            assert "%(" in template, f"{key} should contain SQLAlchemy token"


@pytest.mark.unit
class TestMetadata:
    def test_metadata_is_sqlalchemy_metadata_instance(self) -> None:
        assert isinstance(metadata, MetaData)

    def test_metadata_uses_naming_convention(self) -> None:
        # SQLAlchemy stores naming_convention as immutabledict
        assert dict(metadata.naming_convention) == NAMING_CONVENTION


@pytest.mark.unit
class TestBase:
    def test_base_is_declarative(self) -> None:
        assert issubclass(Base, DeclarativeBase)

    def test_base_shares_metadata(self) -> None:
        assert Base.metadata is metadata


@pytest.mark.unit
class TestDbInit:
    def test_db_module_exports_expected_symbols(self) -> None:
        import src.db as db_mod

        for name in (
            "Base",
            "DatabaseSettings",
            "create_engine",
            "create_session_factory",
            "get_session",
            "metadata",
        ):
            assert hasattr(db_mod, name), f"missing export: {name}"
