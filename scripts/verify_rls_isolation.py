#!/usr/bin/env python3
# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
"""R-T08 RLS Cross-Workspace Isolation Verification Script

JIT Rule 7 完全準拠: T-D-14/15/16/17/18/19/21 で配置した RLS policies が実 runtime
で正しく cross-workspace / cross-user isolation を enforce しているかを Supabase
PostgREST 経由で検証する。

仕組み:
  1. service_role key (admin) で fixture を seed:
     - 2 users / 2 workspaces / 2 memberships / 2 projects
     - 2 ai_employees / 2 phases / 2 workflow_outputs (T-D-21)
     - 2 tasks / 2 task_executions / 2 acceptance_criteria (T-D-16)
     - 2 chat_threads / 2 chat_messages / 2 mocks / 2 comments / 2 approval_inbox (T-D-17)
     - 2 knowledge_nodes (T-D-18)
     - 2 audit_logs / 2 consents / 2 external_uploads (T-D-19)
  2. legacy JWT secret で各 user の authenticated JWT を mint (HS256, sub claim)
  3. mint した JWT を Authorization: Bearer <token> で PostgREST に投げる
  4. user A の JWT で各 table を SELECT し、user B のデータが 0 件しか
     返らないことを確認 (R-T08 致命級要件)
  5. cleanup (service_role で fixture 削除)

実行:
  uv run --directory apps/api python ../../scripts/verify_rls_isolation.py

env vars:
  SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_JWT_SECRET

検証対象 (T-D-14〜21 の全 RLS policy):
  T-D-14: users (E-001), workspace_memberships (E-003)
  T-D-15: workspaces (E-002), projects (E-004)
  T-D-16: tasks (E-012), task_executions (E-013), acceptance_criteria (E-014)
  T-D-17: chat_threads (E-010), chat_messages (E-011), mocks (E-015),
          comments (E-016), approval_inbox (E-019)
  T-D-18: knowledge_nodes (E-018)
  T-D-19: audit_logs (E-020), consents (E-025), external_uploads (E-024)
  T-D-21: ai_employees (E-007), phases (E-005), workflow_outputs (E-006)
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
    # T-D-14/15 base
    user_a_id: str
    user_b_id: str
    workspace_a_id: str
    workspace_b_id: str
    project_a_id: str
    project_b_id: str
    # T-D-21 (ai_employees / phases / workflow_outputs)
    ai_employee_a_id: str
    ai_employee_b_id: str
    phase_a_id: str
    phase_b_id: str
    workflow_output_a_id: str
    workflow_output_b_id: str
    # T-D-16 (tasks / task_executions / acceptance_criteria)
    task_a_id: str
    task_b_id: str
    task_execution_a_id: str
    task_execution_b_id: str
    acceptance_criteria_a_id: str
    acceptance_criteria_b_id: str
    # T-D-17 (chat / mocks / comments / approval_inbox)
    chat_thread_a_id: str
    chat_thread_b_id: str
    chat_message_a_id: str
    chat_message_b_id: str
    mock_a_id: str
    mock_b_id: str
    comment_a_id: str
    comment_b_id: str
    approval_inbox_a_id: str
    approval_inbox_b_id: str
    # T-D-18 (knowledge_nodes)
    knowledge_node_a_id: str
    knowledge_node_b_id: str
    # T-D-19 (audit_logs / consents / external_uploads)
    audit_log_a_id: str
    audit_log_b_id: str
    consent_a_id: str
    consent_b_id: str
    external_upload_a_id: str
    external_upload_b_id: str


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

    # T-D-21: ai_employees / phases / workflow_outputs
    ai_employee_a_id = str(uuid.uuid4())
    ai_employee_b_id = str(uuid.uuid4())
    phase_a_id = str(uuid.uuid4())
    phase_b_id = str(uuid.uuid4())
    workflow_output_a_id = str(uuid.uuid4())
    workflow_output_b_id = str(uuid.uuid4())

    r = await admin_post(
        client,
        cfg,
        "ai_employees",
        [
            {
                "id": ai_employee_a_id,
                "workspace_id": workspace_a_id,
                "name": "jarvis-a",
                "display_name": "Jarvis A",
                "role": "member",
                "department": "product",
            },
            {
                "id": ai_employee_b_id,
                "workspace_id": workspace_b_id,
                "name": "jarvis-b",
                "display_name": "Jarvis B",
                "role": "member",
                "department": "product",
            },
        ],
    )
    r.raise_for_status()

    r = await admin_post(
        client,
        cfg,
        "phases",
        [
            {"id": phase_a_id, "project_id": project_a_id, "order": 1, "name": "phase A"},
            {"id": phase_b_id, "project_id": project_b_id, "order": 1, "name": "phase B"},
        ],
    )
    r.raise_for_status()

    r = await admin_post(
        client,
        cfg,
        "workflow_outputs",
        [
            {"id": workflow_output_a_id, "project_id": project_a_id, "stage": "proposal"},
            {"id": workflow_output_b_id, "project_id": project_b_id, "stage": "proposal"},
        ],
    )
    r.raise_for_status()

    # T-D-16: tasks / task_executions / acceptance_criteria
    task_a_id = str(uuid.uuid4())
    task_b_id = str(uuid.uuid4())
    task_execution_a_id = str(uuid.uuid4())
    task_execution_b_id = str(uuid.uuid4())
    acceptance_criteria_a_id = str(uuid.uuid4())
    acceptance_criteria_b_id = str(uuid.uuid4())

    r = await admin_post(
        client,
        cfg,
        "tasks",
        [
            {
                "id": task_a_id,
                "project_id": project_a_id,
                "category": "test",
                "title": "Task A",
                "type": "feature",
                "estimated_hours": 1,
            },
            {
                "id": task_b_id,
                "project_id": project_b_id,
                "category": "test",
                "title": "Task B",
                "type": "feature",
                "estimated_hours": 1,
            },
        ],
    )
    r.raise_for_status()

    now_iso = "2026-05-23T00:00:00Z"
    r = await admin_post(
        client,
        cfg,
        "task_executions",
        [
            {
                "id": task_execution_a_id,
                "task_id": task_a_id,
                "started_at": now_iso,
                "status": "running",
            },
            {
                "id": task_execution_b_id,
                "task_id": task_b_id,
                "started_at": now_iso,
                "status": "running",
            },
        ],
    )
    r.raise_for_status()

    r = await admin_post(
        client,
        cfg,
        "acceptance_criteria",
        [
            {"id": acceptance_criteria_a_id, "task_id": task_a_id, "html_path": "a/x.html"},
            {"id": acceptance_criteria_b_id, "task_id": task_b_id, "html_path": "b/x.html"},
        ],
    )
    r.raise_for_status()

    # T-D-17: chat_threads / chat_messages / mocks / comments / approval_inbox
    chat_thread_a_id = str(uuid.uuid4())
    chat_thread_b_id = str(uuid.uuid4())
    chat_message_a_id = str(uuid.uuid4())
    chat_message_b_id = str(uuid.uuid4())
    mock_a_id = str(uuid.uuid4())
    mock_b_id = str(uuid.uuid4())
    comment_a_id = str(uuid.uuid4())
    comment_b_id = str(uuid.uuid4())
    approval_inbox_a_id = str(uuid.uuid4())
    approval_inbox_b_id = str(uuid.uuid4())

    r = await admin_post(
        client,
        cfg,
        "chat_threads",
        [
            {
                "id": chat_thread_a_id,
                "project_id": project_a_id,
                "ai_employee_id": ai_employee_a_id,
            },
            {
                "id": chat_thread_b_id,
                "project_id": project_b_id,
                "ai_employee_id": ai_employee_b_id,
            },
        ],
    )
    r.raise_for_status()

    r = await admin_post(
        client,
        cfg,
        "chat_messages",
        [
            {
                "id": chat_message_a_id,
                "thread_id": chat_thread_a_id,
                "role": "user",
                "content": "hello A",
            },
            {
                "id": chat_message_b_id,
                "thread_id": chat_thread_b_id,
                "role": "user",
                "content": "hello B",
            },
        ],
    )
    r.raise_for_status()

    r = await admin_post(
        client,
        cfg,
        "mocks",
        [
            {
                "id": mock_a_id,
                "project_id": project_a_id,
                "screen_name": "ScreenA",
                "html_storage_path": "mocks/a.html",
            },
            {
                "id": mock_b_id,
                "project_id": project_b_id,
                "screen_name": "ScreenB",
                "html_storage_path": "mocks/b.html",
            },
        ],
    )
    r.raise_for_status()

    r = await admin_post(
        client,
        cfg,
        "comments",
        [
            {
                "id": comment_a_id,
                "target_type": "task",
                "target_id": task_a_id,
                "author_user_id": user_a_id,
                "content": "comment A",
            },
            {
                "id": comment_b_id,
                "target_type": "task",
                "target_id": task_b_id,
                "author_user_id": user_b_id,
                "content": "comment B",
            },
        ],
    )
    r.raise_for_status()

    r = await admin_post(
        client,
        cfg,
        "approval_inbox",
        [
            {
                "id": approval_inbox_a_id,
                "user_id": user_a_id,
                "type": "task_approval",
                "target_type": "task",
                "target_id": task_a_id,
                "title": "approve A",
            },
            {
                "id": approval_inbox_b_id,
                "user_id": user_b_id,
                "type": "task_approval",
                "target_type": "task",
                "target_id": task_b_id,
                "title": "approve B",
            },
        ],
    )
    r.raise_for_status()

    # T-D-18: knowledge_nodes (polymorphic: workspace-scoped)
    knowledge_node_a_id = str(uuid.uuid4())
    knowledge_node_b_id = str(uuid.uuid4())
    r = await admin_post(
        client,
        cfg,
        "knowledge_nodes",
        [
            {
                "id": knowledge_node_a_id,
                "account_id": workspace_a_id,
                "account_type": "workspace",
                "scope": "common",
                "category": "test",
                "title": "knowledge A",
                "content_md": "x",
            },
            {
                "id": knowledge_node_b_id,
                "account_id": workspace_b_id,
                "account_type": "workspace",
                "scope": "common",
                "category": "test",
                "title": "knowledge B",
                "content_md": "x",
            },
        ],
    )
    r.raise_for_status()

    # T-D-19: audit_logs / consents / external_uploads
    audit_log_a_id = str(uuid.uuid4())
    audit_log_b_id = str(uuid.uuid4())
    consent_a_id = str(uuid.uuid4())
    consent_b_id = str(uuid.uuid4())
    external_upload_a_id = str(uuid.uuid4())
    external_upload_b_id = str(uuid.uuid4())

    r = await admin_post(
        client,
        cfg,
        "audit_logs",
        [
            {
                "id": audit_log_a_id,
                "workspace_id": workspace_a_id,
                "actor_type": "user",
                "actor_id": user_a_id,
                "action": "test.event",
                "target_type": "test",
            },
            {
                "id": audit_log_b_id,
                "workspace_id": workspace_b_id,
                "actor_type": "user",
                "actor_id": user_b_id,
                "action": "test.event",
                "target_type": "test",
            },
        ],
    )
    r.raise_for_status()

    r = await admin_post(
        client,
        cfg,
        "consents",
        [
            {
                "id": consent_a_id,
                "user_id": user_a_id,
                "type": "terms_of_service",
                "version": "1.0.0",
                "accepted": True,
            },
            {
                "id": consent_b_id,
                "user_id": user_b_id,
                "type": "terms_of_service",
                "version": "1.0.0",
                "accepted": True,
            },
        ],
    )
    r.raise_for_status()

    r = await admin_post(
        client,
        cfg,
        "external_uploads",
        [
            {
                "id": external_upload_a_id,
                "project_id": project_a_id,
                "uploaded_by_user_id": user_a_id,
                "type": "document",
                "storage_path": "a/x.pdf",
                "file_name": "a.pdf",
                "file_size_bytes": 1024,
                "mime_type": "application/pdf",
            },
            {
                "id": external_upload_b_id,
                "project_id": project_b_id,
                "uploaded_by_user_id": user_b_id,
                "type": "document",
                "storage_path": "b/x.pdf",
                "file_name": "b.pdf",
                "file_size_bytes": 1024,
                "mime_type": "application/pdf",
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
        ai_employee_a_id=ai_employee_a_id,
        ai_employee_b_id=ai_employee_b_id,
        phase_a_id=phase_a_id,
        phase_b_id=phase_b_id,
        workflow_output_a_id=workflow_output_a_id,
        workflow_output_b_id=workflow_output_b_id,
        task_a_id=task_a_id,
        task_b_id=task_b_id,
        task_execution_a_id=task_execution_a_id,
        task_execution_b_id=task_execution_b_id,
        acceptance_criteria_a_id=acceptance_criteria_a_id,
        acceptance_criteria_b_id=acceptance_criteria_b_id,
        chat_thread_a_id=chat_thread_a_id,
        chat_thread_b_id=chat_thread_b_id,
        chat_message_a_id=chat_message_a_id,
        chat_message_b_id=chat_message_b_id,
        mock_a_id=mock_a_id,
        mock_b_id=mock_b_id,
        comment_a_id=comment_a_id,
        comment_b_id=comment_b_id,
        approval_inbox_a_id=approval_inbox_a_id,
        approval_inbox_b_id=approval_inbox_b_id,
        knowledge_node_a_id=knowledge_node_a_id,
        knowledge_node_b_id=knowledge_node_b_id,
        audit_log_a_id=audit_log_a_id,
        audit_log_b_id=audit_log_b_id,
        consent_a_id=consent_a_id,
        consent_b_id=consent_b_id,
        external_upload_a_id=external_upload_a_id,
        external_upload_b_id=external_upload_b_id,
    )


async def cleanup_fixture(client: httpx.AsyncClient, cfg: TestConfig, fx: Fixture) -> None:
    """service_role で fixture を削除する (FK dependency 順)。"""
    # leaf entities first (FK 子側)
    deletes: list[str] = [
        f"external_uploads?id=in.({fx.external_upload_a_id},{fx.external_upload_b_id})",
        f"consents?id=in.({fx.consent_a_id},{fx.consent_b_id})",
        f"audit_logs?id=in.({fx.audit_log_a_id},{fx.audit_log_b_id})",
        f"knowledge_nodes?id=in.({fx.knowledge_node_a_id},{fx.knowledge_node_b_id})",
        f"approval_inbox?id=in.({fx.approval_inbox_a_id},{fx.approval_inbox_b_id})",
        f"comments?id=in.({fx.comment_a_id},{fx.comment_b_id})",
        f"mocks?id=in.({fx.mock_a_id},{fx.mock_b_id})",
        f"chat_messages?id=in.({fx.chat_message_a_id},{fx.chat_message_b_id})",
        f"chat_threads?id=in.({fx.chat_thread_a_id},{fx.chat_thread_b_id})",
        f"acceptance_criteria?id=in.({fx.acceptance_criteria_a_id},{fx.acceptance_criteria_b_id})",
        f"task_executions?id=in.({fx.task_execution_a_id},{fx.task_execution_b_id})",
        f"tasks?id=in.({fx.task_a_id},{fx.task_b_id})",
        f"workflow_outputs?id=in.({fx.workflow_output_a_id},{fx.workflow_output_b_id})",
        f"phases?id=in.({fx.phase_a_id},{fx.phase_b_id})",
        f"ai_employees?id=in.({fx.ai_employee_a_id},{fx.ai_employee_b_id})",
        f"projects?id=in.({fx.project_a_id},{fx.project_b_id})",
        f"workspace_memberships?workspace_id=in.({fx.workspace_a_id},{fx.workspace_b_id})",
        f"workspaces?id=in.({fx.workspace_a_id},{fx.workspace_b_id})",
        f"users?id=in.({fx.user_a_id},{fx.user_b_id})",
    ]
    for path in deletes:
        # cleanup は best-effort (一部失敗しても次の削除を続行)
        try:
            await admin_delete(client, cfg, path)
        except Exception as exc:
            print(f"  ⚠ cleanup {path[:50]}... failed: {exc}", file=sys.stderr)

    # auth.users (Admin API で個別 DELETE)
    for uid in (fx.user_a_id, fx.user_b_id):
        try:
            await client.delete(
                f"{cfg.supabase_url}/auth/v1/admin/users/{uid}",
                headers={
                    "apikey": cfg.service_key,
                    "Authorization": f"Bearer {cfg.service_key}",
                },
            )
        except Exception as exc:
            print(f"  ⚠ cleanup auth user {uid[:8]} failed: {exc}", file=sys.stderr)


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

    # ─── T-D-21: ai_employees / phases / workflow_outputs ─────────────
    await assert_isolation(
        "ai_employees",
        f"id=in.({fx.ai_employee_a_id},{fx.ai_employee_b_id})",
        expected_count=1,
        leaked_id=fx.ai_employee_b_id,
    )
    await assert_isolation(
        "phases",
        f"id=in.({fx.phase_a_id},{fx.phase_b_id})",
        expected_count=1,
        leaked_id=fx.phase_b_id,
    )
    await assert_isolation(
        "workflow_outputs",
        f"id=in.({fx.workflow_output_a_id},{fx.workflow_output_b_id})",
        expected_count=1,
        leaked_id=fx.workflow_output_b_id,
    )

    # ─── T-D-16: tasks / task_executions / acceptance_criteria ─────
    await assert_isolation(
        "tasks",
        f"id=in.({fx.task_a_id},{fx.task_b_id})",
        expected_count=1,
        leaked_id=fx.task_b_id,
    )
    await assert_isolation(
        "task_executions",
        f"id=in.({fx.task_execution_a_id},{fx.task_execution_b_id})",
        expected_count=1,
        leaked_id=fx.task_execution_b_id,
    )
    await assert_isolation(
        "acceptance_criteria",
        f"id=in.({fx.acceptance_criteria_a_id},{fx.acceptance_criteria_b_id})",
        expected_count=1,
        leaked_id=fx.acceptance_criteria_b_id,
    )

    # ─── T-D-17: chat / mocks / comments / approval_inbox ──────────
    await assert_isolation(
        "chat_threads",
        f"id=in.({fx.chat_thread_a_id},{fx.chat_thread_b_id})",
        expected_count=1,
        leaked_id=fx.chat_thread_b_id,
    )
    await assert_isolation(
        "chat_messages",
        f"id=in.({fx.chat_message_a_id},{fx.chat_message_b_id})",
        expected_count=1,
        leaked_id=fx.chat_message_b_id,
    )
    await assert_isolation(
        "mocks",
        f"id=in.({fx.mock_a_id},{fx.mock_b_id})",
        expected_count=1,
        leaked_id=fx.mock_b_id,
    )
    await assert_isolation(
        "comments",
        f"id=in.({fx.comment_a_id},{fx.comment_b_id})",
        expected_count=1,
        leaked_id=fx.comment_b_id,
    )
    await assert_isolation(
        "approval_inbox",
        f"id=in.({fx.approval_inbox_a_id},{fx.approval_inbox_b_id})",
        expected_count=1,
        leaked_id=fx.approval_inbox_b_id,
    )

    # ─── T-D-18: knowledge_nodes (polymorphic, workspace-scoped) ──
    await assert_isolation(
        "knowledge_nodes",
        f"id=in.({fx.knowledge_node_a_id},{fx.knowledge_node_b_id})",
        expected_count=1,
        leaked_id=fx.knowledge_node_b_id,
    )

    # ─── T-D-19: audit_logs / consents / external_uploads ──────────
    await assert_isolation(
        "audit_logs",
        f"id=in.({fx.audit_log_a_id},{fx.audit_log_b_id})",
        expected_count=1,
        leaked_id=fx.audit_log_b_id,
    )
    await assert_isolation(
        "consents",
        f"id=in.({fx.consent_a_id},{fx.consent_b_id})",
        expected_count=1,
        leaked_id=fx.consent_b_id,
    )
    await assert_isolation(
        "external_uploads",
        f"id=in.({fx.external_upload_a_id},{fx.external_upload_b_id})",
        expected_count=1,
        leaked_id=fx.external_upload_b_id,
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
