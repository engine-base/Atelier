"""GAP-153: ナレッジ自動キュレーション — 運営 AI 裏走 + 匿名化 + 承認ゲート。

経営者決定: ユーザー提案フローはしない。運営として裏で AI を走らせて自動で
分ける。その中でセキュリティも担保する。

実行主体と費用: 運営側バッチ (運営の ANTHROPIC_API_KEY)。テナントユーザーの
サブスク (Bridge relay) は使わない — 全テナント横断の走査を個人の契約に
負わせない。キー未設定なら誠実に 503 (勝手に別経路へ落とさない)。

セキュリティ担保 (二重):
  1. LLM の匿名化 — 固有名詞 (社名/氏名/顧客名/金額/連絡先/URL/ID) を除去し一般化
  2. 決定的リークスキャン — 元テナントの workspace 名 / プロジェクト名 /
     メンバー氏名・メールアドレスが提案文に残っていないか機械照合 + email/
     電話番号/URL の正規表現検出。1 件でも残れば rejected_security (LLM を信用しない)
自動公開はしない — pending を運営 admin が承認して初めて platform ナレッジになる。
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Protocol

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.llm.client import LLMMessage
from src.schemas.knowledge import KnowledgeCreate, KnowledgeResponse
from src.schemas.knowledge_curation import CurationRunStats, KnowledgeCurationResponse

CURATION_MODEL = os.environ.get("ATELIER_CURATION_MODEL", "claude-sonnet-4-6")

_MIN_CONTENT_CHARS = 80
_MAX_CONTENT_CHARS = 12_000

_SYSTEM = (
    "あなたは SaaS 運営側のナレッジキュレーターです。あるテナント (契約企業) の"
    "社内ナレッジを 1 件受け取り、次の 2 つを行ってください。\n"
    "1) 判定: 業種や会社を問わず他のテナントにも役立つ一般的なノウハウか "
    "(そのテナント固有の事情・顧客対応・社内ルールだけなら useful=false)。\n"
    "2) 匿名化: useful=true の場合、固有情報を完全に除去して一般化した本文を"
    "書き直す。除去対象: 会社名・人名・顧客名・プロジェクト名・製品固有名・"
    "金額・メールアドレス・電話番号・URL・ID 類。役割語 (「クライアント」"
    "「担当者」等) への置換は可。\n"
    "出力は次の JSON のみ (説明文・コードフェンス禁止):\n"
    '{"useful": true/false, "reason": "判定理由 (100字以内)", "title": "一般化した'
    'タイトル", "content_md": "匿名化済み本文 (Markdown)", "category": "分類", '
    '"tags": ["…"], "removed_info_kinds": ["社名", "金額", …]}'
)


class CurationError(Exception):
    """構造的失敗 (code: llm_unconfigured / llm_failed)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _CompletionClient(Protocol):
    async def complete(
        self,
        *,
        model: str,
        messages: list[LLMMessage],
        system: str | None = ...,
        max_tokens: int = ...,
        temperature: float = ...,
    ) -> Any: ...


_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PHONE_RE = re.compile(r"0\d{1,4}-\d{1,4}-\d{3,4}")
_URL_RE = re.compile(r"https?://[^\s)>\"']+")


async def _tenant_identifiers(
    session: AsyncSession, *, account_type: str, account_id: str
) -> list[tuple[str, str]]:
    """元テナントを特定しうる文字列 (種別, 値)。決定的リークスキャンの照合対象。"""
    idents: list[tuple[str, str]] = []
    if account_type == "workspace":
        rows = (
            await session.execute(
                text("select name from public.workspaces where id = cast(:a as uuid)"),
                {"a": account_id},
            )
        ).all()
        idents += [("workspace名", str(r.name)) for r in rows]
        rows = (
            await session.execute(
                text("select name from public.projects where workspace_id = cast(:a as uuid)"),
                {"a": account_id},
            )
        ).all()
        idents += [("プロジェクト名", str(r.name)) for r in rows]
        rows = (
            await session.execute(
                text(
                    "select u.email, coalesce(u.display_name, '') as dname "
                    "from public.users u "
                    "join public.workspace_memberships m on m.user_id = u.id "
                    "where m.workspace_id = cast(:a as uuid)"
                ),
                {"a": account_id},
            )
        ).all()
        for r in rows:
            idents.append(("メールアドレス", str(r.email)))
            if str(r.dname).strip():
                idents.append(("氏名", str(r.dname)))
    else:  # user アカウント
        rows = (
            await session.execute(
                text(
                    "select email, coalesce(display_name, '') as dname "
                    "from public.users where id = cast(:a as uuid)"
                ),
                {"a": account_id},
            )
        ).all()
        for r in rows:
            idents.append(("メールアドレス", str(r.email)))
            if str(r.dname).strip():
                idents.append(("氏名", str(r.dname)))
    # 3 文字未満は誤検知が多すぎるため対象外 (それ自体では特定に足りない)
    return [(k, v) for k, v in idents if len(v.strip()) >= 3]


