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
    await session.execute(
        text(
            "insert into public.mocks "
            "(id, project_id, screen_name, html_storage_path, version, parent_mock_id, meta_tags) "
            "values (cast(:id as uuid), cast(:pid as uuid), :sn, :path, :ver, "
            "        cast(:parent as uuid), cast(:meta as jsonb))"
        ),
        {
            "id": new_id,
            "pid": project_id,
            "sn": screen_name,
            "path": f"{MOCKDB_PREFIX}{content_id}",
            "ver": version,
            "parent": parent_id,
            "meta": json.dumps(
                {"author": actor_label, "source": source, "file_name": file_name}
            ),
        },
    )
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
    await session.execute(
        text(
            "insert into public.workflow_outputs "
            "(id, project_id, stage, html_path, summary, version, meta) "
            "values (cast(:id as uuid), cast(:pid as uuid), cast(:st as workflow_stage_enum), "
            "        :path, :summary, :ver, cast(:meta as jsonb))"
        ),
        {
            "id": new_id,
            "pid": project_id,
            "st": stage,
            "path": f"{MOCKDB_PREFIX}{content_id}",
            "summary": title,
            "ver": version,
            "meta": json.dumps(
                {"author": actor_label, "source": source, "file_name": file_name}
            ),
        },
    )
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
