"""GAP-133: 全ナレッジ再埋め込みバッチ (プロバイダ/モデル切替時の移行)。

モデルが違えばベクトル空間が違うため、切替後は既存行を現行モデルで
作り直すまで意味検索の対象にならない (検索は同一 embedding_model の行のみ)。

使い方:
  cd apps/api
  uv run --no-sync python scripts/reembed_knowledge.py --dry-run  # 対象件数の確認
  uv run --no-sync python scripts/reembed_knowledge.py            # 実行

対象: deleted_at is null かつ (embedding が無い or embedding_model が現行と違う) 行。
現行プロバイダは本体と同じ優先順 (VOYAGE_API_KEY → ローカル)。
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text


async def current_tag() -> str | None:
    from src.embeddings import local as local_emb

    if os.environ.get("VOYAGE_API_KEY"):
        return "voyage-3-large"
    if local_emb.local_available():
        return local_emb.local_model_tag()
    return None


async def reembed(dry_run: bool, batch: int) -> int:
    from src.db.session import create_engine, create_session_factory
    from src.services.knowledge import (
        _embed_text,  # pyright: ignore[reportPrivateUsage]
        _embedding_to_pg_literal,  # pyright: ignore[reportPrivateUsage]
    )

    if not os.environ.get("ATELIER_DB_URL"):
        raise SystemExit("ATELIER_DB_URL が未設定です")
    tag = await current_tag()
    if tag is None:
        raise SystemExit(
            "埋め込みプロバイダが利用できません (VOYAGE_API_KEY もローカル埋め込みも無効)"
        )
    factory = create_session_factory(create_engine())
    done = 0
    failed = 0
    async with factory() as session:
        res = await session.execute(
            text(
                "select id, content_md from public.knowledge_nodes "
                "where deleted_at is null "
                "and (embedding is null or embedding_model is distinct from :tag) "
                "order by created_at"
            ),
            {"tag": tag},
        )
        rows = res.all()
        print(f"target_model={tag} total={len(rows)} dry_run={dry_run}")
        if dry_run:
            return 0
        for i, row in enumerate(rows, start=1):
            vec, model = await _embed_text(str(row.content_md), input_type="document")
            if vec is None or model != tag:
                failed += 1
                print(f"  FAIL {row.id} (embedding unavailable)")
                continue
            await session.execute(
                text(
                    "update public.knowledge_nodes "
                    "set embedding = cast(:emb as extensions.vector), "
                    "embedding_model = :m where id = cast(:id as uuid)"
                ),
                {"emb": _embedding_to_pg_literal(vec), "m": model, "id": str(row.id)},
            )
            done += 1
            if i % batch == 0:
                await session.commit()
                print(f"  ... {i}/{len(rows)}")
        await session.commit()
    print(f"done={done} failed={failed}")
    return 1 if failed else 0


def main() -> None:
    parser = argparse.ArgumentParser(description="ナレッジ再埋め込み (モデル切替の移行)")
    parser.add_argument("--dry-run", action="store_true", help="対象件数の確認のみ")
    parser.add_argument("--batch", type=int, default=20, help="commit 間隔 (既定 20 件)")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(reembed(dry_run=args.dry_run, batch=args.batch)))


if __name__ == "__main__":
    main()
