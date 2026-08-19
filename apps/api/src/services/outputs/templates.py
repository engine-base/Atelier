"""GAP-158: 出力デザインテンプレート (workspace 単位・版連鎖・ワンダ生成)。

経営者フィードバック (2026-08-19) による GAP-154 の作り直し:
  「テンプレはフォーマット (構成) ではなく出力のデザイン。内容 (md/json) は
   スキルで整える。最後に人間 (クライアント) に見せる HTML や PDF のデザインの
   テンプレ。Open Design の機能で作る状態で十分」

設計:
  - 実体 = HTML 1 枚 (mockdb 保存・版連鎖)。モックスタジオ (Open Design 型) と
    同じく「ワンダに指示 → HTML → プレビュー → 指示で改訂 = 新版」。
  - LLM は relay (本人サブスク) → agent_sdk → API → fake の確定チェーン
    (GAP-138 と同一 — デザイン作業は利用者の作業なので本人のサブスクで実行)。
  - 注入の意味論: 「内容の構成はスキル・指示が決める。見た目はこのテンプレに
    従う」— 成果物の生成 (チャット) と改訂 (スティーブ) の system prompt に
    自動注入し、最終 HTML の視覚デザインを揃える。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.outputs import OutputDesignTemplateResponse

# 成果物の stage 体系 (workflow_stage_enum) に対する表示名。
STAGE_LABELS: dict[str, str] = {
    "estimate": "見積書",
    "proposal": "提案書",
    "invoice": "請求書",
    "contract": "契約書",
    "nda": "NDA",
    "requirements": "要件定義書",
    "architecture": "アーキ設計書",
    "design": "デザイン仕様書",
    "verification": "テスト仕様書",
    "delivery": "納品書・完了報告",
}

_MAX_INJECT_CHARS = 8000
_MAX_TEMPLATE_CHARS = 120_000

_SUMMARY_MARKER = "---SUMMARY---"

_DESIGN_SYSTEM = (
    "あなたは Atelier の AI デザイナー「ワンダ」です。クライアントに提出する"
    "ビジネス文書の【デザインテンプレート】を HTML 1 枚で作成・改訂します。\n"
    "契約 (必ず守ること):\n"
    "1) 出力は完全な HTML 全文のみ (<!doctype html> から)。説明文・コードフェンス禁止。\n"
    "2) これは見た目の型 — 内容はダミー (プレースホルダー) でよい。レイアウト・"
    "配色・タイポグラフィ・表の様式・余白が本体。\n"
    "3) A4 縦の印刷/PDF 出力に耐えること (紙面を想定した幅・@media print 考慮)。\n"
    "4) 外部リソース (CDN/画像 URL) に依存しない。CSS は <style> に内包。\n"
    "5) 改訂時は指示された箇所以外のデザインを勝手に変えないこと。\n"
    f"最終行にサマリーを出力: {_SUMMARY_MARKER} の行に続けて変更・特徴の要約 1 行。"
)


class DesignTemplateError(Exception):
    """構造的失敗 (code: llm_unconfigured / bridge_offline / llm_failed / not_found)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


_COLS = (
    "id, workspace_id, stage::text as stage, version, html_storage_path, note, "
    "is_platform_default, created_at"
)


def _to_response(row: Any) -> OutputDesignTemplateResponse:
    stage = str(row.stage)
    is_default = bool(row.is_platform_default)
    return OutputDesignTemplateResponse(
        id=str(row.id),
        workspace_id=None if row.workspace_id is None else str(row.workspace_id),
        stage=stage,
        stage_label=STAGE_LABELS.get(stage, stage),
        version=int(row.version),
        note=str(row.note),
        # GAP-159: この版が運営既定か WS 自前か — UI が「継承中」を出し分ける
        source="platform" if is_default else "workspace",
        created_at=row.created_at,
    )


