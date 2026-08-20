"""プラットフォームジョブの単独実行 (GAP-014)。

Inngest 常駐なし環境 (dev / 障害時の手動実行) 用。cron 経由と同じ本体 +
cron_run_history 記録 (record_run) を通す。

    python -m src.services.platform_jobs purge      # 退会データ 30 日後完全削除
    python -m src.services.platform_jobs integrity  # データ整合性チェック
"""

from __future__ import annotations

import asyncio
import sys

from src.services.cron.history import record_run


async def _run(job: str) -> dict[str, str]:
    from src.db import shared_session_factory

    from . import purge_deleted_accounts, run_integrity_check

    factory = shared_session_factory()

    async def _body() -> dict[str, str]:
        async with factory() as session:
            if job == "purge":
                result = await purge_deleted_accounts(session)
            else:
                result = await run_integrity_check(session)
            await session.commit()
            return result

    name = "purge-deleted-accounts" if job == "purge" else "integrity-check"
    return await record_run(name, _body)


def main() -> int:
    job = sys.argv[1] if len(sys.argv) > 1 else ""
    if job not in ("purge", "integrity"):
        print("usage: python -m src.services.platform_jobs {purge|integrity}", file=sys.stderr)
        return 2
    result = asyncio.run(_run(job))
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
