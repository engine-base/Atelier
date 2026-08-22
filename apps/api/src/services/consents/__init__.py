"""GAP-206: **規約を新しくしたのに、既存ユーザーが同意していない**を解消する。

**これまでの実態**:
    同意 (`consents`) は **新規登録のときだけ**記録していた。規約を新版に
    差し替えても、既に登録済みの人へ再同意を求める手段が無かった。

    GAP-188 で「各自の Claude 契約が必要」を、GAP-204 で「複製・模倣の禁止 /
    機械学習への利用禁止」を規約へ足した。だが **旧版に同意したままの利用者に
    その条項は効きにくい**。つまり足した意味が半分失われていた。

**この GAP でやること**:
    - 「同意済みの版」と「今の版」を突き合わせ、**ずれている人を検出**する
    - 何が変わったのかを示したうえで、同意を記録し直す口を用意する
    - **旧版の記録は消さない** (append-only。いつ何に同意したかを残す)

**やらないこと (正直に)**:
    - **同意するまで使わせない、という強制はしない**。それは法務レビューの
      結果と経営判断で決めることで、実装が先走ってよいものではない。
      ここで作るのは「求められる状態」であって「強制」ではない。
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

#: 再同意の対象。`consent_type_enum` のうち、法令ページと対になるもの。
REQUIRED_TYPES: tuple[str, ...] = ("terms_of_service", "privacy_policy")


@dataclass(frozen=True)
class ConsentStatus:
    """1 種類ぶんの同意状況。"""

    doc_type: str
    #: 今 有効な版 (legal_documents.is_current)
    current_version: str | None
    #: この人が最後に同意した版 (未同意なら None)
    accepted_version: str | None

    @property
    def needs_consent(self) -> bool:
        """同意し直しが要るか。

        現行版が無ければ求めない (求めようがない)。未同意も「要る」に含める。
        """
        if self.current_version is None:
            return False
        return self.accepted_version != self.current_version


async def consent_status(session: AsyncSession, *, user_id: str) -> list[ConsentStatus]:
    """この人の同意状況を、対象の種類ぶん返す。

    **同意した版は append-only で複数行ある**ので、最新の 1 件を採る。
    `accepted = false` (拒否) は「同意していない」として扱う。
    """
    res = await session.execute(
        text(
            "select d.doc_type,"
            "       d.version as current_version,"
            "       ("
            "         select c.version from public.consents c"
            "          where c.user_id = cast(:u as uuid)"
            "            and c.type::text = d.doc_type"
            "            and c.accepted"
            "          order by c.accepted_at desc limit 1"
            "       ) as accepted_version"
            "  from public.legal_documents d"
            " where d.is_current and d.locale = :loc and d.doc_type = any(:types)"
            " order by d.doc_type"
        ),
        {"u": user_id, "loc": "ja", "types": list(REQUIRED_TYPES)},
    )
    return [
        ConsentStatus(
            doc_type=str(r.doc_type),
            current_version=None if r.current_version is None else str(r.current_version),
            accepted_version=None if r.accepted_version is None else str(r.accepted_version),
        )
        for r in res.all()
    ]


async def pending_consents(session: AsyncSession, *, user_id: str) -> list[ConsentStatus]:
    """同意し直しが要るものだけ。"""
    return [s for s in await consent_status(session, user_id=user_id) if s.needs_consent]


class ConsentError(Exception):
    """同意を記録できない (存在しない版 / 対象外の種類)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def accept_current(
    session: AsyncSession,
    *,
    user_id: str,
    doc_type: str,
    version: str,
    ip_address: str | None = None,
    user_agent: str | None = None,
) -> ConsentStatus:
    """現行版への同意を記録する。

    **版を指定させる**のは、画面が見せた版と記録する版が食い違わないため
    (画面が古いまま「同意」を押しても、その古い版で記録されないようにする)。
    """
    if doc_type not in REQUIRED_TYPES:
        raise ConsentError("unsupported_type", f"同意の対象外です: {doc_type}")

    row = (
        await session.execute(
            text(
                "select version from public.legal_documents"
                " where doc_type = :dt and locale = 'ja' and is_current"
            ),
            {"dt": doc_type},
        )
    ).first()
    if row is None:
        raise ConsentError("no_current_version", f"現行の{doc_type}がありません")
    current = str(row.version)
    if current != version:
        # 画面が古い版を見ていた。**黙って現行版で記録しない** — 見ていない
        # 文面に同意させることになるため、やり直してもらう。
        raise ConsentError(
            "version_mismatch",
            f"表示中の版が古くなっています (表示 {version} / 現行 {current})。"
            "最新の内容を読み直してから同意してください。",
        )

    await session.execute(
        text(
            "insert into public.consents (user_id, type, version, accepted, ip_address, user_agent)"
            " values (cast(:u as uuid), cast(:t as consent_type_enum), :v, true,"
            "         cast(:ip as inet), :ua)"
        ),
        {
            "u": user_id,
            "t": doc_type,
            "v": current,
            "ip": ip_address,
            "ua": (user_agent or None) and user_agent[:1000],
        },
    )
    return ConsentStatus(doc_type=doc_type, current_version=current, accepted_version=current)


__all__ = [
    "REQUIRED_TYPES",
    "ConsentError",
    "ConsentStatus",
    "accept_current",
    "consent_status",
    "pending_consents",
]