async def security_scan(
    session: AsyncSession, *, text_body: str, account_type: str, account_id: str
) -> list[str]:
    """匿名化後の本文に残った特定可能情報の種別リスト (空 = 合格)。

    LLM の匿名化を信用せず機械照合する — 1 件でも残れば公開候補にしない。
    """
    found: list[str] = []
    lowered = text_body.lower()
    for kind, value in await _tenant_identifiers(
        session, account_type=account_type, account_id=account_id
    ):
        if value.lower() in lowered:
            found.append(f"{kind}が残存")
    if _EMAIL_RE.search(text_body):
        found.append("メールアドレス形式が残存")
    if _PHONE_RE.search(text_body):
        found.append("電話番号形式が残存")
    if _URL_RE.search(text_body):
        found.append("URL が残存")
    # 重複種別は 1 回に
    return sorted(set(found))


def _fake_curation(title: str, content_md: str) -> dict[str, Any]:
    """ATELIER_ALLOW_FAKE_LLM=1 のみの決定的スタブ (配線検証用)。"""
    return {
        "useful": len(content_md) >= _MIN_CONTENT_CHARS,
        "reason": "[fake] 一般的なノウハウと判定",
        "title": f"[一般化] {title[:80]}",
        "content_md": f"# 一般化ノウハウ\n{content_md[:400]}",
        "category": "ノウハウ",
        "tags": ["curated"],
        "removed_info_kinds": [],
    }


def _strip_fence(raw: str) -> str:
    t = raw.strip()
    if t.startswith("```"):
        nl = t.find("\n")
        if nl >= 0:
            t = t[nl + 1 :]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


async def _judge(
    *, title: str, content_md: str, client: _CompletionClient | None
) -> dict[str, Any]:
    if client is None and not os.environ.get("ANTHROPIC_API_KEY"):
        if os.environ.get("ATELIER_ALLOW_FAKE_LLM") == "1":
            return _fake_curation(title, content_md)
        raise CurationError(
            "llm_unconfigured",
            "運営側の ANTHROPIC_API_KEY が未設定のためキュレーションを実行できません",
        )
    if client is None:
        from src.llm.anthropic import AnthropicClient

        client = AnthropicClient()
    try:
        res = await client.complete(
            model=CURATION_MODEL,
            messages=[
                LLMMessage(
                    role="user",
                    content=f"タイトル: {title}\n\n本文:\n{content_md[:_MAX_CONTENT_CHARS]}",
                )
            ],
            system=_SYSTEM,
            max_tokens=4096,
            temperature=0.0,
        )
        parsed: Any = json.loads(_strip_fence(str(res.text)))
    except CurationError:
        raise
    except Exception as e:
        raise CurationError("llm_failed", f"キュレーション LLM 呼出に失敗: {e}") from e
    if not isinstance(parsed, dict):
        raise CurationError("llm_failed", "キュレーション LLM が JSON 以外を返しました")
    return parsed


async def _candidates(session: AsyncSession, *, limit: int) -> list[Any]:
    """テナントの「良いナレッジ」候補 (未キュレーションのみ)。

    良さの実測シグナル: 使用回数 or 確信度。platform 由来と AI 学習途中の
    低確信ノートは対象外。
    """
    return list(
        (
            await session.execute(
                text(
                    "select id, account_type::text as atype, account_id, title, content_md "
                    "from public.knowledge_nodes k "
                    "where k.deleted_at is null "
                    "and k.account_type in ('workspace', 'user') "
                    "and k.scope = 'common' "
                    "and char_length(k.content_md) >= :minlen "
                    "and (k.usage_count >= 3 or k.confidence_score >= 0.7) "
                    "and not exists (select 1 from public.knowledge_curations c "
                    "                where c.source_node_id = k.id) "
                    "order by k.usage_count desc, k.updated_at desc limit :lim"
                ),
                {"minlen": _MIN_CONTENT_CHARS, "lim": max(1, min(limit, 100))},
            )
        ).all()
    )


