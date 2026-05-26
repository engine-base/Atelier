"""API ルータ集約点 (T-A-06〜)。

各リソースのルータをここで集約し、main.py が api_router を 1 つ include する。
"""

from __future__ import annotations

from fastapi import APIRouter

from src.routes.workspaces import router as workspaces_router

api_router = APIRouter()
api_router.include_router(workspaces_router)

__all__ = ["api_router"]
