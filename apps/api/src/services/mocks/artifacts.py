"""GAP-137: チャット成果物 (HTML) のモック取り込み + DB 内蔵モック HTML (mockdb)。

確定アーキテクチャ: 成果物の正本は SaaS 側 (ツール内)。ユーザー PC の
~/AtelierChatWork は AI の作業場 (scratch) であり、そこで生まれた HTML は
本モジュール経由でモックストア (mocks + mock_contents) に取り込まれて
初めて「プロジェクトの成果物」になる。

mockdb:// スキーム:
    Supabase Storage が未設定の環境 (ローカル開発など) でもモックの
    保存・閲覧を成立させるため、HTML を public.mock_contents (RLS default
    deny — service 経路のみ) に保存し、mocks.html_storage_path には
    'mockdb://{content_id}' を置く。閲覧は自己署名トークン付き
    GET /mocks/{mock_id}/content (routes/mocks) が配信する — Supabase の
    署名付き URL と同じ「期限付き URL」契約を自前で満たす。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import time
import uuid
from functools import lru_cache
from typing import TypedDict

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.audit import AuditEvent, AuditWriter
from src.db.session import create_engine, create_session_factory

MOCKDB_PREFIX = "mockdb://"

# 取り込み上限 (1 ジョブあたり)。超過分は誠実に拒否する (黙って捨てない)。
MAX_ARTIFACTS_PER_JOB = 10
MAX_HTML_BYTES = 512 * 1024

# 自己署名 URL の有効期限 (Supabase 署名 URL と同水準)
CONTENT_URL_TTL_S = 600


class ArtifactIngestError(Exception):
    """取り込みの構造的失敗 (code: too_large / too_many / no_project)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class IngestedMock(TypedDict):
    mock_id: str
    screen_name: str
    version: int


_TITLE_RE = re.compile(r"<title[^>]*>\s*(.*?)\s*</title>", re.IGNORECASE | re.DOTALL)


def derive_screen_name(file_name: str, html: str) -> str:
    """画面名を決める: <title> があればそれ、無ければファイル名 (拡張子抜き)。

    80 文字に丸める (mocks.screen_name は自由 text だが UI の見出しに使う)。
    """
    m = _TITLE_RE.search(html)
    title = (m.group(1) if m else "").strip()
    if title == "":
        title = re.sub(r"\.html?$", "", file_name.rsplit("/", 1)[-1], flags=re.IGNORECASE)
    title = title.strip() or "untitled"
    return title[:80]


@lru_cache(maxsize=1)
def service_session_factory() -> async_sessionmaker[AsyncSession]:
    """mock_contents (RLS default deny) の読み書き用 service session。

    RLS session (JWT ロール) からは mock_contents に触れない — mocks 行の
    認可は RLS で確認しつつ、コンテンツ実体はこの factory で扱う (GAP-138)。
    """
    return create_session_factory(create_engine())


async def store_content_service(html: str) -> str:
    """service session で mock_contents に保存して content_id を返す (commit 込み)。"""
    factory = service_session_factory()
    async with factory() as session:
        content_id = await store_mock_content(session, html=html)
        await session.commit()
    return content_id


async def fetch_content_service(content_id: str) -> str | None:
    """service session で mockdb コンテンツを読む。"""
    factory = service_session_factory()
    async with factory() as session:
        return await fetch_mock_content(session, content_id=content_id)


async def store_mock_content(session: AsyncSession, *, html: str) -> str:
    """HTML を mock_contents へ保存し content_id を返す。"""
    res = await session.execute(
        text("insert into public.mock_contents (html) values (:h) returning id"),
        {"h": html},
    )
    return str(res.scalar_one())


async def fetch_mock_content(session: AsyncSession, *, content_id: str) -> str | None:
    """mockdb コンテンツの HTML を取得する (無ければ None)。"""
    try:
        cid = str(uuid.UUID(content_id))
    except ValueError:
        return None
    res = await session.execute(
        text("select html from public.mock_contents where id = cast(:i as uuid)"),
        {"i": cid},
    )
    row = res.first()
    return None if row is None else str(row.html)