async def _workspace_visible(session: AsyncSession, workspace_id: str) -> bool:
    row = (
        await session.execute(
            text("select 1 from public.workspaces where id = cast(:w as uuid)"),
            {"w": workspace_id},
        )
    ).first()
    return row is not None


async def list_templates(
    session: AsyncSession, *, workspace_id: str
) -> list[OutputDesignTemplateResponse] | None:
    """種類ごとの「実効デザイン」一覧 (WS 自前版 > 運営既定)。不可視 workspace は None。

    GAP-159: WS がまだ作っていない種類は運営既定 (is_platform_default) を継承して
    返す。UI は source で「継承中 / このワークスペースで変更済み」を出し分ける。
    """
    if not await _workspace_visible(session, workspace_id):
        return None
    rows = (
        await session.execute(
            text(
                f"select distinct on (stage) {_COLS} "
                "from public.output_design_templates "
                "where workspace_id = cast(:w as uuid) "
                "order by stage, version desc"
            ),
            {"w": workspace_id},
        )
    ).all()
    out = [_to_response(r) for r in rows]
    own = {t.stage for t in out}
    for d in await list_platform_templates(session):
        if d.stage not in own:
            out.append(d)
    return sorted(
        out, key=lambda t: list(STAGE_LABELS).index(t.stage) if t.stage in STAGE_LABELS else 99
    )


async def list_platform_templates(
    session: AsyncSession,
) -> list[OutputDesignTemplateResponse]:
    """運営既定の種類ごと最新版 (全テナントが継承する初期デザイン)。"""
    rows = (
        await session.execute(
            text(
                f"select distinct on (stage) {_COLS} "
                "from public.output_design_templates "
                "where is_platform_default order by stage, version desc"
            )
        )
    ).all()
    return [_to_response(r) for r in rows]


async def list_versions(
    session: AsyncSession, *, workspace_id: str | None, stage: str
) -> list[OutputDesignTemplateResponse] | None:
    """版履歴。workspace_id=None は運営既定の版履歴 (管理画面用)。"""
    if stage not in STAGE_LABELS:
        return []
    if workspace_id is None:
        rows = (
            await session.execute(
                text(
                    f"select {_COLS} from public.output_design_templates "
                    "where is_platform_default "
                    "and stage = cast(:s as workflow_stage_enum) order by version desc"
                ),
                {"s": stage},
            )
        ).all()
        return [_to_response(r) for r in rows]
    if not await _workspace_visible(session, workspace_id):
        return None
    rows = (
        await session.execute(
            text(
                f"select {_COLS} from public.output_design_templates "
                "where workspace_id = cast(:w as uuid) "
                "and stage = cast(:s as workflow_stage_enum) order by version desc"
            ),
            {"w": workspace_id, "s": stage},
        )
    ).all()
    return [_to_response(r) for r in rows]


async def get_template(
    session: AsyncSession, *, template_id: str
) -> OutputDesignTemplateResponse | None:
    row = (
        await session.execute(
            text(f"select {_COLS} from public.output_design_templates where id = cast(:i as uuid)"),
            {"i": template_id},
        )
    ).first()
    return None if row is None else _to_response(row)


async def template_html_path(session: AsyncSession, *, template_id: str) -> str | None:
    row = (
        await session.execute(
            text(
                "select html_storage_path from public.output_design_templates "
                "where id = cast(:i as uuid)"
            ),
            {"i": template_id},
        )
    ).first()
    return None if row is None else str(row.html_storage_path)


