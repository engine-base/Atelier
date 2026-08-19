"""GAP-150: プロジェクトフロー (COO ハブ&スポーク / ステージゲート) の統合テスト。

実 Postgres + RLS + JWT。自動初期化 / 完了と current 移動 / hard_gate /
スキップ規則 / 差し戻し / 不可視 404 / チャットへのフロー注入を検証する。
"""
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from collections.abc import AsyncGenerator, Iterator
from typing import Annotated

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
JWT_SECRET = "test-jwt-secret"
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)

import sqlalchemy  # noqa: E402
from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.dependencies import CurrentUser, get_current_user, get_rls_session  # noqa: E402


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _mint_jwt(user_id: str) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url(
        json.dumps(
            {
                "sub": user_id,
                "role": "authenticated",
                "aud": "authenticated",
                "exp": int(time.time()) + 3600,
            }
        ).encode()
    )
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
    test_engine = create_async_engine(PG_ASYNC, poolclass=NullPool)

    async def _override_session(
        user: Annotated[CurrentUser, Depends(get_current_user)],
    ) -> AsyncGenerator[AsyncSession, None]:
        claims = json.dumps({"sub": user.id, "role": user.role})
        async with AsyncSession(test_engine) as session:
            await session.execute(
                text("select set_config('request.jwt.claims', :c, true)"), {"c": claims}
            )
            await session.execute(text("set local role authenticated"))
            try:
                yield session
            except Exception:
                await session.rollback()
                raise
            else:
                await session.commit()

    from src.routes import api_router

    application = FastAPI()
    application.include_router(api_router)
    application.dependency_overrides[get_rls_session] = _override_session
    yield application
    asyncio.run(test_engine.dispose())


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    u = str(uuid.uuid4())
    ws = str(uuid.uuid4())
    proj = str(uuid.uuid4())
    coo = str(uuid.uuid4())
    with sync_engine.begin() as c:
        em = f"flow-{u[:8]}@t.invalid"
        c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": u, "e": em})
        c.execute(text("insert into public.users (id,email) values (:i,:e)"), {"i": u, "e": em})
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,'flow-ws')"),
            {"i": ws, "o": u},
        )
        # ローカル dev DB の bootstrap trigger が社員をシードすることがあるため
        # 決定的な担当解決のために一掃して COO (executive) だけ固定投入する
        c.execute(
            text("delete from public.ai_employees where workspace_id=cast(:w as uuid)"),
            {"w": ws},
        )
        c.execute(
            text(
                "insert into public.ai_employees (id,workspace_id,name,display_name,role,"
                "department,is_default) values (cast(:i as uuid),cast(:w as uuid),"
                "'jarvis','ジャービス','coo','executive',true)"
            ),
            {"i": coo, "w": ws},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type,status) "
                "values (cast(:i as uuid),cast(:w as uuid),'FlowProj','client_work','active')"
            ),
            {"i": proj, "w": ws},
        )
    yield {"u": u, "ws": ws, "proj": proj, "coo": coo}
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.project_flow_stages where project_id=cast(:p as uuid)"),
            {"p": proj},
        )
        c.execute(
            text("delete from public.chat_threads where project_id=cast(:p as uuid)"), {"p": proj}
        )
        c.execute(text("delete from public.projects where id=cast(:i as uuid)"), {"i": proj})
        c.execute(text("delete from public.ai_employees where id=cast(:i as uuid)"), {"i": coo})
        c.execute(text("delete from public.workspaces where id=cast(:i as uuid)"), {"i": ws})
        c.execute(text("delete from public.users where id=cast(:i as uuid)"), {"i": u})
        c.execute(text("delete from auth.users where id=cast(:i as uuid)"), {"i": u})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
