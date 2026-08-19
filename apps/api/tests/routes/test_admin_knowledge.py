"""Integration tests for T-A-50 — 運営ナレッジ管理 API (F-023)。実 Postgres + service_role。

検証:
- POST /admin/knowledge (admin) で account_type=platform + sentinel account_id の行が作成され 201。
- 非 admin は 403 / 未認証は 401。
- PATCH で visible_in_tree をトグルし、別 GET (一覧) で反映される（永続化）。
- GET 一覧は運営ナレッジを全件返す。DELETE で 204、再 DELETE で 404。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from collections.abc import Iterator
from typing import Any

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
JWT_SECRET = "test-jwt-secret"
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)
os.environ.setdefault("ATELIER_DB_URL", PG_ASYNC)
os.environ.pop("VOYAGE_API_KEY", None)

import sqlalchemy  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

_SENTINEL = "00000000-0000-0000-0000-000000000000"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _mint_jwt(user_id: str, *, admin: bool = False) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload_obj: dict[str, Any] = {
        "sub": user_id,
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 3600,
    }
    if admin:
        payload_obj["app_metadata"] = {"role": "admin"}
    payload = _b64url(json.dumps(payload_obj).encode())
    sig = _b64url(
        hmac.new(
            JWT_SECRET.encode(), f"{header}.{payload}".encode("ascii"), hashlib.sha256
        ).digest()
    )
    return f"{header}.{payload}.{sig}"


def _db_available() -> bool:
    try:
        eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
        try:
            with eng.connect() as c:
                c.execute(text("select 1"))
        finally:
            eng.dispose()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="local Postgres not available")


@pytest.fixture()
def app() -> Iterator[FastAPI]:
    from src.routes.admin_knowledge import (
        _session_factory_for_loop,  # pyright: ignore[reportPrivateUsage]  # lru_cache 実体を clear
    )

    _session_factory_for_loop.cache_clear()
    from src.routes import api_router

    application = FastAPI()
    application.include_router(api_router)
    yield application
    _session_factory_for_loop.cache_clear()


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    admin_u = str(uuid.uuid4())
    member_u = str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (admin_u, member_u):
            em = f"ta50-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
    yield {"admin": admin_u, "member": member_u}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.knowledge_nodes where category = 'ta50-test'"))
        for uid in (admin_u, member_u):
            c.execute(text("delete from public.users where id = cast(:i as uuid)"), {"i": uid})
            c.execute(text("delete from auth.users where id = cast(:i as uuid)"), {"i": uid})


def _h(uid: str, *, admin: bool = False) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid, admin=admin)}"}


def _body(title: str = "運営FAQ") -> dict[str, Any]:
    return {
        "category": "ta50-test",
        "title": title,
        "content_md": "# 運営デフォルト\n\n横断参照される。",
    }


def test_create_platform_knowledge_admin(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    with TestClient(app) as cl:
        r = cl.post("/admin/knowledge", json=_body(), headers=_h(seeded["admin"], admin=True))
        assert r.status_code == 201, r.text
        data = r.json()["data"]
        assert data["account_type"] == "platform"
        assert data["account_id"] == _SENTINEL
        assert data["visible_in_tree"] is False
    with sync_engine.connect() as c:
        row = c.execute(
            text(
                "select account_type, account_id from public.knowledge_nodes "
                "where id = cast(:i as uuid)"
            ),
            {"i": data["id"]},
        ).first()
        assert row is not None and str(row.account_type) == "platform"
        assert str(row.account_id) == _SENTINEL


def test_create_non_admin_forbidden(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        r = cl.post("/admin/knowledge", json=_body(), headers=_h(seeded["member"]))
        assert r.status_code == 403, r.text


def test_unauthenticated_401(app: FastAPI) -> None:
    with TestClient(app) as cl:
        assert cl.post("/admin/knowledge", json=_body()).status_code == 401
        assert cl.get("/admin/knowledge").status_code == 401


def test_toggle_visible_in_tree_persists(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        cr = cl.post("/admin/knowledge", json=_body(), headers=_h(seeded["admin"], admin=True))
        kid = cr.json()["data"]["id"]
        up = cl.patch(
            f"/admin/knowledge/{kid}",
            json={"visible_in_tree": True},
            headers=_h(seeded["admin"], admin=True),
        )
        assert up.status_code == 200, up.text
        assert up.json()["data"]["visible_in_tree"] is True
        # 別 GET（一覧）で反映を確認。
        ls = cl.get("/admin/knowledge", headers=_h(seeded["admin"], admin=True))
        assert ls.status_code == 200, ls.text
        match = [x for x in ls.json()["data"] if x["id"] == kid]
        assert match and match[0]["visible_in_tree"] is True


def test_list_and_delete(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        cr = cl.post(
            "/admin/knowledge", json=_body("消す対象"), headers=_h(seeded["admin"], admin=True)
        )
        kid = cr.json()["data"]["id"]
        ls = cl.get("/admin/knowledge", headers=_h(seeded["admin"], admin=True))
        assert kid in {x["id"] for x in ls.json()["data"]}
        de = cl.delete(f"/admin/knowledge/{kid}", headers=_h(seeded["admin"], admin=True))
        assert de.status_code == 204, de.text
        miss = cl.delete(f"/admin/knowledge/{kid}", headers=_h(seeded["admin"], admin=True))
        assert miss.status_code == 404, miss.text


def test_patch_non_admin_forbidden(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        cr = cl.post("/admin/knowledge", json=_body(), headers=_h(seeded["admin"], admin=True))
        kid = cr.json()["data"]["id"]
        r = cl.patch(
            f"/admin/knowledge/{kid}",
            json={"title": "x"},
            headers=_h(seeded["member"]),
        )
        assert r.status_code == 403, r.text


# ── GAP-153: ナレッジ自動キュレーション (運営 AI 裏走・匿名化・承認ゲート) ──


@pytest.fixture()
def tenant(sync_engine: sqlalchemy.Engine, seeded: dict[str, str]) -> Iterator[dict[str, str]]:
    """特定可能情報を持つテナント (社名/プロジェクト名) + 良いナレッジ 2 件。"""
    ws = str(uuid.uuid4())
    proj = str(uuid.uuid4())
    clean = str(uuid.uuid4())
    leaky = str(uuid.uuid4())
    with sync_engine.begin() as c:
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
            {"i": ws, "o": seeded["member"], "n": "秘密商事ホールディングス"},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type) "
                "values (:i,:w,'極秘アトリエ刷新PJ','client_work')"
            ),
            {"i": proj, "w": ws},
        )
        for nid, title, content in (
            (
                clean,
                "見積レビューの観点",
                "# 見積レビューの観点\n"
                "工数は不確実性で幅を持たせ、前提条件を必ず明記する。"
                "検収条件と支払サイトを見積段階で合意しておくと後工程の揉め事が減る。"
                "スコープ外の要望はバックログへ分離し、追加見積として扱うと"
                "利益率が読みやすくなる。",
            ),
            (
                leaky,
                "定例の進め方",
                "# 定例の進め方\n"
                "秘密商事ホールディングスの田中様との定例は毎週火曜。"
                "極秘アトリエ刷新PJの課題は tanaka@himitsu.example.co.jp へ連絡し、"
                "詳細は https://internal.himitsu.example/wiki を参照。"
                "この運用でリードタイムが 30% 減った。",
            ),
        ):
            c.execute(
                text(
                    "insert into public.knowledge_nodes "
                    "(id, account_id, account_type, scope, category, title, content_md, "
                    " usage_count, confidence_score) "
                    "values (cast(:i as uuid), cast(:a as uuid), 'workspace', 'common', "
                    "'gap153-test', :t, :c, 5, 0.9)"
                ),
                {"i": nid, "a": ws, "t": title, "c": content},
            )
    yield {"ws": ws, "clean": clean, "leaky": leaky}
    with sync_engine.begin() as c:
        c.execute(
            text(
                "delete from public.knowledge_curations where source_node_id in (cast(:a as uuid), cast(:b as uuid))"
            ),
            {"a": clean, "b": leaky},
        )
        c.execute(
            text("delete from public.knowledge_nodes where category in ('gap153-test', 'ノウハウ')")
        )
        c.execute(text("delete from public.workspaces where id = cast(:i as uuid)"), {"i": ws})


def test_gap153_curation_run_anonymize_and_security_scan(
    app: FastAPI,
    seeded: dict[str, str],
    tenant: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """裏走バッチ: 有用ナレッジは匿名化提案、特定可能情報の残存は機械的に排除。"""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("ATELIER_ALLOW_FAKE_LLM", "1")
    with TestClient(app) as cl:
        # 非 admin は 403 (運営専用 — テナントには存在自体を見せない)
        assert (
            cl.post(
                "/admin/knowledge/curation/run", json={}, headers=_h(seeded["member"])
            ).status_code
            == 403
        )
        r = cl.post(
            "/admin/knowledge/curation/run",
            json={"limit": 10},
            headers=_h(seeded["admin"], admin=True),
        )
        assert r.status_code == 200, r.text
        stats = r.json()["data"]
        assert stats["scanned"] == 2
        assert stats["proposed"] == 1
        # leaky はフェイク LLM が原文を引き写す → 決定的リークスキャンが社名/メール/URL を検出
        assert stats["rejected_security"] == 1

        pend = cl.get(
            "/admin/knowledge/curation",
            params={"status": "pending"},
            headers=_h(seeded["admin"], admin=True),
        ).json()["data"]
        assert len(pend) == 1
        assert pend[0]["source_node_id"] == tenant["clean"]
        assert pend[0]["proposed_title"].startswith("[一般化]")
        assert pend[0]["source_workspace_name"] == "秘密商事ホールディングス"

        rej = cl.get(
            "/admin/knowledge/curation",
            params={"status": "rejected_security"},
            headers=_h(seeded["admin"], admin=True),
        ).json()["data"]
        assert len(rej) == 1
        assert rej[0]["source_node_id"] == tenant["leaky"]
        assert "残存" in (rej[0]["security_notes"] or "")

        # 再実行しても重複提案は作らない (1 ソース = 1 キュレーション)
        r2 = cl.post(
            "/admin/knowledge/curation/run",
            json={"limit": 10},
            headers=_h(seeded["admin"], admin=True),
        )
        assert r2.json()["data"]["scanned"] == 0


def test_gap153_approve_publishes_platform_and_recheck(
    app: FastAPI,
    seeded: dict[str, str],
    tenant: dict[str, str],
    sync_engine: sqlalchemy.Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """承認で platform ナレッジ (匿名化・承認者記録) を公開。公開直前にも再スキャン。"""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("ATELIER_ALLOW_FAKE_LLM", "1")
    ha = _h(seeded["admin"], admin=True)
    with TestClient(app) as cl:
        cl.post("/admin/knowledge/curation/run", json={"limit": 10}, headers=ha)
        pend = cl.get("/admin/knowledge/curation", params={"status": "pending"}, headers=ha).json()[
            "data"
        ]
        cur_id = pend[0]["id"]

        r = cl.post(f"/admin/knowledge/curation/{cur_id}/approve", headers=ha)
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["curation"]["status"] == "approved"
        pub = d["published"]
        assert pub["account_type"] == "platform"
        assert pub["is_anonymized"] is True
        with sync_engine.connect() as c:
            approved_by = c.execute(
                text(
                    "select approved_by_user_id from public.knowledge_nodes "
                    "where id = cast(:i as uuid)"
                ),
                {"i": pub["id"]},
            ).scalar_one()
        assert str(approved_by) == seeded["admin"]
        # 処理済みの再承認 / 却下は 409
        assert cl.post(f"/admin/knowledge/curation/{cur_id}/approve", headers=ha).status_code == 409
        assert cl.post(f"/admin/knowledge/curation/{cur_id}/reject", headers=ha).status_code == 409

        # 公開直前の再スキャン: pending の提案文へ社名を混入させると承認は 409 +
        # rejected_security へ落ちる (承認時点の照合 — LLM/過去の走査を信用しない)
        cur2 = str(uuid.uuid4())
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "insert into public.knowledge_curations "
                    "(id, source_node_id, source_account_type, source_account_id, "
                    " proposed_title, proposed_content_md, proposed_category, reason, status) "
                    "values (cast(:i as uuid), cast(:s as uuid), 'workspace', cast(:a as uuid), "
                    "'混入テスト', '秘密商事ホールディングス向けの手順', 'ノウハウ', 'x', 'pending') "
                    "on conflict (source_node_id) do update set status='pending', "
                    "proposed_title='混入テスト', "
                    "proposed_content_md='秘密商事ホールディングス向けの手順'"
                ),
                {"i": cur2, "s": tenant["leaky"], "a": tenant["ws"]},
            )
        leaky_pending = cl.get(
            "/admin/knowledge/curation", params={"status": "pending"}, headers=ha
        ).json()["data"]
        assert len(leaky_pending) == 1
        r409 = cl.post(f"/admin/knowledge/curation/{leaky_pending[0]['id']}/approve", headers=ha)
        assert r409.status_code == 409
        assert "特定可能情報" in r409.json()["detail"]
        after = cl.get(
            "/admin/knowledge/curation", params={"status": "rejected_security"}, headers=ha
        ).json()["data"]
        assert any(x["id"] == leaky_pending[0]["id"] for x in after)


def test_gap153_llm_unconfigured_503(
    app: FastAPI,
    seeded: dict[str, str],
    tenant: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """運営側キー未設定は誠実に 503 (勝手に別経路・空実行にしない)。"""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ATELIER_ALLOW_FAKE_LLM", raising=False)
    del tenant  # 候補が存在する状態で
    with TestClient(app) as cl:
        r = cl.post(
            "/admin/knowledge/curation/run",
            json={},
            headers=_h(seeded["admin"], admin=True),
        )
        assert r.status_code == 503
        assert "ANTHROPIC_API_KEY" in r.json()["detail"]