def _fake_template(stage: str, instruction: str, base_html: str | None) -> str:
    """ATELIER_ALLOW_FAKE_LLM=1 のみの決定的スタブ (配線検証用)。"""
    label = STAGE_LABELS.get(stage, stage)
    revised = "" if base_html is None else '<div data-fake-revision="1"></div>'
    return (
        '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
        f"<title>{label}テンプレート</title>"
        "<style>body{font-family:serif;margin:40px}h1{border-bottom:2px solid #333}"
        "table{width:100%;border-collapse:collapse}td,th{border:1px solid #999;padding:8px}"
        "</style></head><body>"
        f'<h1>{label}</h1><p data-fake-template="1">[fake] {instruction[:80]}</p>'
        f"{revised}"
        "<table><tr><th>項目</th><th>内容</th></tr><tr><td>{{項目}}</td><td>{{内容}}</td></tr></table>"
        f"</body></html>\n{_SUMMARY_MARKER}\n[fake] デザインテンプレを更新: {instruction[:60]}"
    )


def _split_summary(raw: str) -> tuple[str, str]:
    if _SUMMARY_MARKER in raw:
        html, _, tail = raw.rpartition(_SUMMARY_MARKER)
        return html.strip(), tail.strip()[:200]
    return raw.strip(), ""


def _strip_fence(t: str) -> str:
    t = t.strip()
    if t.startswith("```"):
        nl = t.find("\n")
        if nl >= 0:
            t = t[nl + 1 :]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


async def create_version(
    session: AsyncSession,
    *,
    actor_id: str,
    workspace_id: str | None,
    stage: str,
    instruction: str,
    reference_files: list[dict[str, object]] | None = None,
) -> OutputDesignTemplateResponse | None:
    """ワンダがデザインテンプレを作成/改訂して新版を積む (Open Design 型)。

    既存版があれば現行 HTML を渡して改訂、無ければ新規作成。
    GAP-159: workspace_id=None は運営既定 (全テナントが継承する初期デザイン) の
    作成/改訂 — 管理画面から service 経路で呼ぶ。WS 側で既存版が無い種類は
    運営既定を土台に改訂する (継承しているものを直す、が自然な操作のため)。
    LLM は relay (本人サブスク) 起点の確定チェーン。不可視 workspace は None。
    """
    from src.services.chat_sse.llm_chain import LLMUnavailable, llm_complete
    from src.services.mocks.artifacts import (
        MOCKDB_PREFIX,
        fetch_content_service,
        store_content_service,
    )

    is_platform = workspace_id is None
    if stage not in STAGE_LABELS:
        raise DesignTemplateError("not_found", f"unknown template kind: {stage}")
    if not is_platform and not await _workspace_visible(session, workspace_id or ""):
        return None
    if is_platform:
        latest = (
            await session.execute(
                text(
                    "select version, html_storage_path from public.output_design_templates "
                    "where is_platform_default and stage = cast(:s as workflow_stage_enum) "
                    "order by version desc limit 1"
                ),
                {"s": stage},
            )
        ).first()
    else:
        latest = (
            await session.execute(
                text(
                    "select version, html_storage_path from public.output_design_templates "
                    "where workspace_id = cast(:w as uuid) "
                    "and stage = cast(:s as workflow_stage_enum) "
                    "order by version desc limit 1"
                ),
                {"w": workspace_id, "s": stage},
            )
        ).first()
    base_path: str | None = None if latest is None else str(latest.html_storage_path)
    if base_path is None and not is_platform:
        # GAP-159: WS 版がまだ無い種類は、継承中の運営既定を土台に改訂する
        base_path = await _platform_default_path(session, stage=stage)
    base_html: str | None = None
    if base_path is not None and base_path.startswith(MOCKDB_PREFIX):
        base_html = await fetch_content_service(base_path[len(MOCKDB_PREFIX) :])
    label = STAGE_LABELS[stage]
    if base_html is None:
        user_text = (
            f"種類: {label} のデザインテンプレートを新規作成してください。\n要望: {instruction}"
        )
    else:
        user_text = (
            f"種類: {label} の現行デザインテンプレートを改訂してください。\n"
            f"修正指示: {instruction}\n\n現行 HTML:\n{base_html[:_MAX_TEMPLATE_CHARS]}"
        )
    system_prompt = _DESIGN_SYSTEM
    if reference_files:
        # GAP-161: 既存の請求書 PDF・ロゴ画像・Excel など「これに寄せて」の資料
        from src.services.attachments import extract_stored_attachments, render_reference_block

        ref_block = render_reference_block(await extract_stored_attachments(reference_files))
        if ref_block:
            system_prompt = f"{_DESIGN_SYSTEM}\n\n{ref_block}"
    try:
        out, provider = await llm_complete(
            system_prompt=system_prompt,
            user_text=user_text,
            actor_id=actor_id,
            max_tokens=16384,
            fake=lambda: _fake_template(stage, instruction, base_html),
        )
    except LLMUnavailable as exc:
        code = "bridge_offline" if exc.code == "bridge_offline" else "llm_unconfigured"
        raise DesignTemplateError(code, exc.message) from exc
    html, summary = _split_summary(_strip_fence(out))
    if not html:
        raise DesignTemplateError("llm_failed", "ワンダが空のテンプレを返しました")
    content_id = await store_content_service(html)
    next_version = 1 if latest is None else int(latest.version) + 1
    row = await _insert_version(
        session,
        workspace_id=workspace_id,
        stage=stage,
        version=next_version,
        html_path=f"{MOCKDB_PREFIX}{content_id}",
        note=(summary or instruction[:200]),
        actor_id=actor_id,
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="design_template.version",
            target_type="platform" if is_platform else "workspace",
            actor_type="user",
            actor_id=actor_id,
            target_id=workspace_id or "platform",
            after={
                "stage": stage,
                "version": next_version,
                "provider": provider,
                "platform_default": is_platform,
            },
        )
    )
    return _to_response(row)