async def run_curation(
    session: AsyncSession,
    *,
    actor_id: str,
    limit: int = 20,
    client: _CompletionClient | None = None,
) -> CurationRunStats:
    """運営バッチ本体: 候補走査 → LLM 判定+匿名化 → リークスキャン → 提案登録。"""
    rows = await _candidates(session, limit=limit)
    stats = CurationRunStats(scanned=len(rows))
    for row in rows:
        judged = await _judge(title=str(row.title), content_md=str(row.content_md), client=client)
        useful = bool(judged.get("useful"))
        reason = str(judged.get("reason", ""))[:500]
        if not useful:
            await _insert_curation(
                session,
                row=row,
                status="skipped",
                title=str(row.title)[:200],
                content_md="",
                category="",
                tags=[],
                reason=reason or "テナント固有と判定",
                security_notes=None,
            )
            stats.skipped_not_useful += 1
            continue
        title = str(judged.get("title", ""))[:200] or str(row.title)[:200]
        content = str(judged.get("content_md", ""))
        category = str(judged.get("category", "ノウハウ"))[:100] or "ノウハウ"
        tags = [str(t)[:50] for t in list(judged.get("tags") or [])][:20]
        removed = [str(x) for x in list(judged.get("removed_info_kinds") or [])]
        leaks = await security_scan(
            session,
            text_body=f"{title}\n{content}",
            account_type=str(row.atype),
            account_id=str(row.account_id),
        )
        if content.strip() == "" or leaks:
            await _insert_curation(
                session,
                row=row,
                status="rejected_security",
                title=title,
                content_md=content,
                category=category,
                tags=tags,
                reason=reason,
                security_notes="; ".join(leaks) or "匿名化本文が空",
            )
            stats.rejected_security += 1
            continue
        await _insert_curation(
            session,
            row=row,
            status="pending",
            title=title,
            content_md=content,
            category=category,
            tags=tags,
            reason=reason,
            security_notes=("除去: " + ", ".join(removed)) if removed else None,
        )
        stats.proposed += 1
    await AuditWriter(session).write(
        AuditEvent(
            action="knowledge.curation.run",
            target_type="platform",
            actor_type="user",
            actor_id=actor_id,
            target_id="platform",
            after=stats.model_dump(),
        )
    )
    return stats


async def _insert_curation(
    session: AsyncSession,
    *,
    row: Any,
    status: str,
    title: str,
    content_md: str,
    category: str,
    tags: list[str],
    reason: str,
    security_notes: str | None,
) -> None:
    await session.execute(
        text(
            "insert into public.knowledge_curations "
            "(source_node_id, source_account_type, source_account_id, proposed_title, "
            " proposed_content_md, proposed_category, proposed_tags, reason, "
            " security_notes, status, model) "
            "values (cast(:sid as uuid), :at, cast(:aid as uuid), :t, :c, :cat, "
            "        :tags, :r, :sec, :st, :m) "
            "on conflict (source_node_id) do nothing"
        ),
        {
            "sid": str(row.id),
            "at": str(row.atype),
            "aid": str(row.account_id),
            "t": title,
            "c": content_md,
            "cat": category,
            "tags": tags,
            "r": reason,
            "sec": security_notes,
            "st": status,
            "m": CURATION_MODEL,
        },
    )


_CUR_COLS = (
    "c.id, c.source_node_id, c.source_account_type, c.source_account_id, "
    "c.proposed_title, c.proposed_content_md, c.proposed_category, c.proposed_tags, "
    "c.reason, c.security_notes, c.status, c.model, c.published_node_id, "
    "c.reviewed_at, c.created_at, "
    "(select k.title from public.knowledge_nodes k where k.id = c.source_node_id) "
    "  as source_title, "
    "(select w.name from public.workspaces w "
    "  where c.source_account_type = 'workspace' and w.id = c.source_account_id) "
    "  as source_workspace_name"
)


def _to_response(row: Any) -> KnowledgeCurationResponse:
    return KnowledgeCurationResponse(
        id=str(row.id),
        source_node_id=str(row.source_node_id),
        source_account_type=str(row.source_account_type),
        source_title=None if row.source_title is None else str(row.source_title),
        source_workspace_name=(
            None if row.source_workspace_name is None else str(row.source_workspace_name)
        ),
        proposed_title=str(row.proposed_title),
        proposed_content_md=str(row.proposed_content_md),
        proposed_category=str(row.proposed_category),
        proposed_tags=[str(t) for t in list(row.proposed_tags or [])],
        reason=str(row.reason),
        security_notes=None if row.security_notes is None else str(row.security_notes),
        status=str(row.status),  # pyright: ignore[reportArgumentType]
        model=None if row.model is None else str(row.model),
        published_node_id=(None if row.published_node_id is None else str(row.published_node_id)),
        reviewed_at=row.reviewed_at,
        created_at=row.created_at,
    )