def test_flow_autoinit_and_lifecycle(app: FastAPI, seeded: dict[str, str]) -> None:
    """自動初期化 → 完了で current が移動 → スキップ規則 → 差し戻し。"""
    h = _h(seeded["u"])
    with TestClient(app) as client:
        # 1) 初回 GET で client_work テンプレ (10 工程) が自動生成される
        r = client.get(f"/projects/{seeded['proj']}/flow", headers=h)
        assert r.status_code == 200, r.text
        flow = r.json()["data"]
        assert [s["stage_key"] for s in flow] == [
            "hearing",
            "proposal",
            "estimate",
            "contract",
            "requirements",
            "architecture",
            "design",
            "implementation",
            "verification",
            "delivery",
        ]
        assert flow[0]["current"] is True  # 現在 = ヒアリング
        assert flow[3]["hard_gate"] is True  # 契約は致命
        assert flow[-1]["hard_gate"] is True  # 納品は致命
        # COO (executive) が納品の担当として解決される
        assert flow[-1]["employee_name"] == "ジャービス"

        # 2) ヒアリング完了 → current が提案へ
        r2 = client.post(f"/projects/{seeded['proj']}/flow/hearing/complete", json={}, headers=h)
        assert r2.status_code == 200
        flow2 = r2.json()["data"]
        assert flow2[0]["status"] == "done"
        assert flow2[1]["current"] is True

        # 3) 提案はスキップ可 (理由必須)
        r3 = client.post(
            f"/projects/{seeded['proj']}/flow/proposal/skip",
            json={"reason": "既存クライアントの追加開発のため提案不要"},
            headers=h,
        )
        assert r3.status_code == 200
        flow3 = r3.json()["data"]
        assert flow3[1]["status"] == "skipped"
        assert "提案不要" in flow3[1]["skip_reason"]
        assert flow3[2]["current"] is True  # 見積へ

        # 4) 契約 (hard_gate) は confirm 無しで完了できない・スキップも不可
        r4 = client.post(f"/projects/{seeded['proj']}/flow/contract/complete", json={}, headers=h)
        assert r4.status_code == 403
        r5 = client.post(
            f"/projects/{seeded['proj']}/flow/contract/skip",
            json={"reason": "飛ばしたい"},
            headers=h,
        )
        assert r5.status_code == 403
        # confirm=true なら完了できる (ユーザーの明示承認)
        r6 = client.post(
            f"/projects/{seeded['proj']}/flow/contract/complete",
            json={"confirm": True},
            headers=h,
        )
        assert r6.status_code == 200

        # 5) 要件定義 (skippable でない) はスキップ 409
        r7 = client.post(
            f"/projects/{seeded['proj']}/flow/requirements/skip",
            json={"reason": "x"},
            headers=h,
        )
        assert r7.status_code == 409

        # 6) 差し戻し: ヒアリングを pending に戻すと current がそこへ戻る
        r8 = client.post(f"/projects/{seeded['proj']}/flow/hearing/reopen", headers=h)
        assert r8.status_code == 200
        flow8 = r8.json()["data"]
        assert flow8[0]["status"] == "pending" and flow8[0]["current"] is True
        # 完了済みの契約はそのまま保持 (実務の部分手戻り)
        assert flow8[3]["status"] == "done"


