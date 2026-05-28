"""API ルータ集約点 (T-A-06〜)。

各リソースのルータをここで集約し、main.py が api_router を 1 つ include する。
"""

from __future__ import annotations

from fastapi import APIRouter

from src.routes.admin import router as admin_router
from src.routes.ai_employees import router as ai_employees_router
from src.routes.approvals import router as approvals_router
from src.routes.byok_keys import router as byok_keys_router
from src.routes.chat import router as chat_router
from src.routes.client_invitations import router as client_invitations_router
from src.routes.comments import router as comments_router
from src.routes.impact import router as impact_router
from src.routes.mcp_tokens import router as mcp_tokens_router
from src.routes.mocks import router as mocks_router
from src.routes.outputs import router as outputs_router
from src.routes.projects import router as projects_router
from src.routes.public import router as public_router
from src.routes.tasks import router as tasks_router
from src.routes.workflow import router as workflow_router
from src.routes.workspace_members import router as workspace_members_router
from src.routes.workspaces import router as workspaces_router

api_router = APIRouter()
api_router.include_router(workspaces_router)
api_router.include_router(workspace_members_router)
api_router.include_router(projects_router)
api_router.include_router(tasks_router)
api_router.include_router(mocks_router)
api_router.include_router(ai_employees_router)
api_router.include_router(admin_router)
api_router.include_router(client_invitations_router)
api_router.include_router(chat_router)
api_router.include_router(workflow_router)
api_router.include_router(outputs_router)
api_router.include_router(comments_router)
api_router.include_router(public_router)
api_router.include_router(impact_router)
api_router.include_router(approvals_router)
api_router.include_router(mcp_tokens_router)
api_router.include_router(byok_keys_router)

__all__ = ["api_router"]