async def list_curations(
    session: AsyncSession, *, status: str | None = None, limit: int = 50
) -> list[KnowledgeCurationResponse]:
    where = "where c.status = :st" if status else ""
    params: dict[str, object] = {"lim": max(1, min(limit, 200))}
    if status:
        params["st"] = status
    rows = (
        await session.execute(
            text(
                f"select {_CUR_COLS} from public.knowledge_curations c "
                f"{where} order by c.created_at desc limit :lim"
            ),
            params,
        )
    ).all()
    return [_to_response(r) for r in rows]


async def _get_pending(session: AsyncSession, curation_id: str) -> Any:
    row = (
        await session.execute(
            text(
                f"select {_CUR_COLS} from public.knowledge_curations c "
                "where c.id = cast(:i as uuid)"
            ),
            {"i": curation_id},
        )
    ).first()
    if row is None:
        raise CurationError("not_found", "curation not found")
    if str(row.status) != "pending":
        raise CurationError("not_pending", f"この提案は処理済みです ({row.status})")
    return row


async def approve_curation(
    session: AsyncSession, *, actor_id: str, curation_id: str
) -> tuple[KnowledgeCurationResponse, KnowledgeResponse]:
    """承認 = platform ナレッジとして公開 (匿名化済み・全アカウント共有)。

    公開直前にもリークスキャンを再実行する (走査後にテナント情報が変わって
    いても、承認時点の照合で必ず引っかける)。
    """
    from src.services import knowledge as kn

    row = await _get_pending(session, curation_id)
    leaks = await security_scan(
        session,
        text_body=f"{row.proposed_title}\n{row.proposed_content_md}",
        account_type=str(row.source_account_type),
        account_id=str(row.source_account_id),
    )
    if leaks:
        await session.execute(
            text(
                "update public.knowledge_curations set status = 'rejected_security', "
                "security_notes = :sec, reviewed_by = cast(:u as uuid), "
                "reviewed_at = now(), updated_at = now() where id = cast(:i as uuid)"
            ),
            {"i": curation_id, "u": actor_id, "sec": "; ".join(leaks)},
        )
        raise CurationError(
            "security", "特定可能情報が残っているため公開できません: " + ", ".join(leaks)
        )
    created = await kn.create_knowledge(
        session,
        actor_id=actor_id,
        data=KnowledgeCreate(
            account_id="00000000-0000-0000-0000-000000000000",
            account_type="platform",
            scope="common",
            category=str(row.proposed_category) or "ノウハウ",
            title=str(row.proposed_title),
            content_md=str(row.proposed_content_md),
            tags=[str(t) for t in list(row.proposed_tags or [])],
            source_type="ai_extracted",
            confidence_score=0.7,
            is_anonymized=True,
        ),
    )
    if created is None:
        raise CurationError("llm_failed", "platform ナレッジの作成に失敗しました")
    await session.execute(
        text(
            "update public.knowledge_nodes set approved_by_user_id = cast(:u as uuid) "
            "where id = cast(:k as uuid)"
        ),
        {"u": actor_id, "k": created.id},
    )
    await session.execute(
        text(
            "update public.knowledge_curations set status = 'approved', "
            "published_node_id = cast(:k as uuid), reviewed_by = cast(:u as uuid), "
            "reviewed_at = now(), updated_at = now() where id = cast(:i as uuid)"
        ),
        {"i": curation_id, "u": actor_id, "k": created.id},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="knowledge.curation.approve",
            target_type="knowledge",
            actor_type="user",
            actor_id=actor_id,
            target_id=created.id,
            after={"curation_id": curation_id, "title": created.title},
        )
    )
    updated = (
        await session.execute(
            text(
                f"select {_CUR_COLS} from public.knowledge_curations c "
                "where c.id = cast(:i as uuid)"
            ),
            {"i": curation_id},
        )
    ).one()
    return _to_response(updated), created


async def reject_curation(
    session: AsyncSession, *, actor_id: str, curation_id: str
) -> KnowledgeCurationResponse:
    await _get_pending(session, curation_id)
    await session.execute(
        text(
            "update public.knowledge_curations set status = 'rejected', "
            "reviewed_by = cast(:u as uuid), reviewed_at = now(), updated_at = now() "
            "where id = cast(:i as uuid)"
        ),
        {"i": curation_id, "u": actor_id},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="knowledge.curation.reject",
            target_type="platform",
            actor_type="user",
            actor_id=actor_id,
            target_id=curation_id,
        )
    )
    row = (
        await session.execute(
            text(
                f"select {_CUR_COLS} from public.knowledge_curations c "
                "where c.id = cast(:i as uuid)"
            ),
            {"i": curation_id},
        )
    ).one()
    return _to_response(row)