async def ingest_html_artifact(
    session: AsyncSession,
    *,
    project_id: str,
    file_name: str,
    html: str,
    source: str,
    actor_label: str,
) -> IngestedMock:
    """HTML 1 件をモックとして取り込む。

    同一 project + screen_name の既存モックがあれば新バージョン
    (parent_mock_id 連鎖 — S-H01 のバージョン履歴にそのまま乗る)、
    無ければ version 1 の新規モック。
    """
    if len(html.encode("utf-8")) > MAX_HTML_BYTES:
        raise ArtifactIngestError(
            "too_large", f"{file_name}: HTML が上限 {MAX_HTML_BYTES // 1024}KB を超えています"
        )
    screen_name = derive_screen_name(file_name, html)
    content_id = await store_mock_content(session, html=html)

    latest = (
        await session.execute(
            text(
                "select id, version from public.mocks "
                "where project_id = cast(:pid as uuid) and screen_name = :sn "
                "and deleted_at is null "
                "order by version desc limit 1"
            ),
            {"pid": project_id, "sn": screen_name},
        )
    ).first()
    version = 1 if latest is None else int(latest.version) + 1
    parent_id = None if latest is None else str(latest.id)

    new_id = str(uuid.uuid4())
    # GAP-152: 取り込みは常に active フェーズへ (確定フェーズには何も足せない)
    from src.services.flow.phases import ensure_active_phase

    phase = await ensure_active_phase(session, project_id=project_id)
    # GAP-155: (project, 画面, version) 一意。Bridge 取り込みは新規ファイル由来で
    # lost update の意味論が無いため、衝突時は version を採り直してリトライする
    # (人間の改訂と違い 409 で止める相手がいない)。
    for _attempt in range(3):
        try:
            async with session.begin_nested():
                await session.execute(
                    text(
                        "insert into public.mocks "
                        "(id, project_id, screen_name, html_storage_path, version, "
                        " parent_mock_id, delivery_phase_id, meta_tags) "
                        "values (cast(:id as uuid), cast(:pid as uuid), :sn, :path, :ver, "
                        "        cast(:parent as uuid), cast(:dph as uuid), cast(:meta as jsonb))"
                    ),
                    {
                        "id": new_id,
                        "pid": project_id,
                        "sn": screen_name,
                        "path": f"{MOCKDB_PREFIX}{content_id}",
                        "ver": version,
                        "parent": parent_id,
                        "dph": phase.id,
                        "meta": json.dumps(
                            {"author": actor_label, "source": source, "file_name": file_name}
                        ),
                    },
                )
            break
        except IntegrityError:
            row2 = (
                await session.execute(
                    text(
                        "select id, version from public.mocks "
                        "where project_id = cast(:pid as uuid) and screen_name = :sn "
                        "and deleted_at is null order by version desc limit 1"
                    ),
                    {"pid": project_id, "sn": screen_name},
                )
            ).first()
            version = 1 if row2 is None else int(row2.version) + 1
            parent_id = None if row2 is None else str(row2.id)
    else:
        raise ArtifactIngestError("conflict", f"{file_name}: 同時取り込みが競合しました")
    await AuditWriter(session).write(
        AuditEvent(
            action="mock.ingest_artifact",
            target_type="mock",
            actor_type="system",
            actor_id=actor_label,
            target_id=new_id,
            after={"screen_name": screen_name, "version": version, "source": source},
        )
    )
    return {"mock_id": new_id, "screen_name": screen_name, "version": version}


# ── GAP-139: 成果物の自動仕分け (モック / 提案書・見積 等) ────────────
#
# HTML だから何でもモック、は誤り (経営者指摘)。見積・提案書・テスト仕様書
# なども HTML で作られるため、種類を判定して適切なストアへ入れる:
#   - mock            → mocks (画面モック)
#   - それ以外の stage → workflow_outputs (S-G01 成果物 — 既存の stage 体系)
#
# 判定は決定的なキーワード規則 (LLM は使わない — 取り込みは Bridge の
# complete 直前の同期処理で、relay に再入すると自分のジョブ完了を
# 待ち合ってデッドロックするため)。優先順は「文書自身のタイトル →
# ファイル名 → 直近のユーザー指示」— 文書自身の宣言が最も信頼できる。

ARTIFACT_KIND_MOCK = "mock"

_STAGE_RULES: list[tuple[str, str]] = [
    (r"見積", "estimate"),
    (r"提案", "proposal"),
    (r"請求", "invoice"),
    (r"NDA|秘密保持", "nda"),
    (r"契約", "contract"),
    (r"テスト仕様|試験仕様|テスト計画|テストケース", "verification"),
    (r"要件定義|要求仕様", "requirements"),
    (r"議事録", "hearing"),
]