@pytest.mark.integration
def test_flow_invisible_project_404(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as client:
        r = client.get(f"/projects/{uuid.uuid4()}/flow", headers=_h(seeded["u"]))
        assert r.status_code == 404


@pytest.mark.integration
def test_flow_injected_into_chat_context(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    """GAP-150: フロー進行状況が全チャットの system prompt に注入される。"""
    thread = str(uuid.uuid4())
    with sync_engine.begin() as c:
        c.execute(
            text(
                "insert into public.chat_threads (id, project_id, ai_employee_id, title) "
                "values (cast(:i as uuid), cast(:p as uuid), cast(:e as uuid), 'coo-t')"
            ),
            {"i": thread, "p": seeded["proj"], "e": seeded["coo"]},
        )
    h = _h(seeded["u"])
    with TestClient(app) as client:
        # フロー初期化 + ヒアリング完了 (現在 = 提案)
        client.get(f"/projects/{seeded['proj']}/flow", headers=h)
        client.post(f"/projects/{seeded['proj']}/flow/hearing/complete", json={}, headers=h)
        r = client.post(
            f"/chat/threads/{thread}/context-preview",
            headers=h,
            json={"user_message": "今どこ？", "include_history": 5},
        )
        assert r.status_code == 200
        sys_p = r.json()["data"]["system_prompt"]
        assert "プロジェクト進行フロー" in sys_p
        assert "✓ 1. 商談・ヒアリング" in sys_p
        assert "2. 提案" in sys_p and "← 現在のステージ" in sys_p
        assert "担当社員への切替を案内する" in sys_p


@pytest.mark.integration
def test_gap151_stage_thread_ensure_adopt_and_fixed_employee(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    """GAP-151: 工程専用スレッド — 作成/固定/再利用/既存スレッド採用/担当固定。"""
    h = _h(seeded["u"])
    with TestClient(app) as client:
        client.get(f"/projects/{seeded['proj']}/flow", headers=h)  # init

        # COO (executive) 担当の delivery: 既存スレッド無し → 新規作成される
        r1 = client.post(f"/projects/{seeded['proj']}/flow/delivery/thread", headers=h)
        assert r1.status_code == 200, r1.text
        t1 = r1.json()["data"]["thread_id"]
        # 2 回目は同じスレッド (工程に固定済み)
        r2 = client.post(f"/projects/{seeded['proj']}/flow/delivery/thread", headers=h)
        assert r2.json()["data"]["thread_id"] == t1
        # flow 応答にも載る
        flow = client.get(f"/projects/{seeded['proj']}/flow", headers=h).json()["data"]
        delivery = next(s for s in flow if s["stage_key"] == "delivery")
        assert delivery["thread_id"] == t1
        assert delivery["employee_name"] == "ジャービス"  # 担当は固定 (運営テンプレ)

        # 担当部門に社員が居ない工程 (design) は 409 で誠実に伝える
        r3 = client.post(f"/projects/{seeded['proj']}/flow/design/thread", headers=h)
        assert r3.status_code == 409
        assert "社員がいません" in r3.json()["detail"]

    with sync_engine.connect() as c:
        row = c.execute(
            text(
                "select ai_employee_id::text as eid, title from public.chat_threads "
                "where id = cast(:t as uuid)"
            ),
            {"t": t1},
        ).one()
        assert row.eid == seeded["coo"]
        assert row.title in ("納品・請求", "リリース判定")


# ── GAP-152: 段階的フェーズ (確定=凍結・追加は次フェーズ・フェーズ切替) ──────


@pytest.mark.integration
def test_gap152_phase_lifecycle_freeze_and_new_round(app: FastAPI, seeded: dict[str, str]) -> None:
    """フェーズ1 自動作成 → 確定 (confirm 必須) → フェーズ2 でフロー新周回。
    確定フェーズの周回は ?phase= で閲覧でき、当時の状態が保存されている。"""
    h = _h(seeded["u"])
    proj = seeded["proj"]
    with TestClient(app) as client:
        # 初回: フェーズ1 (active) が自動作成される
        r = client.get(f"/projects/{proj}/delivery-phases", headers=h)
        assert r.status_code == 200
        phases = r.json()["data"]
        assert [p["name"] for p in phases] == ["フェーズ1"]
        assert phases[0]["status"] == "active"
        p1 = phases[0]["id"]

        # フロー初期化 + hearing 完了 (フェーズ1 の周回)
        client.get(f"/projects/{proj}/flow", headers=h)
        client.post(f"/projects/{proj}/flow/hearing/complete", json={}, headers=h)

        # confirm 無しの確定は 403 (成果物凍結 — 明示承認必須)
        r403 = client.post(f"/projects/{proj}/delivery-phases/{p1}/freeze", json={}, headers=h)
        assert r403.status_code == 403
        assert "明示的に承認" in r403.json()["detail"]

        # 確定 → フェーズ1 frozen + フェーズ2 active (フロー新周回も即初期化)
        r2 = client.post(
            f"/projects/{proj}/delivery-phases/{p1}/freeze",
            json={"confirm": True},
            headers=h,
        )
        assert r2.status_code == 200
        phases2 = r2.json()["data"]
        assert [(p["name"], p["status"]) for p in phases2] == [
            ("フェーズ1", "frozen"),
            ("フェーズ2", "active"),
        ]
        assert phases2[0]["frozen_at"] is not None
        assert phases2[1]["stages_total"] > 0  # 新周回が即初期化済み
        p2 = phases2[1]["id"]

        # 現在のフロー = フェーズ2 の新周回 (hearing は pending に戻っている)
        flow2 = client.get(f"/projects/{proj}/flow", headers=h).json()["data"]
        hearing2 = next(s for s in flow2 if s["stage_key"] == "hearing")
        assert hearing2["status"] == "pending" and hearing2["current"] is True

        # フェーズ1 の周回は ?phase= で閲覧でき、当時の完了状態が残っている
        flow1 = client.get(f"/projects/{proj}/flow", params={"phase": p1}, headers=h).json()["data"]
        hearing1 = next(s for s in flow1 if s["stage_key"] == "hearing")
        assert hearing1["status"] == "done"

        # フェーズ2 の周回で hearing を完了できる (操作は常に active フェーズ)
        r3 = client.post(f"/projects/{proj}/flow/hearing/complete", json={}, headers=h)
        assert r3.status_code == 200

        # 確定済みフェーズの再確定は 409
        r409 = client.post(
            f"/projects/{proj}/delivery-phases/{p1}/freeze",
            json={"confirm": True},
            headers=h,
        )
        assert r409.status_code == 409
        assert "確定済み" in r409.json()["detail"]

        # 別プロジェクトのフェーズ id は 404
        assert (
            client.post(
                f"/projects/{proj}/delivery-phases/{uuid.uuid4()}/freeze",
                json={"confirm": True},
                headers=h,
            ).status_code
            == 404
        )
        assert p2 != p1


@pytest.mark.integration
def test_gap152_stamping_filters_and_frozen_guard(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    """成果物/モック/タスクは active フェーズにスタンプされ、確定フェーズの行は
    破壊操作 409。追加 (新版・新タスク) は自動的に次フェーズへ入り、
    delivery_phase_id フィルタで「フェーズ2 の追加分」を分けて見られる。"""
    h = _h(seeded["u"])
    proj = seeded["proj"]
    with TestClient(app) as client:
        phases = client.get(f"/projects/{proj}/delivery-phases", headers=h).json()["data"]
        p1 = phases[0]["id"]

        # フェーズ1 でモック + タスクを作成 → active フェーズにスタンプ
        mock1 = client.post(
            "/mocks",
            json={
                "project_id": proj,
                "screen_name": "S-152",
                "html_storage_path": "s152-v1.html",
            },
            headers=h,
        ).json()["data"]
        assert mock1["delivery_phase_id"] == p1
        task1 = client.post(
            "/tasks",
            json={
                "project_id": proj,
                "category": "実装",
                "title": "フェーズ1 のタスク",
                "type": "feature",
                "estimated_hours": 2,
            },
            headers=h,
        ).json()["data"]
        assert task1["delivery_phase_id"] == p1

        # フェーズ1 の成果物チェーン (v1, v2) を seed (mockdb 実コンテンツ)
        o1, o2 = str(uuid.uuid4()), str(uuid.uuid4())
        with sync_engine.begin() as c:
            for oid, ver, html in ((o1, 1, "<p>旧見積</p>"), (o2, 2, "<p>新見積</p>")):
                cid = c.execute(
                    text("insert into public.mock_contents (html) values (:h) returning id"),
                    {"h": html},
                ).scalar_one()
                c.execute(
                    text(
                        "insert into public.workflow_outputs "
                        "(id, project_id, stage, html_path, summary, version, "
                        " delivery_phase_id, meta) "
                        "values (cast(:i as uuid), cast(:p as uuid), 'estimate', :path, "
                        "'見積', :v, cast(:dph as uuid), '{}'::jsonb)"
                    ),
                    {"i": oid, "p": proj, "path": f"mockdb://{cid}", "v": ver, "dph": p1},
                )

        # フェーズ1 を確定
        r = client.post(
            f"/projects/{proj}/delivery-phases/{p1}/freeze",
            json={"confirm": True},
            headers=h,
        )
        assert r.status_code == 200
        p2 = next(p["id"] for p in r.json()["data"] if p["status"] == "active")

        # 確定フェーズの行への破壊操作は 409 (凍結スナップショット)
        r_discard = client.post(f"/mocks/{mock1['id']}/discard", headers=h)
        assert r_discard.status_code == 409
        assert "確定済み" in r_discard.json()["detail"]
        r_patch = client.patch(
            f"/mocks/{mock1['id']}",
            json={"meta_tags": {"note": "書き換え"}},
            headers=h,
        )
        assert r_patch.status_code == 409
        assert client.delete(f"/mocks/{mock1['id']}", headers=h).status_code == 409

        # 追加 (新版) は自動的にフェーズ2 へ入る — フェーズ1 は不変
        mock2 = client.post(
            f"/mocks/{mock1['id']}/versions",
            json={"html_storage_path": "s152-v2.html"},
            headers=h,
        ).json()["data"]
        assert mock2["delivery_phase_id"] == p2

        # 旧版の復元も「フェーズ2 の新版」として積まれる (見積の追加分の分離)
        restored = client.post(f"/outputs/{o1}/restore", headers=h)
        assert restored.status_code == 201
        assert restored.json()["data"]["delivery_phase_id"] == p2

        # フィルタ: フェーズ1 のスナップショット / フェーズ2 の追加分
        m_p1 = client.get(
            "/mocks",
            params={"project_id": proj, "delivery_phase_id": p1},
            headers=h,
        ).json()["data"]
        assert [m["id"] for m in m_p1] == [mock1["id"]]
        m_p2 = client.get(
            "/mocks",
            params={"project_id": proj, "delivery_phase_id": p2},
            headers=h,
        ).json()["data"]
        assert [m["id"] for m in m_p2] == [mock2["id"]]
        o_p2 = client.get(
            "/outputs",
            params={"project_id": proj, "delivery_phase_id": p2},
            headers=h,
        ).json()["data"]
        assert [o["id"] for o in o_p2] == [restored.json()["data"]["id"]]
        t_p1 = client.get(
            "/tasks",
            params={"project_id": proj, "delivery_phase_id": p1},
            headers=h,
        ).json()["data"]
        assert [t["id"] for t in t_p1] == [task1["id"]]

        # チャット文脈にフェーズの立ち位置が注入される
        thread = str(uuid.uuid4())
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "insert into public.chat_threads (id, project_id, ai_employee_id, title) "
                    "values (cast(:i as uuid), cast(:p as uuid), cast(:e as uuid), 'coo-p2')"
                ),
                {"i": thread, "p": proj, "e": seeded["coo"]},
            )
        ctx = client.post(
            f"/chat/threads/{thread}/context-preview",
            headers=h,
            json={"user_message": "追加お願い", "include_history": 5},
        ).json()["data"]["system_prompt"]
        assert "フェーズ2" in ctx and "確定済み" in ctx
        # GAP-157: 前フェーズの中身 (成果物/モック) が AI 文脈に入る — 表示を
        # 切り替えても依存・タスク分解が前フェーズを踏まえられる状態
        assert "確定済みフェーズの内容" in ctx
        assert "S-152(v1)" in ctx  # フェーズ1 の画面モック
        assert "見積(v2, estimate)" in ctx  # フェーズ1 の成果物 (最新版)
        assert "現在フェーズの作業として扱い" in ctx
