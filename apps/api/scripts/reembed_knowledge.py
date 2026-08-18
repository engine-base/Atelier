"""GAP-133: 全ナレッジ再埋め込みバッチ (プロバイダ/モデル切替時の手動移行)。

通常は不要: API 起動時のウォームアップが未埋め込み行を自動バックフィルする。
本スクリプトは「起動を待たずに今すぐ全件揃えたい」「移行の進捗を目視したい」
ときの手動実行用。実装は service 層の backfill_missing_embeddings と同一。

使い方:
  cd apps/api
  uv run --no-sync python scripts/reembed_knowledge.py --dry-run  # 対象件数の確認
  uv run --no-sync python scripts/reembed_knowledge.py            # 実行
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text


async def run(dry_run: bool) -> int:
    from src.db.session import create_engine, create_session_factory
    from src.embeddings import local as local_emb
    from src.services.knowledge import backfill_missing_embeddings

    if not os.environ.get("ATELIER_DB_URL"):
        raise SystemExit("ATELIER_DB_URL が未設定です")
    if os.environ.get("VOYAGE_API_KEY"):
        tag = "voyage-3-large"
    elif local_emb.local_available():
        tag = local_emb.local_model_tag()
        print(f"モデル準備中 ({local_emb.local_embedding_model()}) — 初回は DL が走ります…")
        await asyncio.to_thread(local_emb.warmup)
    else:
        raise SystemExit(
            "埋め込みプロバイダが利用できません (VOYAGE_API_KEY もローカル埋め込みも無効)"
        )

    factory = create_session_factory(create_engine())
    async with factory() as session:
        res = await session.execute(
            text(
                "select count(*) from public.knowledge_nodes "
                "where deleted_at is null "
                "and (embedding is null or embedding_model is distinct from cast(:tag as text))"
            ),
            {"tag": tag},
        )
        total = int(res.scalar_one())
    print(f"target_model={tag} total={total} dry_run={dry_run}")
    if dry_run or total == 0:
        return 0
    done = await backfill_missing_embeddings()
    print(f"done={done} remaining={total - done}")
    return 0 if done >= total else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="ナレッジ再埋め込み (モデル切替の移行)")
    parser.add_argument("--dry-run", action="store_true", help="対象件数の確認のみ")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(run(dry_run=args.dry_run)))


if __name__ == "__main__":
    main()