# 英語ファイル名の対応 (quote.html / proposal.html 等)
_STAGE_RULES_FILENAME: list[tuple[str, str]] = [
    (r"estimate|quote", "estimate"),
    (r"proposal", "proposal"),
    (r"invoice", "invoice"),
    (r"nda", "nda"),
    (r"contract", "contract"),
    (r"test[-_]?(spec|plan|case)", "verification"),
    (r"requirements?", "requirements"),
]

STAGE_LABELS: dict[str, str] = {
    "estimate": "見積書",
    "proposal": "提案書",
    "invoice": "請求書",
    "nda": "NDA",
    "contract": "契約書",
    "verification": "テスト仕様書",
    "requirements": "要件定義書",
    "hearing": "議事録",
}


def extract_latest_user_message(prompt: str) -> str:
    """fold_prompt 形式から直近のユーザーメッセージ部分を取り出す。

    履歴に「見積」等が混ざっていても直近の依頼だけを判定材料にするため。
    """
    marker = "新しいユーザーメッセージ (これに応答する): "
    return prompt.rsplit(marker, 1)[-1] if marker in prompt else prompt


def classify_artifact(*, file_name: str, html: str, instruction: str) -> str:
    """成果物の種類を判定する。返り値: 'mock' または workflow stage 名。"""
    m = _TITLE_RE.search(html)
    title = (m.group(1) if m else "").strip()
    for pattern, stage in _STAGE_RULES:
        if re.search(pattern, title, re.IGNORECASE):
            return stage
    base = file_name.rsplit("/", 1)[-1]
    for pattern, stage in _STAGE_RULES_FILENAME:
        if re.search(pattern, base, re.IGNORECASE):
            return stage
    for pattern, stage in _STAGE_RULES:
        if re.search(pattern, base, re.IGNORECASE):
            return stage
    latest = extract_latest_user_message(instruction)[-500:]
    for pattern, stage in _STAGE_RULES:
        if re.search(pattern, latest, re.IGNORECASE):
            return stage
    return ARTIFACT_KIND_MOCK


async def ingest_html_output(
    session: AsyncSession,
    *,
    project_id: str,
    file_name: str,
    html: str,
    stage: str,
    source: str,
    actor_label: str,
) -> dict[str, object]:
    """HTML 1 件を成果物 (workflow_outputs) として取り込む。

    同一 project + stage の既存成果物があれば新バージョン。HTML 実体は
    mockdb ストア (mocks と共用) — Storage 未設定でも閲覧できる。
    """
    if len(html.encode("utf-8")) > MAX_HTML_BYTES:
        raise ArtifactIngestError(
            "too_large", f"{file_name}: HTML が上限 {MAX_HTML_BYTES // 1024}KB を超えています"
        )
    title = derive_screen_name(file_name, html)
    content_id = await store_mock_content(session, html=html)
    version = int(
        (
            await session.execute(
                text(
                    "select coalesce(max(version), 0) + 1 from public.workflow_outputs "
                    "where project_id = cast(:pid as uuid) and stage = cast(:st as workflow_stage_enum) "
                    "and deleted_at is null"
                ),
                {"pid": project_id, "st": stage},
            )
        ).scalar_one()
    )
    new_id = str(uuid.uuid4())
    # GAP-152: 取り込みは常に active フェーズへ
    from src.services.flow.phases import ensure_active_phase

    phase = await ensure_active_phase(session, project_id=project_id)
    # GAP-155: (project, stage, file_name, version) 一意。Bridge 取り込みは
    # 新規ファイル由来で lost update の意味論が無いため、衝突時は version を
    # 採り直してリトライする (人間の改訂と違い 409 で止める相手がいない)。
    for _attempt in range(3):
        try:
            async with session.begin_nested():
                await session.execute(
                    text(
                        "insert into public.workflow_outputs "
                        "(id, project_id, stage, html_path, summary, version, "
                        " delivery_phase_id, meta) "
                        "values (cast(:id as uuid), cast(:pid as uuid), "
                        "        cast(:st as workflow_stage_enum), "
                        "        :path, :summary, :ver, cast(:dph as uuid), "
                        "        cast(:meta as jsonb))"
                    ),
                    {
                        "id": new_id,
                        "pid": project_id,
                        "st": stage,
                        "path": f"{MOCKDB_PREFIX}{content_id}",
                        "summary": title,
                        "ver": version,
                        "dph": phase.id,
                        "meta": json.dumps(
                            {"author": actor_label, "source": source, "file_name": file_name}
                        ),
                    },
                )
            break
        except IntegrityError:
            version = int(
                (
                    await session.execute(
                        text(
                            "select coalesce(max(version), 0) + 1 "
                            "from public.workflow_outputs "
                            "where project_id = cast(:pid as uuid) "
                            "and stage = cast(:st as workflow_stage_enum) "
                            "and deleted_at is null"
                        ),
                        {"pid": project_id, "st": stage},
                    )
                ).scalar_one()
            )
    else:
        raise ArtifactIngestError("conflict", f"{file_name}: 同時取り込みが競合しました")
    await AuditWriter(session).write(
        AuditEvent(
            action="output.ingest_artifact",
            target_type="workflow_output",
            actor_type="system",
            actor_id=actor_label,
            target_id=new_id,
            after={"stage": stage, "version": version, "source": source},
        )
    )
    return {
        "type": "output",
        "output_id": new_id,
        "stage": stage,
        "title": title,
        "version": version,
    }


