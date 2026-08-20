"""GAP-114: チャットのローカル実行リレー サービス層。

S-E01 チャットの LLM 実行を、各ユーザーの PC で稼働する Bridge に中継する。
Bridge はその PC の Claude ログイン (= 本人の月額プラン) で `claude -p` を実行し、
text delta を chunks として逐次返送する。

ジョブ状態遷移:
    queued → running → done | error
    queued/running → expired (SSE 側タイムアウト時)

書き込みは全て service session (RLS バイパス) — enqueue は chat_sse、
claim/chunks/complete は routes/dispatcher の BridgeAuth 経由。
読み取り (SSE の chunk ポーリング) も service session だが、job の
requested_by/thread_id は enqueue 時に確定しており越境読み出しは発生しない。

state-changing 操作は audit_logs に記録 (actor_type='system', actor_id='bridge'
— kanban 系 bridge_tools と同一方針)。
"""

from __future__ import annotations

import json
import logging
import uuid as uuid_mod
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter

logger = logging.getLogger(__name__)

# Bridge presence をオンラインとみなす鮮度 (秒)。S-I03 接続バッジ (90 秒) と同一。
PRESENCE_FRESH_SECONDS = 90


class ChatRelayError(Exception):
    """chat relay 操作の状態不整合 (code: not_found / invalid_state)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def _audit(
    session: AsyncSession,
    *,
    action: str,
    target_id: str,
    after: dict[str, object] | None = None,
) -> None:
    await AuditWriter(session).write(
        AuditEvent(
            action=action,
            target_type="chat_relay_job",
            actor_type="system",
            actor_id="bridge",
            target_id=target_id,
            after=after,
        )
    )


async def worker_online(session: AsyncSession) -> bool:
    """Bridge presence が鮮度内 (90 秒) の worker を 1 つでも持つか。

    relay モードで worker 不在のまま enqueue しても誰も拾わないため、
    chat_sse は送信前にこれで誠実にエラーを返す (黙って待たせない)。
    """
    res = await session.execute(
        text(
            "select 1 from public.bridge_workers "
            "where last_seen_at > now() - make_interval(secs => :fresh) limit 1"
        ),
        {"fresh": PRESENCE_FRESH_SECONDS},
    )
    return res.first() is not None


async def enqueue_job(
    session: AsyncSession,
    *,
    thread_id: str | None,
    requested_by: str,
    system_prompt: str,
    prompt: str,
    tools_mode: str = "off",
) -> str:
    """queued ジョブを積み、job_id を返す。

    GAP-134: tools_mode (off/approve/auto) を Bridge へ伝える — 本人の PC で
    本人のプランを使った PC 操作 (Claude Code 同等) を有効化する。
    GAP-138: thread_id=None はチャット外のシステムジョブ (モック生成等) —
    requested_by 本人の Bridge が実行する点は同じ。
    """
    res = await session.execute(
        text(
            "insert into public.chat_relay_jobs "
            "(thread_id, requested_by, status, system_prompt, prompt, tools_mode) "
            "values (cast(:t as uuid), cast(:u as uuid), 'queued', :sp, :p, :tm) "
            "returning id"
        ),
        {
            "t": thread_id,
            "u": requested_by,
            "sp": system_prompt,
            "p": prompt,
            "tm": tools_mode,
        },
    )
    job_id = str(res.scalar_one())
    await _audit(
        session, action="chat_relay.enqueue", target_id=job_id, after={"tools_mode": tools_mode}
    )
    return job_id


async def pick_job(
    session: AsyncSession, *, worker_id: str, requested_by: str | None = None
) -> dict[str, Any] | None:
    """最古の queued job を 1 件 atomic に claim (queued→running)。

    kanban pick と同じ `for update skip locked` で並行 worker と競合しない。
    無ければ None。

    GAP-122: requested_by (user トークンの本人) が指定されたら本人の job のみ
    確保する — 他人のプロンプトが他人の PC に流れない (R-T08 系の分離)。
    """
    res = await session.execute(
        text(
            "with picked as ("
            "  select id from public.chat_relay_jobs "
            "  where status = 'queued' "
            "  and (cast(:u as uuid) is null or requested_by = cast(:u as uuid)) "
            "  order by created_at "
            "  limit 1 for update skip locked"
            ") update public.chat_relay_jobs j set status = 'running', "
            "worker_id = :w, started_at = now() "
            "where j.id in (select id from picked) "
            "returning j.id, j.system_prompt, j.prompt, j.tools_mode"
        ),
        {"w": worker_id, "u": requested_by},
    )
    row = res.first()
    if row is None:
        return None
    job_id = str(row.id)
    await _audit(
        session, action="chat_relay.pick", target_id=job_id, after={"worker_id": worker_id}
    )
    return {
        "job_id": job_id,
        "system_prompt": str(row.system_prompt),
        "prompt": str(row.prompt),
        "tools_mode": str(row.tools_mode),
    }


def _validated_job_id(job_id: str) -> str:
    """UUID 形式でない job_id は DB に触れず not_found (500 を出さない)。"""
    try:
        return str(uuid_mod.UUID(job_id))
    except ValueError:
        raise ChatRelayError("not_found", f"chat relay job {job_id!r} not found") from None


async def _job_status(session: AsyncSession, job_id: str) -> str | None:
    res = await session.execute(
        text("select status from public.chat_relay_jobs where id = cast(:i as uuid)"),
        {"i": job_id},
    )
    row = res.first()
    return None if row is None else str(row.status)


async def append_chunks(
    session: AsyncSession,
    *,
    job_id: str,
    seq_start: int,
    texts: list[str],
    kinds: list[str] | None = None,
) -> None:
    """running ジョブへ chunk を追記する (seq は seq_start からの連番)。

    GAP-134: kinds (texts と同長) で種別を指定できる — 'delta' (本文) /
    'tool' (ツール実況、content はツール名)。省略時は全て delta (後方互換)。
    running 以外 (done/expired 等) への追記は invalid_state — SSE 側が
    タイムアウト済みのジョブに遅延書き込みされるのを拒否する。
    """
    job_id = _validated_job_id(job_id)
    status = await _job_status(session, job_id)
    if status is None:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    if status != "running":
        raise ChatRelayError("invalid_state", f"job is {status}, not running")
    if kinds is not None and len(kinds) != len(texts):
        raise ChatRelayError("invalid_state", "kinds must match texts length")
    for offset, content in enumerate(texts):
        kind = "delta" if kinds is None else kinds[offset]
        if kind not in ("delta", "tool"):
            raise ChatRelayError("invalid_state", f"unknown chunk kind {kind!r}")
        await session.execute(
            text(
                "insert into public.chat_relay_chunks (job_id, seq, content, kind) "
                "values (cast(:j as uuid), :s, :c, :k) on conflict (job_id, seq) do nothing"
            ),
            {"j": job_id, "s": seq_start + offset, "c": content, "k": kind},
        )


async def save_job_artifacts(
    session: AsyncSession,
    *,
    job_id: str,
    artifacts: list[dict[str, str]],
    requester_user_id: str | None = None,
) -> list[dict[str, object]]:
    """GAP-137: Bridge がジョブ完了直前に成果物 (HTML) を送り、モックへ取り込む。

    - job は running であること (complete 前に呼ぶ契約 — 取り込み結果の
      artifact chunk を SSE が同一ストリームで配れる)
    - user トークンの Bridge は本人のジョブのみ (requested_by 照合)
    - GAP-139: 種類を判定して振り分ける — モックは mocks、見積・提案書・
      テスト仕様書等は workflow_outputs (stage 別)。HTML=全部モック、にしない
    - 取り込み結果を kind='artifact' の chunk (content=JSON) として追記する
    """
    from src.services.mocks.artifacts import (
        ARTIFACT_KIND_MOCK,
        MAX_ARTIFACTS_PER_JOB,
        ArtifactIngestError,
        classify_artifact,
        ingest_file_artifact,
        ingest_html_artifact,
        ingest_html_output,
    )

    job_id = _validated_job_id(job_id)
    row = (
        await session.execute(
            text(
                "select j.status, j.requested_by, j.prompt, t.project_id "
                "from public.chat_relay_jobs j "
                "join public.chat_threads t on t.id = j.thread_id "
                "where j.id = cast(:i as uuid)"
            ),
            {"i": job_id},
        )
    ).first()
    if row is None:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    if str(row.status) != "running":
        raise ChatRelayError("invalid_state", f"job is {row.status}, not running")
    if requester_user_id is not None and str(row.requested_by) != requester_user_id:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    if len(artifacts) > MAX_ARTIFACTS_PER_JOB:
        raise ChatRelayError("invalid_state", f"artifacts exceed limit ({MAX_ARTIFACTS_PER_JOB})")
    project_id = str(row.project_id)

    results: list[dict[str, object]] = []
    next_seq = int(
        (
            await session.execute(
                text(
                    "select coalesce(max(seq), -1) + 1 from public.chat_relay_chunks "
                    "where job_id = cast(:j as uuid)"
                ),
                {"j": job_id},
            )
        ).scalar_one()
    )
    for artifact in artifacts:
        file_name = str(artifact.get("file_name", ""))
        content_b64 = artifact.get("content_b64")
        if content_b64:
            # GAP-145: バイナリ成果物 (画像 / PPTX / PDF / Excel / 動画 等)
            import base64 as _b64

            try:
                data = _b64.b64decode(str(content_b64), validate=True)
            except Exception as exc:
                raise ChatRelayError(
                    "invalid_state", f"{file_name}: content_b64 が不正です"
                ) from exc
            try:
                ingested = await ingest_file_artifact(
                    session,
                    project_id=project_id,
                    file_name=file_name,
                    data=data,
                    source="chat_pc_tools",
                    actor_label="bridge",
                    instruction=str(row.prompt),
                )
            except ArtifactIngestError as exc:
                raise ChatRelayError(exc.code, exc.message) from exc
            await session.execute(
                text(
                    "insert into public.chat_relay_chunks (job_id, seq, content, kind) "
                    "values (cast(:j as uuid), :s, :c, 'artifact') "
                    "on conflict (job_id, seq) do nothing"
                ),
                {"j": job_id, "s": next_seq, "c": json.dumps(ingested)},
            )
            next_seq += 1
            results.append(dict(ingested))
            continue
        html = str(artifact.get("html", ""))
        kind = classify_artifact(file_name=file_name, html=html, instruction=str(row.prompt))
        try:
            if kind == ARTIFACT_KIND_MOCK:
                ingested: dict[str, object] = {
                    "type": "mock",
                    **await ingest_html_artifact(
                        session,
                        project_id=project_id,
                        file_name=file_name,
                        html=html,
                        source="chat_pc_tools",
                        actor_label="bridge",
                    ),
                }
            else:
                ingested = await ingest_html_output(
                    session,
                    project_id=project_id,
                    file_name=file_name,
                    html=html,
                    stage=kind,
                    source="chat_pc_tools",
                    actor_label="bridge",
                )
        except ArtifactIngestError as exc:
            raise ChatRelayError(exc.code, exc.message) from exc
        await session.execute(
            text(
                "insert into public.chat_relay_chunks (job_id, seq, content, kind) "
                "values (cast(:j as uuid), :s, :c, 'artifact') "
                "on conflict (job_id, seq) do nothing"
            ),
            {"j": job_id, "s": next_seq, "c": json.dumps(ingested)},
        )
        next_seq += 1
        results.append(dict(ingested))
    await _audit(
        session,
        action="chat_relay.artifacts",
        target_id=job_id,
        after={"count": len(results)},
    )
    return results


_SEED_MAX_FILES = 20


def _jsonb_dict(value: Any) -> dict[str, Any]:
    """jsonb 列を dict に正規化する (driver により str で返るため)。"""
    if isinstance(value, dict):
        return dict(value)  # pyright: ignore[reportUnknownArgumentType]
    if isinstance(value, str):
        try:
            parsed: Any = json.loads(value)
            if isinstance(parsed, dict):
                out: dict[str, Any] = {}
                for k, v in parsed.items():  # pyright: ignore[reportUnknownVariableType]
                    out[str(k)] = v  # pyright: ignore[reportUnknownArgumentType]
                return out
            return {}
        except ValueError:
            return {}
    return {}


def _sanitize_seed_name(name: str, fallback: str, *, keep_ext: bool = False) -> str:
    """seed ファイル名の安全化 (パス区切り・ .. を除去)。

    keep_ext=False は HTML 正本用 (.html を保証)。GAP-161 の添付配布は
    keep_ext=True で元の拡張子 (.png/.pdf/.xlsx 等) をそのまま残す。
    """
    import re as _re

    base = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1].strip()
    base = _re.sub(r"[^\w\-. ぁ-んァ-ヶ一-龠ー]", "_", base)
    if base in ("", ".", ".."):
        base = fallback
    if not keep_ext and not base.lower().endswith((".html", ".htm")):
        base += ".html"
    return base[:120]


async def get_job_workspace_seed(
    session: AsyncSession,
    *,
    job_id: str,
    requester_user_id: str | None = None,
) -> list[dict[str, str]]:
    """GAP-141: ツールジョブ開始前にローカル作業場へ実体化する「正本」一式。

    ローカル作業フォルダに古いファイルが残っていると、AI が古い版を土台に
    編集してしまい版連鎖が乱れる (ローカルと Supabase の二重化問題)。
    ジョブの project の最新版 (モック各画面 + mockdb 成果物各 stage) を返し、
    Bridge が作業フォルダへ上書き展開してから CLI を起動する — ローカルは
    常に「正本のチェックアウト」になる。
    """
    from src.services.mocks.artifacts import MOCKDB_PREFIX, fetch_mock_content

    job_id = _validated_job_id(job_id)
    row = (
        await session.execute(
            text(
                "select j.status, j.requested_by, j.thread_id, t.project_id "
                "from public.chat_relay_jobs j "
                "join public.chat_threads t on t.id = j.thread_id "
                "where j.id = cast(:i as uuid)"
            ),
            {"i": job_id},
        )
    ).first()
    if row is None:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    if requester_user_id is not None and str(row.requested_by) != requester_user_id:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    project_id = str(row.project_id)

    files: list[dict[str, str]] = []
    used_names: set[str] = set()

    async def _append(path: str, name_hint: str, fallback: str) -> None:
        if len(files) >= _SEED_MAX_FILES or not path.startswith(MOCKDB_PREFIX):
            return
        html = await fetch_mock_content(session, content_id=path[len(MOCKDB_PREFIX) :])
        if html is None:
            return
        name = _sanitize_seed_name(name_hint, fallback)
        while name in used_names:
            name = f"_{name}"
        used_names.add(name)
        files.append({"file_name": name, "html": html})

    mock_rows = (
        await session.execute(
            text(
                "select distinct on (screen_name) screen_name, html_storage_path, meta_tags "
                "from public.mocks where project_id = cast(:pid as uuid) "
                "and deleted_at is null order by screen_name, version desc"
            ),
            {"pid": project_id},
        )
    ).all()
    for m in mock_rows:
        meta = _jsonb_dict(m.meta_tags)
        name_hint = str(meta.get("file_name") or f"{m.screen_name}.html")
        await _append(str(m.html_storage_path), name_hint, f"{m.screen_name}.html")

    output_rows = (
        await session.execute(
            text(
                "select distinct on (stage) stage::text as stage, html_path, summary, meta "
                "from public.workflow_outputs where project_id = cast(:pid as uuid) "
                "and deleted_at is null and html_path is not null "
                "order by stage, version desc"
            ),
            {"pid": project_id},
        )
    ).all()
    for o in output_rows:
        meta = _jsonb_dict(o.meta)
        name_hint = str(meta.get("file_name") or f"{o.summary or o.stage}.html")
        await _append(str(o.html_path), name_hint, f"{o.stage}.html")

    # GAP-166: このプロジェクトのファイル成果物 (Excel/PDF 等) も配る。
    # 本人の PC で走る Claude Code がファイルそのものを開いて直せるようにするため。
    files.extend(await _project_file_outputs_seed(session, project_id=project_id))

    # GAP-161: このスレッドの添付資料 (画像/PDF/Excel 等) も作業場へ配る。
    # 本人の PC で走る Claude Code が実物を直接開けるようにするため
    # (サーバー側のテキスト抽出だけでは画像を見られない)。
    files.extend(await _thread_attachment_seed(session, thread_id=str(row.thread_id)))
    return files


_ATTACHMENT_SEED_MAX_FILES = 5
_ATTACHMENT_SEED_MAX_BYTES = 8 * 1024 * 1024


async def _thread_attachment_seed(session: AsyncSession, *, thread_id: str) -> list[dict[str, str]]:
    """直近メッセージの添付を base64 で返す (Bridge が作業場へ書き出す)。

    取得できなかったものは黙って落とす (実行自体は止めない — seed 全体と同じ方針)。
    """
    import base64

    import httpx

    from src.storage_signing import create_signed_download_url

    rows = (
        await session.execute(
            text(
                "select attachments from public.chat_messages "
                "where thread_id = cast(:t as uuid) and deleted_at is null "
                "and attachments is not null "
                "order by created_at desc, id desc limit 6"
            ),
            {"t": thread_id},
        )
    ).all()
    records: list[dict[str, Any]] = []
    for r in rows:
        raw = r.attachments
        items: object = json.loads(raw) if isinstance(raw, str) else raw
        if isinstance(items, list):
            records.extend(
                cast("dict[str, Any]", i)
                for i in cast("list[object]", items)
                if isinstance(i, dict)
            )

    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for rec in records:
        path = str(rec.get("storage_path") or "")
        if not path or path in seen:
            continue
        seen.add(path)
        try:
            url = await create_signed_download_url(path)
            async with httpx.AsyncClient(timeout=20.0) as client:
                res = await client.get(url)
            if res.status_code >= 400 or len(res.content) > _ATTACHMENT_SEED_MAX_BYTES:
                continue
            name = _sanitize_seed_name(
                str(rec.get("file_name") or "attachment"), "attachment", keep_ext=True
            )
            out.append({"file_name": name, "content_b64": base64.b64encode(res.content).decode()})
        except Exception:
            continue
        if len(out) >= _ATTACHMENT_SEED_MAX_FILES:
            break
    return out


async def _persist_answer_for_job(session: AsyncSession, *, job_id: str) -> None:
    """GAP-189: ジョブ確定時に返答をスレッドへ保存する (チャット由来のみ・冪等)。

    thread_id が無いジョブ (モック生成等のシステムジョブ) は会話ではないので
    対象外。保存失敗でジョブ確定自体を壊さない — 保存されなかったことは
    assistant_message_id が null のままなので後から検出できる。
    """
    row = (
        await session.execute(
            text("select thread_id from public.chat_relay_jobs where id = cast(:i as uuid)"),
            {"i": job_id},
        )
    ).first()
    if row is None or row.thread_id is None:
        return
    from src.services import chat_run

    try:
        await chat_run.persist_answer(session, job_id=job_id, thread_id=str(row.thread_id))
    except Exception:  # pragma: no cover  - DB 例外は環境依存
        logger.exception("failed to persist relay answer for job %s", job_id)


async def complete_job(
    session: AsyncSession,
    *,
    job_id: str,
    ok: bool,
    error: str | None = None,
) -> None:
    """running ジョブを done / error で確定する。

    GAP-189: すでに `cancelled` (人が止めた) なら何もしない — Bridge が停止処理を
    終えて報告してきただけなので、エラーにせず静かに受け取る。中断済みの状態を
    done で塗り替えて「完走した」ことにもしない。

    GAP-189: done/error の確定時に**サーバー側で返答をスレッドへ保存する**。
    従来は SSE の generator を抜けた後に保存していたので、生成中にブラウザを
    閉じると PC が最後まで仕事をして chunk も残っているのに、その回の答えだけが
    スレッドから消えていた。保存をブラウザではなくジョブ確定に紐づけて直す。
    """
    job_id = _validated_job_id(job_id)
    status = await _job_status(session, job_id)
    if status is None:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    if status == "cancelled":
        return
    if status != "running":
        raise ChatRelayError("invalid_state", f"job is {status}, not running")
    new_status = "done" if ok else "error"
    await session.execute(
        text(
            "update public.chat_relay_jobs set status = :st, result_error = :er, "
            "finished_at = now() where id = cast(:i as uuid)"
        ),
        {"st": new_status, "er": error, "i": job_id},
    )
    await _persist_answer_for_job(session, job_id=job_id)
    # GAP-134: 未決の承認は timeout で閉じる (SSE が resolved を配ってカードを掃除)
    await session.execute(
        text(
            "update public.chat_relay_approvals set decision = 'timeout', decided_at = now() "
            "where job_id = cast(:i as uuid) and decision = 'pending'"
        ),
        {"i": job_id},
    )
    await _audit(
        session,
        action="chat_relay.complete",
        target_id=job_id,
        after={"status": new_status, **({"error": error} if error else {})},
    )


async def expire_job(session: AsyncSession, *, job_id: str, reason: str) -> None:
    """SSE 側タイムアウト時に queued/running を expired へ落とす (冪等)。"""
    await session.execute(
        text(
            "update public.chat_relay_jobs set status = 'expired', result_error = :r, "
            "finished_at = now() "
            "where id = cast(:i as uuid) and status in ('queued', 'running')"
        ),
        {"r": reason, "i": job_id},
    )
    await _audit(session, action="chat_relay.expire", target_id=job_id, after={"reason": reason})


async def fetch_chunks(
    session: AsyncSession,
    *,
    job_id: str,
    after_seq: int,
) -> list[tuple[int, str, str]]:
    """after_seq より後の chunk を (seq, kind, content) の昇順で返す。"""
    res = await session.execute(
        text(
            "select seq, kind, content from public.chat_relay_chunks "
            "where job_id = cast(:j as uuid) and seq > :s order by seq"
        ),
        {"j": job_id, "s": after_seq},
    )
    return [(int(r.seq), str(r.kind), str(r.content)) for r in res.all()]


# ── GAP-134: PC 操作の承認往復 (Bridge ⇄ サーバー ⇄ ユーザー) ────────


async def create_approval(session: AsyncSession, *, job_id: str, tool: str, summary: str) -> str:
    """Bridge が CLI の許可要求を受けて承認行を作る (pending)。"""
    job_id = _validated_job_id(job_id)
    status = await _job_status(session, job_id)
    if status is None:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    if status != "running":
        raise ChatRelayError("invalid_state", f"job is {status}, not running")
    res = await session.execute(
        text(
            "insert into public.chat_relay_approvals (job_id, tool, summary) "
            "values (cast(:j as uuid), :t, :s) returning id"
        ),
        {"j": job_id, "t": tool, "s": summary[:500]},
    )
    approval_id = str(res.scalar_one())
    await _audit(
        session,
        action="chat_relay.approval_request",
        target_id=approval_id,
        after={"job_id": job_id, "tool": tool},
    )
    return approval_id


async def approval_decision(session: AsyncSession, *, job_id: str, approval_id: str) -> str:
    """Bridge がポーリングする決定 (pending/allow/deny/timeout)。"""
    res = await session.execute(
        text(
            "select decision from public.chat_relay_approvals "
            "where id = cast(:a as uuid) and job_id = cast(:j as uuid)"
        ),
        {"a": _validated_job_id(approval_id), "j": _validated_job_id(job_id)},
    )
    row = res.first()
    if row is None:
        raise ChatRelayError("not_found", f"approval {approval_id} not found")
    return str(row.decision)


async def list_job_approvals(session: AsyncSession, *, job_id: str) -> list[dict[str, str]]:
    """job の承認行を作成順で返す (SSE が pending の出現/解決を検知する)。"""
    res = await session.execute(
        text(
            "select id, tool, summary, decision from public.chat_relay_approvals "
            "where job_id = cast(:j as uuid) order by created_at"
        ),
        {"j": job_id},
    )
    return [
        {
            "id": str(r.id),
            "tool": str(r.tool),
            "summary": str(r.summary),
            "decision": str(r.decision),
        }
        for r in res.all()
    ]


async def resolve_approval_for_user(
    session: AsyncSession, *, approval_id: str, user_id: str, decision: str
) -> bool:
    """ユーザーの決定 (allow/deny) を承認行へ書く。

    本人の job に紐づく pending の行のみ更新できる (他人の承認 ID や解決済みは
    False — 呼出側は 404 にする)。service セッションで呼ぶこと (RLS は
    default deny で UPDATE policy を作っていない)。
    """
    if decision not in ("allow", "deny"):
        return False
    try:
        validated = _validated_job_id(approval_id)
    except ChatRelayError:
        return False
    res = await session.execute(
        text(
            "update public.chat_relay_approvals a set decision = :d, decided_at = now() "
            "where a.id = cast(:a as uuid) and a.decision = 'pending' "
            "and exists ("
            "  select 1 from public.chat_relay_jobs j "
            "  where j.id = a.job_id and j.requested_by = cast(:u as uuid)"
            ") returning a.id"
        ),
        {"d": decision, "a": validated, "u": user_id},
    )
    ok = res.first() is not None
    if ok:
        await _audit(
            session,
            action="chat_relay.approval_decision",
            target_id=validated,
            after={"decision": decision},
        )
    return ok


async def job_result(session: AsyncSession, *, job_id: str) -> tuple[str, str | None]:
    """(status, result_error) を返す。存在しなければ not_found。"""
    res = await session.execute(
        text("select status, result_error from public.chat_relay_jobs where id = cast(:i as uuid)"),
        {"i": job_id},
    )
    row = res.first()
    if row is None:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    return str(row.status), None if row.result_error is None else str(row.result_error)


# ── GAP-119: Claude プラン接続の状態表示 ────────────────────────

_RATE_LIMIT_STATUSES = ("allowed", "allowed_warning", "rejected")


async def plan_limit_reached(session: AsyncSession, *, user_id: str) -> bool:
    """GAP-184: この人の Claude プラン枠が今「上限到達」かどうか。

    Bridge が実行中に観測した rate_limit_event の実値だけを見る (推測しない)。
    上限は必ずリセットされるので、これが True の失敗を「恒久的な失敗」として
    確定させてはいけない — 呼び出し側は保留して後で再試行する。
    """
    row = (
        await session.execute(
            text(
                "select status, five_hour_resets_at, seven_day_resets_at "
                "from public.chat_plan_status where user_id = cast(:u as uuid)"
            ),
            {"u": user_id},
        )
    ).first()
    if row is None or str(row.status) != "rejected":
        return False
    # リセット時刻を過ぎていれば、もう上限ではない (古い観測を引きずらない)
    from datetime import UTC, datetime

    now = datetime.now(tz=UTC)
    resets = [r for r in (row.five_hour_resets_at, row.seven_day_resets_at) if r is not None]
    return not (resets and all(r <= now for r in resets))


async def record_plan_status(
    session: AsyncSession,
    *,
    job_id: str,
    observations: list[dict[str, Any]],
) -> None:
    """Bridge が返送した rate_limit_event 観測値を job の本人へ upsert する。"""
    job_id = _validated_job_id(job_id)
    res = await session.execute(
        text("select requested_by from public.chat_relay_jobs where id = cast(:i as uuid)"),
        {"i": job_id},
    )
    row = res.first()
    if row is None:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    await record_plan_status_for_user(
        session, user_id=str(row.requested_by), observations=observations
    )


async def record_plan_status_for_user(
    session: AsyncSession,
    *,
    user_id: str,
    observations: list[dict[str, Any]],
) -> None:
    """rate_limit_event 観測値を本人の chat_plan_status へ upsert する。

    値は claude CLI が実行中に発行した実値のみ (推測で補完しない)。
    five_hour / seven_day 以外の window は overall status にだけ寄与する。
    観測が空・不正のみなら何も書かない (誠実: 無いものは無いまま)。
    relay (GAP-119) と agent_sdk (GAP-124) の両経路がここに合流する。
    """
    worst = -1
    fields: dict[str, Any] = {
        "five_hour_utilization": None,
        "five_hour_resets_at": None,
        "seven_day_utilization": None,
        "seven_day_resets_at": None,
    }
    for obs in observations:
        status = obs.get("status")
        if status not in _RATE_LIMIT_STATUSES:
            continue
        worst = max(worst, _RATE_LIMIT_STATUSES.index(str(status)))
        window = obs.get("rate_limit_type")
        if window not in ("five_hour", "seven_day"):
            continue
        utilization = obs.get("utilization")
        if isinstance(utilization, int | float) and 0 <= float(utilization) <= 2:
            fields[f"{window}_utilization"] = float(utilization)
        resets_at = obs.get("resets_at")
        if isinstance(resets_at, int | float) and resets_at > 0:
            fields[f"{window}_resets_at"] = float(resets_at)
    if worst < 0:
        return

    await session.execute(
        text(
            "insert into public.chat_plan_status "
            "(user_id, status, five_hour_utilization, five_hour_resets_at, "
            " seven_day_utilization, seven_day_resets_at, observed_at) "
            "values (cast(:u as uuid), :st, :fu, to_timestamp(:fr), :su, to_timestamp(:sr), now()) "
            "on conflict (user_id) do update set "
            "status = excluded.status, "
            "five_hour_utilization = excluded.five_hour_utilization, "
            "five_hour_resets_at = excluded.five_hour_resets_at, "
            "seven_day_utilization = excluded.seven_day_utilization, "
            "seven_day_resets_at = excluded.seven_day_resets_at, "
            "observed_at = now()"
        ),
        {
            "u": user_id,
            "st": _RATE_LIMIT_STATUSES[worst],
            "fu": fields["five_hour_utilization"],
            "fr": fields["five_hour_resets_at"],
            "su": fields["seven_day_utilization"],
            "sr": fields["seven_day_resets_at"],
        },
    )


async def connection_status(session: AsyncSession, *, user_id: str) -> dict[str, Any]:
    """S-E01 接続状態パネル用の実測値を返す (取れない値は null のまま)。

    - workers: presence 鮮度内 (90 秒) の Bridge (host/version/last_seen_at)
    - last_job: 本人の直近 relay 実行 (status/created_at/finished_at/error)
    - plan: 本人の直近プラン枠観測 (chat_plan_status — 無ければ null)
    """
    # GAP-122: 自分の worker (user_id = 本人) と インスタンス worker (user_id null)
    # のみを見せる — 他ユーザーの Bridge は自分の接続状態ではない
    workers_res = await session.execute(
        text(
            "select host_label, version, last_seen_at from public.bridge_workers "
            "where last_seen_at > now() - make_interval(secs => :fresh) "
            "and (user_id is null or user_id = cast(:u as uuid)) "
            "order by last_seen_at desc limit 10"
        ),
        {"fresh": PRESENCE_FRESH_SECONDS, "u": user_id},
    )
    workers = [
        {
            "host_label": str(r.host_label),
            "version": str(r.version),
            "last_seen_at": r.last_seen_at.isoformat(),
        }
        for r in workers_res.all()
    ]

    job_res = await session.execute(
        text(
            "select status, result_error, created_at, finished_at "
            "from public.chat_relay_jobs where requested_by = cast(:u as uuid) "
            "order by created_at desc limit 1"
        ),
        {"u": user_id},
    )
    job_row = job_res.first()
    last_job = (
        None
        if job_row is None
        else {
            "status": str(job_row.status),
            "error": None if job_row.result_error is None else str(job_row.result_error),
            "created_at": job_row.created_at.isoformat(),
            "finished_at": (
                None if job_row.finished_at is None else job_row.finished_at.isoformat()
            ),
        }
    )

    plan_res = await session.execute(
        text(
            "select status, five_hour_utilization, five_hour_resets_at, "
            "seven_day_utilization, seven_day_resets_at, observed_at "
            "from public.chat_plan_status where user_id = cast(:u as uuid)"
        ),
        {"u": user_id},
    )
    plan_row = plan_res.first()
    plan = (
        None
        if plan_row is None
        else {
            "status": str(plan_row.status),
            "five_hour_utilization": (
                None
                if plan_row.five_hour_utilization is None
                else float(plan_row.five_hour_utilization)
            ),
            "five_hour_resets_at": (
                None
                if plan_row.five_hour_resets_at is None
                else plan_row.five_hour_resets_at.isoformat()
            ),
            "seven_day_utilization": (
                None
                if plan_row.seven_day_utilization is None
                else float(plan_row.seven_day_utilization)
            ),
            "seven_day_resets_at": (
                None
                if plan_row.seven_day_resets_at is None
                else plan_row.seven_day_resets_at.isoformat()
            ),
            "observed_at": plan_row.observed_at.isoformat(),
        }
    )

    return {
        "bridge_online": len(workers) > 0,
        "workers": workers,
        "last_job": last_job,
        "plan": plan,
    }


_FILE_OUTPUT_SEED_MAX = 5


async def _project_file_outputs_seed(
    session: AsyncSession, *, project_id: str
) -> list[dict[str, str]]:
    """ファイル成果物 (filedb) の最新版を base64 で配る (GAP-166)。

    ファイル名ごとの最新版のみ。読めなかったものは黙って落とす (実行は止めない)。
    """
    import base64

    from src.services.mocks.artifacts import FILEDB_PREFIX, fetch_file_content

    rows = (
        await session.execute(
            text(
                "select distinct on (summary) summary, html_path "
                "from public.workflow_outputs "
                "where project_id = cast(:p as uuid) and deleted_at is null "
                "and html_path like 'filedb://%' "
                "order by summary, version desc"
            ),
            {"p": project_id},
        )
    ).all()
    out: list[dict[str, str]] = []
    for r in rows:
        path = str(r.html_path)
        try:
            found = await fetch_file_content(session, file_id=path[len(FILEDB_PREFIX) :])
        except Exception:
            continue
        if found is None:
            continue
        data, _mime, file_name = found
        if len(data) > _ATTACHMENT_SEED_MAX_BYTES:
            continue
        name = _sanitize_seed_name(file_name, "output", keep_ext=True)
        out.append({"file_name": name, "content_b64": base64.b64encode(data).decode()})
        if len(out) >= _FILE_OUTPUT_SEED_MAX:
            break
    return out
