"""GAP-166: 成果物ファイル (Excel / PDF 等) を本人の Claude Code に直してもらう。

経営者指摘 (2026-08-19):
  「でもこれ Claude Code ではできるくない？？ サブスクのプランでやっているし
   できるはずだけどどうしてできないの？？ できる状態にして欲しい」

そのとおりです。サーバー側は「値だけの表」しか扱えませんが (GAP-163)、
**本人の PC で走る Claude Code はファイルそのものを開いて編集できます**
(openpyxl・pypdf 等を自分で使える)。そこで:

  1. ジョブの作業場に **対象ファイルの実体を配る** (workspace seed の拡張)
  2. 「このファイルを〜のとおり直して同じ名前で保存して」と指示して実行
  3. Bridge が変更を検出 → 既存の取り込み経路で **新バージョン**になる

費用は本人の Claude サブスク。Bridge がオフラインなら **enqueue せず正直に断る**
(黙ってキューに積んで待たせない)。
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.services.chat_relay import enqueue_job, worker_online

EDITABLE_BY_CLAUDE_CODE = (
    ".xlsx",
    ".xlsm",
    ".xls",
    ".csv",
    ".pdf",
    ".docx",
    ".pptx",
    ".md",
    ".txt",
    ".json",
)

_SYSTEM = (
    "あなたはこの PC の作業場でファイルを直接編集する担当です。\n"
    "厳守:\n"
    "1) 作業場にあるファイルを、指示のとおりに編集し、**同じファイル名で上書き保存**する。\n"
    "2) 形式は変えない (xlsx は xlsx のまま、PDF は PDF のまま)。\n"
    "3) 指示に無い箇所は変えない。既存の書式・レイアウトはできる限り保つ。\n"
    "4) 必要なライブラリ (openpyxl / pypdf / python-docx 等) は自分で使ってよい。\n"
    "5) 保存できたら、何をどう変えたかを 1〜2 行で報告する。\n"
    "6) 指示が不可能な場合は、勝手に別のことをせず、できない理由を報告する。"
)


def job_session_factory() -> async_sessionmaker[AsyncSession]:
    """ジョブ行を積むための service セッション (chat の relay 経路と同じもの)。

    RLS 上テナントから chat_relay_jobs は insert できないため service 経路を使う。
    テストはここを差し替える (差し替え口を明示的に公開しておく)。
    """
    from src.services.chat_sse.relay import (
        _session_factory,  # pyright: ignore[reportPrivateUsage]
    )

    return _session_factory()


class FileEditError(Exception):
    """code: not_found / unsupported / bridge_offline"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def request_file_edit(
    session: AsyncSession, *, actor_id: str, output_id: str, instruction: str
) -> str:
    """成果物ファイルの編集ジョブを積み、job_id を返す。

    返り値の job_id は既存の chat-relay ジョブ経路と同じもの (進捗も同じ仕組み)。
    """
    from src.services.mocks.artifacts import FILEDB_PREFIX, fetch_file_service

    row = (
        await session.execute(
            text(
                "select wo.html_path, wo.project_id, wo.summary, "
                "  (select ct.id from public.chat_threads ct "
                "    where ct.project_id = wo.project_id "
                "    order by ct.updated_at desc limit 1) as thread_id "
                "from public.workflow_outputs wo "
                "where wo.id = cast(:i as uuid) and wo.deleted_at is null"
            ),
            {"i": output_id},
        )
    ).first()
    if row is None or row.html_path is None:
        raise FileEditError("not_found", "成果物が見つかりません")
    path = str(row.html_path)
    if not path.startswith(FILEDB_PREFIX):
        raise FileEditError(
            "unsupported",
            "この成果物はファイル形式ではありません (HTML 成果物は AI への修正依頼から直せます)",
        )
    found = await fetch_file_service(path[len(FILEDB_PREFIX) :])
    if found is None:
        raise FileEditError("not_found", "ファイルの実体が見つかりません")
    _data, _mime, file_name = found
    if not file_name.lower().endswith(EDITABLE_BY_CLAUDE_CODE):
        raise FileEditError(
            "unsupported", f"この形式はファイル編集に対応していません ({file_name})"
        )
    prompt = (
        f"作業場にある「{file_name}」を次のとおり直して、同じファイル名で上書き保存してください。\n\n"
        f"修正指示:\n{instruction}\n\n"
        "保存後、何をどう変えたかを 1〜2 行で報告してください。"
    )

    # 認可 (どの成果物を触れるか) は上の RLS セッションで確定済み。
    # ジョブ行は service セッションで積む (chat の relay 経路と同じ)。
    async with job_session_factory()() as job_session:
        if not await worker_online(job_session, user_id=actor_id):
            raise FileEditError(
                "bridge_offline",
                "お使いの PC の Bridge がオフラインのため実行できません。"
                "Bridge アプリを起動してから再実行してください",
            )
        if row.thread_id is None:
            raise FileEditError(
                "unsupported",
                "このプロジェクトには会話がまだありません "
                "(進行タブで 1 度会話してから実行してください)",
            )
        job_id = await enqueue_job(
            job_session,
            thread_id=str(row.thread_id),
            requested_by=actor_id,
            system_prompt=_SYSTEM,
            prompt=prompt,
            tools_mode="auto",
        )
        await job_session.commit()
    return job_id
