"""表を丸ごと塞ぐ蓋が残っていないか、**実 DB で**確かめる (GAP-224)。

何が起きたか
------------
`client_invitations` には「本物の policy を置くまでの仮の蓋」として

    create policy client_invitations_default_deny on public.client_invitations
      as restrictive for all to public using (false);

が置かれていた。T-D-93 がこれを drop して 4 本の member policy を置いたのに、
**蓋だけが復活していた**。`scripts/dev-bootstrap.sh` は列レベル REVOKE が一括
GRANT に打ち消されるのを補うため revoke を含む migration を最後にもう一度流す
(GAP-172)。蓋を作るファイルが revoke を含んでいたため、その対象に入っていた。

`restrictive` は permissive な policy と **AND** されるので、`using (false)` が
1 本あるだけで **何本 permissive を置いても全部 false** になる。結果:

  - クライアント招待を **1 件も発行できない** (INSERT が RLS 違反で 500)
  - オーナー本人が自分の招待を **0 件しか見られない** (service 経路では 1 件見える)

なぜ静的検査ではなく実 DB で見るか
----------------------------------
この蓋は**設計として正しく使われている**箇所が多い (置いてすぐ後の migration が
drop する)。migration ファイルを regex で走査すると、正しい 23 表まで違反として
挙げてしまった。**正しい設計を落とす門は、赤が普通になって本物の穴を隠す。**
最終的に効いているのは実 DB の状態なので、そこを見る。

判定
----
「permissive な policy がある」= 誰かに使わせる意図がある表。そこに
「全部塞ぐ restrictive」が同居していたら、その意図は達成されていない。
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
import sqlalchemy
from sqlalchemy import Engine, text
from sqlalchemy.pool import NullPool

PG_SYNC = os.environ.get(
    "ATELIER_TEST_PG_URL",
    "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322",
).replace("+asyncpg", "+psycopg")


def _db_available() -> bool:
    try:
        eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
        try:
            with eng.connect() as c:
                c.execute(text("select 1 from pg_policy limit 1"))
        finally:
            eng.dispose()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="Postgres not available")


@pytest.fixture
def engine() -> Iterator[Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    try:
        yield eng
    finally:
        eng.dispose()


#: 表を丸ごと塞ぐ restrictive policy と、その表の permissive policy 本数
_QUERY = text("""
    select c.relname                                        as table_name,
           p.polname                                        as policy_name,
           (select count(*) from pg_policy q
             where q.polrelid = p.polrelid and q.polpermissive) as permissive_count
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and p.polpermissive = false
       and p.polcmd = '*'
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '') = 'false'
     order by c.relname
""")


def test_使わせる意図のある表が丸ごと塞がれていない(engine: Engine) -> None:
    with engine.connect() as conn:
        rows = list(conn.execute(_QUERY))

    blocked = [
        (r.table_name, r.policy_name, r.permissive_count) for r in rows if r.permissive_count > 0
    ]
    assert not blocked, "\n".join(
        f"  {t}: {p} が全部を塞いでいるのに permissive policy が {n} 本ある"
        f" — 誰かに使わせる意図があるのに、RLS で読み書きできない"
        for t, p, n in blocked
    )


def test_招待をオーナー本人が読めること(engine: Engine) -> None:
    """`client_invitations` は今回壊れていた表。RLS を通して読めるかを直接見る。

    行が 0 件でも構わない — ここで落としたいのは
    「**RLS が評価すらさせてくれない**」状態。
    """
    with engine.connect() as conn:
        exists = conn.execute(
            text("select to_regclass('public.client_invitations') is not null")
        ).scalar_one()
        if not exists:
            pytest.skip("client_invitations が無い DB")

        conn.execute(text("set local role authenticated"))
        conn.execute(
            text("select set_config('request.jwt.claims', :c, true)"),
            {"c": '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}'},
        )
        # 全部塞ぐ蓋があると、行の有無に関わらず policy 評価が false で固定される。
        # ここでは「例外なく問い合わせが成立する」ことと、蓋が無いことを併せて見る。
        conn.execute(text("select count(*) from public.client_invitations"))
        conn.execute(text("reset role"))

    with engine.connect() as conn:
        capped = conn.execute(
            text("""
                select count(*) from pg_policy p
                 where p.polrelid = 'public.client_invitations'::regclass
                   and p.polpermissive = false
                   and p.polcmd = '*'
                   and coalesce(pg_get_expr(p.polqual, p.polrelid), '') = 'false'
            """)
        ).scalar_one()
    assert capped == 0, (
        "client_invitations に全部を塞ぐ restrictive policy が残っている。"
        " これがあるとクライアント招待を 1 件も発行できない (GAP-224 の再発)"
    )
