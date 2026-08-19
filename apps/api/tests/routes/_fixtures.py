"""GAP-173: 実運用に近い DB (運営シード適用済み) でもテストが成立するための補助。

`workspaces` には運営シードの AI 社員テンプレを実体化するトリガ
(`workspaces_bootstrap_ai_employees`) が付いている。そのためテストが自前で
`insert into ai_employees ... 'steve'` すると **ユニーク制約 (workspace_id, name)
と衝突して落ちる**。CI はシードを入れない DB を使うので気づけず、
**本番や開発機に近い DB ほど落ちる**という逆転が起きていた。

ここでは「その名前の社員が居ることを保証し、実際の id を返す」形に統一する
(既に居ればそれを使う)。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text


def ensure_ai_employee(
    conn: Any,
    *,
    workspace_id: str,
    name: str,
    display_name: str,
    role: str = "lead",
    department: str = "product",
    is_default: bool = False,
    employee_id: str | None = None,
    attached_skills: list[str] | None = None,
) -> str:
    """workspace に指定名の AI 社員が居ることを保証し、その id を返す。

    トリガが既に同名を作っていればその行を使う (id は既存行のもの)。
    `employee_id` は「まだ居なければこの id で作る」という希望値であって、
    既存行がある場合はそちらの id が返る — 呼び出し側は必ず返り値を使うこと。
    """
    params: dict[str, Any] = {
        "w": workspace_id,
        "n": name,
        "d": display_name,
        "r": role,
        "dep": department,
        "isd": is_default,
    }
    id_col = ""
    id_val = ""
    if employee_id is not None:
        id_col = "id, "
        id_val = "cast(:i as uuid), "
        params["i"] = employee_id
    skills_col = ""
    skills_val = ""
    if attached_skills is not None:
        skills_col = ", attached_skills"
        skills_val = ", cast(:sk as uuid[])"
        params["sk"] = attached_skills
    return str(
        conn.execute(
            text(
                f"insert into public.ai_employees "
                f"({id_col}workspace_id, name, display_name, role, department, is_default"
                f"{skills_col}) values ({id_val}cast(:w as uuid), :n, :d, :r, :dep, :isd"
                f"{skills_val}) "
                "on conflict (workspace_id, name) do update set "
                "display_name = excluded.display_name, is_default = excluded.is_default "
                "returning id"
            ),
            params,
        ).scalar_one()
    )