# ── GAP-145: HTML 以外の成果物 (画像 / PPTX / PDF / Excel / 動画 等) ──────
#
# 実行エンジン (本人 PC の Bridge + claude CLI) は HTML と同じ — 拾って
# 保管・配信する配線が無かっただけ (経営者指摘)。バイナリ実体は
# artifact_files (RLS default deny) に置き、workflow_outputs.html_path に
# 'filedb://{id}' を記録する。配信は自己署名 URL (mockdb と同じ契約)。

FILEDB_PREFIX = "filedb://"
MAX_FILE_BYTES = 8 * 1024 * 1024

# 取り込み対象の拡張子 → (種類, MIME)。ここに無い拡張子は取り込まない
# (Bridge 側も同じ一覧でフィルタする — サーバは送信値の MIME を信用しない)。
FILE_TYPES: dict[str, tuple[str, str]] = {
    "png": ("image", "image/png"),
    "jpg": ("image", "image/jpeg"),
    "jpeg": ("image", "image/jpeg"),
    "gif": ("image", "image/gif"),
    "webp": ("image", "image/webp"),
    "svg": ("image", "image/svg+xml"),
    "pdf": ("pdf", "application/pdf"),
    "pptx": ("slides", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    "ppt": ("slides", "application/vnd.ms-powerpoint"),
    "xlsx": ("sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    "xls": ("sheet", "application/vnd.ms-excel"),
    "csv": ("sheet", "text/csv"),
    "docx": ("doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "doc": ("doc", "application/msword"),
    "mp4": ("video", "video/mp4"),
    "webm": ("video", "video/webm"),
    "mov": ("video", "video/quicktime"),
}

FILE_KIND_LABELS: dict[str, str] = {
    "image": "画像",
    "pdf": "PDF",
    "slides": "スライド",
    "sheet": "表計算",
    "doc": "文書",
    "video": "動画",
}


def file_type_for(file_name: str) -> tuple[str, str] | None:
    """拡張子から (種類, MIME) を引く。対象外は None。"""
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    return FILE_TYPES.get(ext)


def classify_file_stage(*, file_name: str, instruction: str, file_kind: str) -> str:
    """バイナリ成果物の stage を決める (HTML と同じ決定的規則)。

    ファイル名 → 直近ユーザー指示の順でキーワード判定し、どれにも
    当たらなければ 画像/動画 は design、その他は delivery (納品物)。
    """
    base = file_name.rsplit("/", 1)[-1]
    for pattern, stage in _STAGE_RULES_FILENAME:
        if re.search(pattern, base, re.IGNORECASE):
            return stage
    for pattern, stage in _STAGE_RULES:
        if re.search(pattern, base, re.IGNORECASE):
            return stage
    latest = extract_latest_user_message(instruction)[-500:]
    for pattern, stage in _STAGE_RULES:
        if re.search(pattern, latest, re.IGNORECASE):
            return stage
    return "design" if file_kind in ("image", "video") else "delivery"


async def store_file_content(
    session: AsyncSession, *, data: bytes, mime: str, file_name: str
) -> str:
    """バイナリを artifact_files へ保存し file_id を返す。"""
    res = await session.execute(
        text(
            "insert into public.artifact_files (data, mime, file_name, byte_size) "
            "values (:d, :m, :n, :s) returning id"
        ),
        {"d": data, "m": mime, "n": file_name, "s": len(data)},
    )
    return str(res.scalar_one())


async def fetch_file_content(
    session: AsyncSession, *, file_id: str
) -> tuple[bytes, str, str] | None:
    """filedb コンテンツを (bytes, mime, file_name) で返す (無ければ None)。"""
    try:
        fid = str(uuid.UUID(file_id))
    except ValueError:
        return None
    res = await session.execute(
        text("select data, mime, file_name from public.artifact_files where id = cast(:i as uuid)"),
        {"i": fid},
    )
    row = res.first()
    return None if row is None else (bytes(row.data), str(row.mime), str(row.file_name))


async def ingest_file_artifact(
    session: AsyncSession,
    *,
    project_id: str,
    file_name: str,
    data: bytes,
    source: str,
    actor_label: str,
    instruction: str,
) -> dict[str, object]:
    """バイナリ成果物 1 件を workflow_outputs として取り込む。

    バージョンは同一 project + stage + ファイル名で連鎖 (logo.png v1, v2, …)。
    HTML の stage 連鎖と違いファイル名を鍵に含めるのは、画像などは同一 stage に
    複数の独立ファイル (logo.png / hero.png) が並ぶのが普通のため。
    """
    ftype = file_type_for(file_name)
    if ftype is None:
        raise ArtifactIngestError("unsupported", f"{file_name}: 対応していない形式です")
    file_kind, mime = ftype
    if len(data) > MAX_FILE_BYTES:
        raise ArtifactIngestError(
            "too_large",
            f"{file_name}: ファイルが上限 {MAX_FILE_BYTES // (1024 * 1024)}MB を超えています",
        )
    stage = classify_file_stage(file_name=file_name, instruction=instruction, file_kind=file_kind)
    base_name = file_name.rsplit("/", 1)[-1][:200]
    file_id = await store_file_content(session, data=data, mime=mime, file_name=base_name)
    version = int(
        (
            await session.execute(
                text(
                    "select coalesce(max(version), 0) + 1 from public.workflow_outputs "
                    "where project_id = cast(:pid as uuid) "
                    "and stage = cast(:st as workflow_stage_enum) "
                    "and meta ->> 'file_name' = :fn and deleted_at is null"
                ),
                {"pid": project_id, "st": stage, "fn": base_name},
            )
        ).scalar_one()
    )
    new_id = str(uuid.uuid4())
    # GAP-152: 取り込みは常に active フェーズへ
    from src.services.flow.phases import ensure_active_phase

    phase = await ensure_active_phase(session, project_id=project_id)
    # GAP-155: 一意制約下の Bridge 取り込みは衝突時 version 採り直しでリトライ
    for _attempt in range(3):
        try:
            async with session.begin_nested():
                await session.execute(
                    text(
                        "insert into public.workflow_outputs "
                        "(id, project_id, stage, html_path, summary, version, "
                        " delivery_phase_id, meta) "
                        "values (cast(:id as uuid), cast(:pid as uuid), "
                        "        cast(:st as workflow_stage_enum), "
                        "        :path, :summary, :ver, cast(:dph as uuid), "
                        "        cast(:meta as jsonb))"
                    ),
                    {
                        "id": new_id,
                        "pid": project_id,
                        "st": stage,
                        "path": f"{FILEDB_PREFIX}{file_id}",
                        "summary": base_name,
                        "ver": version,
                        "dph": phase.id,
                        "meta": json.dumps(
                            {
                                "author": actor_label,
                                "source": source,
                                "file_name": base_name,
                                "file_kind": file_kind,
                                "mime": mime,
                                "byte_size": len(data),
                            }
                        ),
                    },
                )
            break
        except IntegrityError:
            version = int(
                (
                    await session.execute(
                        text(
                            "select coalesce(max(version), 0) + 1 "
                            "from public.workflow_outputs "
                            "where project_id = cast(:pid as uuid) "
                            "and stage = cast(:st as workflow_stage_enum) "
                            "and meta ->> 'file_name' = :fn and deleted_at is null"
                        ),
                        {"pid": project_id, "st": stage, "fn": base_name},
                    )
                ).scalar_one()
            )
    else:
        raise ArtifactIngestError("conflict", f"{base_name}: 同時取り込みが競合しました")
    await AuditWriter(session).write(
        AuditEvent(
            action="output.ingest_file",
            target_type="workflow_output",
            actor_type="system",
            actor_id=actor_label,
            target_id=new_id,
            after={
                "stage": stage,
                "version": version,
                "source": source,
                "file_kind": file_kind,
            },
        )
    )
    return {
        "type": "file",
        "output_id": new_id,
        "stage": stage,
        "title": base_name,
        "version": version,
        "file_kind": file_kind,
    }


# ── GAP-142: Open Design 型の要素選択 (プレビュー内クリック → 親へ通知) ──
#
# mockdb 配信 HTML に ?sel=1 のときだけ注入する軽量スクリプト。
# hover で紫の点線ハイライト、クリックで既定動作を止めて parent へ
# postMessage({type:'atelier-element-selected', selector, label, html})。
# iframe は API オリジン (web とは別オリジン) なので親 DOM には触れない —
# 通信は postMessage のみ (安全)。

SELECTION_SCRIPT = (
    "<script data-atelier-select>(function(){"
    "var cur=null;"
    "var st=document.createElement('style');"
    "st.textContent='.__atsel{outline:2px dashed #7c3aed !important;"
    "outline-offset:2px;cursor:crosshair !important}';"
    "document.head.appendChild(st);"
    "function lbl(el){var t=(el.innerText||'').trim().replace(/\\s+/g,' ').slice(0,40);"
    "return '<'+el.tagName.toLowerCase()+'>'+(t?' '+t:'');}"
    "function sel(el){var p=[],e=el;"
    "while(e&&e.nodeType===1&&p.length<5&&e.tagName!=='BODY'){"
    "var tg=e.tagName.toLowerCase();var par=e.parentElement;var idx=1;"
    "if(par){var sib=par.children;var n=0;for(var i=0;i<sib.length;i++){"
    "if(sib[i].tagName===e.tagName){n++;if(sib[i]===e){idx=n;}}}}"
    "p.unshift(e.id?tg+'#'+e.id:tg+':nth-of-type('+idx+')');"
    "if(e.id)break;e=par;}return p.join(' > ');}"
    "document.addEventListener('mouseover',function(ev){"
    "if(cur&&cur.classList)cur.classList.remove('__atsel');cur=ev.target;"
    "if(cur&&cur.classList)cur.classList.add('__atsel');},true);"
    "document.addEventListener('click',function(ev){"
    "ev.preventDefault();ev.stopPropagation();var el=ev.target;"
    "parent.postMessage({type:'atelier-element-selected',"
    "selector:sel(el),label:lbl(el),html:(el.outerHTML||'').slice(0,600)},'*');"
    "},true);"
    "})();</script>"
)


def inject_selection_script(html: str) -> str:
    """</body> の直前 (無ければ末尾) に要素選択スクリプトを注入する。"""
    lower = html.lower()
    idx = lower.rfind("</body>")
    if idx < 0:
        return html + SELECTION_SCRIPT
    return html[:idx] + SELECTION_SCRIPT + html[idx:]


# ── mockdb 閲覧 URL の自己署名 (routes/mocks が使う) ────────────────


def _signing_secret() -> bytes:
    secret = os.environ.get("ATELIER_AUTH_JWT_SECRET", "")
    if secret == "":
        raise ArtifactIngestError("unconfigured", "ATELIER_AUTH_JWT_SECRET is required")
    return secret.encode("utf-8")


def sign_content_token(mock_id: str, expires_at: int) -> str:
    """mock_id + 期限に対する HMAC トークン (URL クエリに載せる)。"""
    payload = f"{mock_id}.{expires_at}".encode()
    return hmac.new(_signing_secret(), payload, hashlib.sha256).hexdigest()


def verify_content_token(mock_id: str, expires_at: int, token: str) -> bool:
    """トークン検証 (期限切れ・改竄は False — 理由は呼び出し側で 403 に落とす)。"""
    if expires_at < int(time.time()):
        return False
    expected = sign_content_token(mock_id, expires_at)
    return hmac.compare_digest(expected, token)


def build_content_url(base_url: str, mock_id: str, *, resource: str = "mocks") -> str:
    """自己署名の閲覧 URL を組み立てる (TTL は Supabase 署名 URL と同水準)。

    GAP-139: resource="outputs" で成果物 (workflow_outputs) の mockdb 配信にも使う。
    """
    exp = int(time.time()) + CONTENT_URL_TTL_S
    sig = sign_content_token(mock_id, exp)
    return f"{base_url.rstrip('/')}/{resource}/{mock_id}/content?exp={exp}&sig={sig}"