async def _platform_default_path(session: AsyncSession, *, stage: str) -> str | None:
    row = (
        await session.execute(
            text(
                "select html_storage_path from public.output_design_templates "
                "where is_platform_default and stage = cast(:s as workflow_stage_enum) "
                "order by version desc limit 1"
            ),
            {"s": stage},
        )
    ).first()
    return None if row is None else str(row.html_storage_path)


async def _insert_version(
    session: AsyncSession,
    *,
    workspace_id: str | None,
    stage: str,
    version: int,
    html_path: str,
    note: str,
    actor_id: str,
) -> Any:
    return (
        await session.execute(
            text(
                "insert into public.output_design_templates "
                "(workspace_id, stage, version, html_storage_path, note, created_by, "
                " is_platform_default) "
                "values (cast(:w as uuid), cast(:s as workflow_stage_enum), :v, :p, :n, "
                "        cast(:u as uuid), :d) "
                f"returning {_COLS}"
            ),
            {
                "w": workspace_id,
                "s": stage,
                "v": version,
                "p": html_path,
                "n": note,
                "u": actor_id,
                "d": workspace_id is None,
            },
        )
    ).one()


async def reset_to_platform_default(
    session: AsyncSession, *, actor_id: str, workspace_id: str, stage: str
) -> OutputDesignTemplateResponse | None:
    """WS のデザインを運営既定に戻す (GAP-159)。

    削除ではなく「既定の HTML を中身とする新版」を積む — 履歴不滅の原則を保ち、
    戻したこと自体も版として残す。既定が未設定の種類は not_found。
    """
    if stage not in STAGE_LABELS:
        raise DesignTemplateError("not_found", f"unknown template kind: {stage}")
    if not await _workspace_visible(session, workspace_id):
        return None
    default_path = await _platform_default_path(session, stage=stage)
    if default_path is None:
        raise DesignTemplateError("not_found", "この種類の運営既定デザインはまだ設定されていません")
    latest = (
        await session.execute(
            text(
                "select version from public.output_design_templates "
                "where workspace_id = cast(:w as uuid) "
                "and stage = cast(:s as workflow_stage_enum) order by version desc limit 1"
            ),
            {"w": workspace_id, "s": stage},
        )
    ).first()
    if latest is None:
        # まだ自前版が無い = すでに既定を継承中。新版は積まない (無駄な履歴を作らない)
        raise DesignTemplateError("already_default", "すでに運営既定を継承しています")
    row = await _insert_version(
        session,
        workspace_id=workspace_id,
        stage=stage,
        version=int(latest.version) + 1,
        html_path=default_path,
        note="運営の既定デザインに戻しました",
        actor_id=actor_id,
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="design_template.reset_to_default",
            target_type="workspace",
            actor_type="user",
            actor_id=actor_id,
            target_id=workspace_id,
            after={"stage": stage, "version": int(latest.version) + 1},
        )
    )
    return _to_response(row)


