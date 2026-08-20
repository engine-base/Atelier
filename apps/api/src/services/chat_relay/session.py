"""GAP-190: スレッドごとに「同じ Claude セッション」で走らせる。

経営者確認 (2026-08-20):
    「そのセッション内ではずっと同じターミナルのセッションとして走れるという
      認識だよね？ それだと色々上記の問題も治ると思っているけど」

実 CLI で成立を確認済み:
    ① `--session-id` 指定 → 別プロセスで `--resume` すると会話が引き継がれる
    ② セッションは `~/.claude/projects/<cwd の / を - に置換>/<id>.jsonl` の
       **実ファイル**として残る (プロセス死・PC 再起動を跨いで残る)

これまでの実態:
    毎回まっさらな `claude -p` を起動し、会話の中身はサーバーが DB 履歴 +
    ローリング要約から組み直して**毎回送り直していた**。そのため
      - Claude Code 側のセッション状態 (TODO・作業途中) が毎ターン消える
      - 履歴を毎回送るので、利用者のプラン枠を余分に消費する

設計の要点 — **誰が「再開できるか」を決めるか**:
    セッションは PC ローカルなので、サーバーは「その PC に実体があるか」を
    知り得ない。そこで **Bridge が自分の PC を見て決める**:

      1. サーバーはジョブに「使ってほしいセッション ID」と、
         **再開できなかったとき用に履歴を畳んだプロンプト**の両方を載せる
      2. Bridge は transcript の実ファイルを見て、あれば `--resume` + 新しい
         発言だけ、無ければ `--session-id` + 履歴込みプロンプトで実行する
      3. Bridge は**実際に使ったセッション ID と再開できたか**を報告し、
         サーバーがスレッドに保存する

    これで「別の PC で開いた」「PC を初期化した」も自己修復する。推測しない。
"""

from __future__ import annotations

import uuid as uuid_mod
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class ThreadSession:
    """スレッドが使う Claude セッション。

    session_id は「使ってほしい ID」。Bridge がその PC に実体を見つけられなければ
    別の ID を採番して報告してくるので、こちらの値は希望であって保証ではない。
    """

    session_id: str
    #: そのセッションが存在すると分かっている PC (未確定なら None)
    worker_id: str | None
    #: 既に一度でも実行に使われたか (False = 今回が初回)
    established: bool


async def ensure_thread_session(session: AsyncSession, *, thread_id: str) -> ThreadSession:
    """スレッドのセッション ID を返す (無ければ採番して保存する)。

    採番だけでは「その PC に実体がある」ことにはならない。実体の有無は Bridge が
    判定し、結果を record_session_use() で書き戻す。
    """
    try:
        thread_id = str(uuid_mod.UUID(thread_id))
    except ValueError:
        # スレッド ID が不正ならセッションを持たせない (呼び出し側が従来動作へ)
        return ThreadSession(str(uuid_mod.uuid4()), None, False)

    row = (
        await session.execute(
            text(
                "select claude_session_id, claude_session_worker_id, claude_session_used_at "
                "from public.chat_threads where id = cast(:t as uuid)"
            ),
            {"t": thread_id},
        )
    ).first()
    if row is None:
        return ThreadSession(str(uuid_mod.uuid4()), None, False)
    if row.claude_session_id is not None:
        return ThreadSession(
            str(row.claude_session_id),
            None if row.claude_session_worker_id is None else str(row.claude_session_worker_id),
            row.claude_session_used_at is not None,
        )

    new_id = str(uuid_mod.uuid4())
    await session.execute(
        text(
            "update public.chat_threads set claude_session_id = cast(:s as uuid) "
            "where id = cast(:t as uuid) and claude_session_id is null"
        ),
        {"s": new_id, "t": thread_id},
    )
    # 競合で他が先に入れていたら、そちらを正とする (同じスレッドに 2 セッションを作らない)
    current = (
        await session.execute(
            text("select claude_session_id from public.chat_threads where id = cast(:t as uuid)"),
            {"t": thread_id},
        )
    ).first()
    if current is not None and current.claude_session_id is not None:
        return ThreadSession(str(current.claude_session_id), None, False)
    return ThreadSession(new_id, None, False)


async def record_session_use(
    session: AsyncSession,
    *,
    job_id: str,
    session_id: str | None,
    resumed: bool | None,
    worker_id: str | None = None,
) -> None:
    """Bridge が実際に使ったセッションをスレッドへ書き戻す (自己修復)。

    Bridge が別 ID を採番していたら、そちらでスレッドを上書きする。
    「サーバーが希望した ID」ではなく「実際に PC 上にあるセッション」を正にする
    ため、次のターンから確実に再開できる。
    """
    if session_id is None:
        return
    try:
        session_id = str(uuid_mod.UUID(session_id))
    except ValueError:
        return

    await session.execute(
        text(
            "update public.chat_relay_jobs set session_id = cast(:s as uuid), resumed = :r "
            "where id = cast(:i as uuid)"
        ),
        {"s": session_id, "r": resumed, "i": job_id},
    )
    row = (
        await session.execute(
            text("select thread_id from public.chat_relay_jobs where id = cast(:i as uuid)"),
            {"i": job_id},
        )
    ).first()
    if row is None or row.thread_id is None:
        return
    await session.execute(
        text(
            "update public.chat_threads "
            "set claude_session_id = cast(:s as uuid), "
            "    claude_session_worker_id = coalesce(:w, claude_session_worker_id), "
            "    claude_session_used_at = now() "
            "where id = cast(:t as uuid)"
        ),
        {"s": session_id, "w": worker_id, "t": str(row.thread_id)},
    )


async def clear_thread_session(session: AsyncSession, *, thread_id: str) -> None:
    """スレッドのセッションを切り離す (分岐・やり直しで新しい会話にしたいとき)。

    次の実行で新しいセッション ID が採番される。
    """
    try:
        thread_id = str(uuid_mod.UUID(thread_id))
    except ValueError:
        return
    await session.execute(
        text(
            "update public.chat_threads set claude_session_id = null, "
            "claude_session_worker_id = null, claude_session_used_at = null "
            "where id = cast(:t as uuid)"
        ),
        {"t": thread_id},
    )


__all__ = [
    "ThreadSession",
    "clear_thread_session",
    "ensure_thread_session",
    "record_session_use",
]
