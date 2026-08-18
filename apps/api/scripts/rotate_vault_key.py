"""GAP-131: Vault 鍵ローテーション — 全シークレット行を新しい先頭鍵で再暗号化する。

【重要 — 誤解しやすい 2 点】
  1. **保管されたシークレットの値 (Supabase キー / API キー等) は 1 文字も
     変わらない**。交換するのは「保管庫の扉の鍵 (暗号化鍵)」だけで、中身は
     復号 → 新しい鍵で再暗号化されるのみ。登録済みの値はそのまま使い続けられる。
  2. **自動では絶対に実行されない**。スケジューラ・CI・AI からの呼び出しは無く、
     経営者が本スクリプトを手で実行したときだけ動く。さらに --yes 無しの
     実行は確認入力 (rotate と打つ) を要求する。

使い方 (詳細な手順は docs/vault-key-operations.md):
  1. 新しい鍵を発行する:
       python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
  2. ATELIER_VAULT_ENCRYPTION_KEYS を「新鍵,旧鍵」の順に設定して API を再起動する
     (この時点で新規は新鍵・既存は旧鍵のまま読める — 移行期)
  3. 本スクリプトを実行して既存行を新鍵で再暗号化する:
       cd apps/api && uv run --no-sync python scripts/rotate_vault_key.py
  4. 全行の rotate を確認したら ATELIER_VAULT_ENCRYPTION_KEYS から旧鍵を外す

安全性:
  - MultiFernet.rotate は復号 → 先頭鍵で再暗号化 (平文をディスクに出さない)
  - どの鍵でも開けない行は SKIP して報告する (黙って壊さない)
  - --dry-run で件数だけ確認できる
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from sqlalchemy import text


def _build_fernet() -> MultiFernet:
    from src.services.project_credentials import vault_key_material

    keys = vault_key_material()
    if len(keys) < 1:
        raise SystemExit(
            "ATELIER_VAULT_ENCRYPTION_KEYS (または ATELIER_VAULT_ENCRYPTION_KEY) が未設定です"
        )
    return MultiFernet([Fernet(k.encode("ascii")) for k in keys])


async def rotate(dry_run: bool) -> int:
    from src.db.session import create_engine, create_session_factory

    if not os.environ.get("ATELIER_DB_URL"):
        raise SystemExit("ATELIER_DB_URL が未設定です")
    mf = _build_fernet()
    factory = create_session_factory(create_engine())
    rotated = 0
    skipped: list[str] = []
    async with factory() as session:
        res = await session.execute(
            text("select id, encrypted_value from public.project_credentials")
        )
        rows = res.all()
        for row in rows:
            token = str(row.encrypted_value).encode("ascii")
            try:
                new_token = mf.rotate(token)
            except InvalidToken:
                skipped.append(str(row.id))
                continue
            if new_token == token:
                continue  # 既に先頭鍵 — 触らない (updated_at を汚さない)
            rotated += 1
            if not dry_run:
                await session.execute(
                    text(
                        "update public.project_credentials "
                        "set encrypted_value = :ev where id = cast(:id as uuid)"
                    ),
                    {"ev": new_token.decode("ascii"), "id": str(row.id)},
                )
        if not dry_run:
            await session.commit()
    print(f"total={len(rows)} rotated={rotated} skipped={len(skipped)} dry_run={dry_run}")
    if skipped:
        print("SKIP (どの鍵でも復号できない行 — 鍵の設定漏れを確認してください):")
        for sid in skipped:
            print(f"  {sid}")
        return 1
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Vault 鍵ローテーション (再暗号化)")
    parser.add_argument("--dry-run", action="store_true", help="件数確認のみ (書き込みなし)")
    parser.add_argument(
        "--yes", action="store_true", help="確認入力をスキップ (自動化された運用手順専用)"
    )
    args = parser.parse_args()
    if not args.dry_run and not args.yes:
        # 誤実行ガード: 対話確認を必須にする (保管された値は変わらないが、
        # 鍵運用は経営者の明示的な意思で行う操作のため)
        print("Vault の暗号化鍵を交換します。保管されたシークレットの値は変わりません。")
        try:
            answer = input("続行するには rotate と入力してください: ").strip()
        except EOFError:  # 非対話実行 (パイプ等) は明示 --yes が無い限り拒否
            raise SystemExit("中止しました (非対話実行は --yes が必要です)") from None
        if answer != "rotate":
            raise SystemExit("中止しました (入力が rotate ではありません)")
    raise SystemExit(asyncio.run(rotate(dry_run=args.dry_run)))


if __name__ == "__main__":
    main()
