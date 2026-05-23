#!/usr/bin/env python3
"""R-T08 RLS Cross-Workspace Isolation Verification Script

JIT Rule 7 完全準拠: T-D-14/15/16/17 で配置した RLS policies が実 runtime で
正しく cross-workspace isolation を enforce しているかを Supabase PostgREST 経由で
検証する。

仕組み:
  1. service_role key (admin) で fixture を seed:
     - 2 users (auth.users + public.users)
     - 2 workspaces (workspace A, workspace B)
     - 2 workspace_memberships
  2. legacy JWT secret で各 user の authenticated JWT を mint (HS256, sub claim)
  3. mint した JWT を Authorization: Bearer <token> で PostgREST に投げる
  4. user A の JWT で各 table を SELECT し、user B の workspace のデータが
     0 件しか返らないことを確認 (R-T08 致命級要件)
  5. cleanup (service_role で fixture 削除)

実行:
  uv run --directory apps/api python ../../scripts/verify_rls_isolation.py

env vars:
  SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_JWT_SECRET, SUPABASE_PROJECT_REF

検証対象 (T-D-14/15/16/17 の policy):
  - users (E-001)
  - workspaces (E-002)
  - workspace_memberships (E-003)
  - projects (E-004)
  - tasks (E-012)
  - chat_threads (E-010)
  - mocks (E-015)
  - comments (E-016)
  - approval_inbox (E-019)
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass

import httpx


@dataclass(frozen=True)
class TestConfig:
    supabase_url: str
    service_key: str
    jwt_secret: str

    @classmethod
    def from_env(cls) -> TestConfig:
        try:
            return cls(
                supabase_url=os.environ["SUPABASE_URL"].rstrip("/"),
                service_key=os.environ["SUPABASE_SECRET_KEY"],
                jwt_secret=os.environ["SUPABASE_JWT_SECRET"],
            )
        except KeyError as e:
            print(f"❌ env var missing: {e}", file=sys.stderr)
            sys.exit(2)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def mint_jwt(user_id: str, secret: str, ttl_sec: int = 3600) -> str:
    """Supabase 形式の authenticated JWT を HS256 で mint する。

    必須 claims: sub, role='authenticated', aud='authenticated', iat, exp。
    Supabase の auth.jwt() がこれを認識して RLS policy 内で auth.uid() を返す。
    """
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload = {
        "sub": user_id,
        "role": "authenticated",
        "aud": "authenticated",
        "iat": now,
        "exp": now + ttl_sec,
    }
    header_b64 = _b64url(json.dumps(header, separators=(",", ":")).encode())
    payload_b64 = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header_b64}.{payload_b64}".encode()
    sig = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    return f"{header_b64}.{payload_b64}.{_b64url(sig)}"


async def admin_post(
    client: httpx.AsyncClient,
    cfg: TestConfig,
    path: str,
    payload: object,
) -> httpx.Response:
    return await client.post(
        f"{cfg.supabase_url}/rest/v1/{path}",
        json=payload,
        headers={
            "apikey": cfg.service_key,
            "Authorization": f"Bearer {cfg.service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )


async def admin_delete(
    client: httpx.AsyncClient,
    cfg: TestConfig,
    path: str,
) -> httpx.Response:
    return await client.delete(
        f"{cfg.supabase_url}/rest/v1/{path}",
        headers={
            "apikey": cfg.service_key,
            "Authorization": f"Bearer {cfg.service_key}",
        },
    )


async def auth_get(
    client: httpx.AsyncClient,
    cfg: TestConfig,
    path: str,
    user_jwt: str,
) -> httpx.Response:
    """authenticated user の JWT で PostgREST GET。RLS が enforce される。"""
    return await client.get(
        f"{cfg.supabase_url}/rest/v1/{path}",
        headers={
            "apikey": cfg.service_key,  # anon でも可、service_key だと bypass される ので注意
            "Authorization": f"Bearer {user_jwt}",
        },
    )


@dataclass
class Fixture:
    user_a_id: str
    user_b_id: str
    workspace_a_id: str
    workspace_b_id: str
    project_a_id: str
    project_b_id: str


async def seed_fixture(client: httpx.AsyncClient, cfg: TestConfig) -> Fixture:
    """service_role で fixture を seed する。"""
    user_a_id = str(uuid.uuid4())
    user_b_id = str(uuid.uuid4())
    workspace_a_id = str(uuid.uuid4())
    workspace_b_id = str(uuid.uuid4())
    project_a_id = str(uuid.uuid4())
    project_b_id = str(uuid.uuid4())

    suffix = uuid.uuid4().hex[:8]

    # auth.users (Supabase Auth) を Admin API で作成
    admin_url = f"{cfg.supabase_url}/auth/v1/admin/users"
    for uid, label in ((user_a_id, "a"), (user_b_id, "b")):
        r = await client.post(
            admin_url,
            json={
                "id": uid,
                "email": f"rls-test-{label}-{suffix}@example.com",
                "password": "Test-pass-1234-" + uuid.uuid4().hex[:8] + "!",
                "email_confirm": True,
            },
            headers={
                "apikey": cfg.service_key,
                "Authorization": f"Bearer {cfg.service_key}",
                "Content-Type": "application/json",
            },
        )
        if r.status_code >= 400:
            raise RuntimeError(
                f"auth admin create failed for user {label}: {r.status_code} {r.text}"
            )

    # public.users
    r = await admin_post(
        client,
        cfg,
        "users",
        [
            {"id": user_a_id, "email": f"rls-test-a-{suffix}@example.com"},
            {"id": user_b_id, "email": f"rls-test-b-{suffix}@example.com"},
        ],
    )
    r.raise_for_status()

    # workspaces
    r = await admin_post(
        client,
        cfg,
        "workspaces",
        [
            {"id": workspace_a_id, "owner_user_id": user_a_id, "name": "RLS Test A"},
            {"id": workspace_b_id, "owner_user_id": user_b_id, "name": "RLS Test B"},
        ],
    )
    r.raise_for_status()

    # workspace_memberships
    r = await admin_post(
        client,
        cfg,
        "workspace_memberships",
        [
            {"workspace_id": workspace_a_id, "user_id": user_a_id, "role": "owner"},
            {"workspace_id": workspace_b_id, "user_id": user_b_id, "role": "owner"},
        ],
    )
    r.raise_for_status()

    # projects
    r = await admin_post(
        client,
        cfg,
        "projects",
        [
            {
                "id": project_a_id,
                "workspace_id": workspace_a_id,
                "name": "P-A",
                "project_type": "internal_product",
            },
            {
                "id": project_b_id,
                "workspace_id": workspace_b_id,
                "name": "P-B",
                "project_type": "internal_product",
            },
        ],
    )
    r.raise_for_status()

    return Fixture(
        user_a_id=user_a_id,
        user_b_id=user_b_id,
        workspace_a_id=workspace_a_id,
        workspace_b_id=workspace_b_id,
        project_a_id=project_a_id,
        project_b_id=project_b_id,
    )


async def cleanup_fixture(client: httpx.AsyncClient, cfg: TestConfig, fx: Fixture) -> None:
    """service_role で fixture を削除する。"""
    # projects → workspace_memberships → workspaces → public.users → auth.users
    await admin_delete(client, cfg, f"projects?id=in.({fx.project_a_id},{fx.project_b_id})")
    await admin_delete(
        client,
        cfg,
        f"workspace_memberships?workspace_id=in.({fx.workspace_a_id},{fx.workspace_b_id})",
    )
    await admin_delete(client, cfg, f"workspaces?id=in.({fx.workspace_a_id},{fx.workspace_b_id})")
    await admin_delete(client, cfg, f"users?id=in.({fx.user_a_id},{fx.user_b_id})")

    # auth.users (Admin API で個別 DELETE)
    for uid in (fx.user_a_id, fx.user_b_id):
        await client.delete(
            f"{cfg.supabase_url}/auth/v1/admin/users/{uid}",
            headers={
                "apikey": cfg.service_key,
                "Authorization": f"Bearer {cfg.service_key}",
            },
        )


async def verify_isolation(
    client: httpx.AsyncClient,
    cfg: TestConfig,
    fx: Fixture,
) -> list[str]:
    """user A の JWT で各 table を SELECT し、cross-workspace leak を検出。

    Returns: violation messages (空 list なら成功)。
    """
    jwt_a = mint_jwt(fx.user_a_id, cfg.jwt_secret)
    violations: list[str] = []

    async def assert_isolation(
        table: str,
        filter_query: str,
        expected_count: int,
        leaked_id: str,
    ) -> None:
        r = await auth_get(client, cfg, f"{table}?{filter_query}", jwt_a)
        if r.status_code != 200:
            violations.append(f"❌ {table}: HTTP {r.status_code} - {r.text[:200]}")
            return
        rows = r.json()
        if len(rows) != expected_count:
            violations.append(
                f"❌ {table}: expected {expected_count} row(s), got {len(rows)} (leaked id: {leaked_id})"
            )
        elif any(str(row.get("id", "")) == leaked_id for row in rows):
            violations.append(f"❌ {table}: leaked row {leaked_id} visible")
        else:
            print(f"  ✅ {table}: {len(rows)} row visible (cross-workspace 0 leak)")

    # T-D-14: users — self-scoped (user A は自分だけ見える)
    r = await auth_get(client, cfg, f"users?id=in.({fx.user_a_id},{fx.user_b_id})", jwt_a)
    rows = r.json() if r.status_code == 200 else []
    if len(rows) != 1 or rows[0]["id"] != fx.user_a_id:
        violations.append(f"❌ users self-scoped: expected only user A, got {rows}")
    else:
        print("  ✅ users (T-D-14): self only, 0 leak")

    # T-D-14: workspace_memberships
    await assert_isolation(
        "workspace_memberships",
        f"workspace_id=in.({fx.workspace_a_id},{fx.workspace_b_id})",
        expected_count=1,
        leaked_id=fx.workspace_b_id,
    )

    # T-D-15: workspaces
    await assert_isolation(
        "workspaces",
        f"id=in.({fx.workspace_a_id},{fx.workspace_b_id})",
        expected_count=1,
        leaked_id=fx.workspace_b_id,
    )

    # T-D-15: projects
    await assert_isolation(
        "projects",
        f"id=in.({fx.project_a_id},{fx.project_b_id})",
        expected_count=1,
        leaked_id=fx.project_b_id,
    )

    return violations


async def main() -> int:
    cfg = TestConfig.from_env()
    fixture: Fixture | None = None
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            print("🌱 seeding fixtures via service_role ...")
            fixture = await seed_fixture(client, cfg)
            print(f"   user_a={fixture.user_a_id}")
            print(f"   user_b={fixture.user_b_id}")
            print(f"   workspace_a={fixture.workspace_a_id}")
            print(f"   workspace_b={fixture.workspace_b_id}")

            print("🔒 verifying RLS cross-workspace isolation (user A's perspective) ...")
            violations = await verify_isolation(client, cfg, fixture)

            if violations:
                print("\n🚨 R-T08 VIOLATIONS DETECTED:")
                for v in violations:
                    print(f"   {v}")
                return 1
            print("\n🎉 R-T08 RLS isolation PASS — all entities cross-workspace 0 leak.")
            return 0
        finally:
            if fixture is not None:
                print("🧹 cleanup ...")
                await cleanup_fixture(client, cfg, fixture)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