# ── 注入 (生成・改訂の system prompt) — 「内容はスキル、見た目はこのテンプレ」 ──


def render_design_block(*, stage: str, version: int, html: str) -> str:
    label = STAGE_LABELS.get(stage, stage)
    # GAP-159: version 0 = 運営既定を継承中 (WS 自前版が無い状態)
    ver = "運営既定" if version == 0 else f"v{version}"
    return (
        f"# 出力デザインテンプレート: {label}（{ver}）\n"
        "このワークスペースで定めた「見た目の型」。最終的に人 (クライアント) に"
        "見せる HTML を作る・改訂するときは、このテンプレのレイアウト・CSS・"
        "表の様式・トーンを踏襲し、内容 (テキスト・数値・項目) だけを依頼内容と"
        "スキルの構成に従って差し替えること。デザインを勝手に変えないこと。\n---\n"
        + html[:_MAX_INJECT_CHARS]
    )


async def design_template_for_stage(
    session: AsyncSession, *, project_id: str, stage: str
) -> tuple[int, str] | None:
    """project の workspace の該当種類の実効デザイン (version, html)。

    GAP-159: WS 自前版が無ければ運営既定を継承する — 初期状態でも
    「運営が用意した既定デザイン」で成果物が出る。
    """
    from src.services.mocks.artifacts import MOCKDB_PREFIX, fetch_content_service

    if stage not in STAGE_LABELS:
        # GAP-159: デザインテンプレを持たない工程 (議事録・タスク分解等) は注入しない
        return None
    row = (
        await session.execute(
            text(
                "select t.version, t.html_storage_path "
                "from public.output_design_templates t "
                "join public.projects p on p.workspace_id = t.workspace_id "
                "where p.id = cast(:p as uuid) "
                "and t.stage = cast(:s as workflow_stage_enum) "
                "order by t.version desc limit 1"
            ),
            {"p": project_id, "s": stage},
        )
    ).first()
    if row is None:
        default_path = await _platform_default_path(session, stage=stage)
        if default_path is None or not default_path.startswith(MOCKDB_PREFIX):
            return None
        html = await fetch_content_service(default_path[len(MOCKDB_PREFIX) :])
        return None if html is None else (0, html)
    path = str(row.html_storage_path)
    if not path.startswith(MOCKDB_PREFIX):
        return None
    html = await fetch_content_service(path[len(MOCKDB_PREFIX) :])
    return None if html is None else (int(row.version), html)


async def templates_context_block(session: AsyncSession, *, project_id: str) -> str:
    """チャット注入用: 現在工程 (active フェーズの current stage) のデザインテンプレ。"""
    row = (
        await session.execute(
            text(
                "select fs.stage_key from public.project_flow_stages fs "
                "join public.delivery_phases dp on dp.id = fs.delivery_phase_id "
                "where fs.project_id = cast(:p as uuid) and dp.status = 'active' "
                "and fs.status = 'pending' order by fs.seq limit 1"
            ),
            {"p": project_id},
        )
    ).first()
    if row is None:
        return ""
    found = await design_template_for_stage(
        session, project_id=project_id, stage=str(row.stage_key)
    )
    if found is None:
        return ""
    version, html = found
    return render_design_block(stage=str(row.stage_key), version=version, html=html)
