"""SQLAlchemy 2.0 Declarative Base + metadata。

ORM 層は薄く保つ方針のため、ほとんどのテーブルは
sqlalchemy.Table(name, metadata, ...) で宣言し、必要な domain 型のみ
DeclarativeBase 派生クラスを使う。
"""

from __future__ import annotations

from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

# PostgreSQL 命名規則。Supabase CLI で生成される migration と整合させる。
NAMING_CONVENTION: dict[str, str] = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

metadata = MetaData(naming_convention=NAMING_CONVENTION)


class Base(DeclarativeBase):
    """全ての ORM model の基底。metadata は共有。"""

    metadata = metadata
