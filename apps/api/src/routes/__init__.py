"""API ルータ集約点 (T-A-06〜)。

各リソースのルータをここで集約し、main.py が api_router を 1 つ include する。
"""

from __future__ import annotations

from fastapi import APIRouter

from src.routes.ai_employees import router as ai_employees_router
from src.routes.mocks import router as mocks_router
from src.routes.projects import router as projects_router
from src.routes.tasks import router as tasks_router
from src.routes.workspaces import router as workspaces_router

api_router = APIRouter()
api_router.include_router(workspaces_router)
api_router.include_router(projects_router)
api_router.include_router(tasks_router)
api_router.include_router(mocks_router)
api_router.include_router(ai_employees_router)

__all__ = ["api_router"]
