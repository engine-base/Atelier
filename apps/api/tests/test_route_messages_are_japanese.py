"""利用者へ返す文言が日本語であることを機械で守る (GAP-218 / 拡張: GAP-225)。

なぜ書き直したか
----------------
GAP-218 でこの検査を入れたのに、**2 つの穴からすり抜けが起きていた**。

穴 1: 見ていたのが `src/routes/` だけだった。
    利用者に文言を返すのは route だけではない。券の検証は `src/dependencies.py`、
    混雑の制限は `src/rate_limit.py` にあり、**どちらも route より手前**で応答を
    返す。手前で返す文言は、route を見る検査からは永久に外れる。
    実測 (2026-08-26 / 通し J22-02):
        GET /me → 401 {"detail":"missing bearer token"}
        壊れた券 → 401 {"detail":"malformed token"}
    画面は `detail` をそのまま出す (`apps/web/lib/auth/*.ts`)。

穴 2: 正規表現が f 文字列を拾えなかった。
    `HTTPException(status.X, f"...")` は「カンマの次が引用符」という形に
    当たらない。
    routes の中にいながら 4 件が検査の外にいて、うち 2 件が英語だった
    (`attachment storage_path must belong to this thread: {file_name}` /
     `output has no rendered {format} yet`)。

**同じ壊れ方が次に起きる形**はこう書ける:
「利用者に届く文言が、検査の見ている場所の外に置かれる」。だから今回は
場所 (routes → src 全体) と 書き方 (リテラル → 定数・f 文字列) の両方を塞ぐ。

構文木で読む
------------
正規表現は書き方が少し変わるだけで無言で 0 件になる。ここでは `ast` で
`raise HTTPException(...)` の第 2 引数を取り、

  - 文字列リテラル           → そのまま
  - f 文字列                 → 定数部分をつないだもの
  - 同じモジュールの定数名   → その代入値

まで解決する。**定数に逃がしても検査から隠れられない。**
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
_JA = re.compile(r"[ぁ-んァ-ン一-龯]")

#: 日本語でなくてよいもの → その理由。**空欄で増やさない。**
#:
#: 画面が分岐に使う機械可読コードだけを認める。利用者に見せる文言として
#: 使ってはならず、必ず画面側で日本語に置き換えること。
_ALLOWED: dict[str, str] = {
    "reauth_required": (
        "画面 (CredentialList.tsx) がこの値で分岐してパスワード入力欄を出す。"
        "利用者にはそこで日本語の案内が出る"
    ),
    "invalid_password": ("同上。CredentialList.tsx が「パスワードが違います」に置き換えて表示する"),
}


def _constants(tree: ast.Module) -> dict[str, str]:
    """モジュール直下の `NAME = "文字列"` を集める。"""
    out: dict[str, str] = {}
    for node in tree.body:
        # 三項で value を取ると node の型が絞られたままにならないので、
        # 代入の種類ごとに分けて書く (targets の要素型もここで確定する)。
        targets: list[ast.expr]
        if isinstance(node, ast.Assign):
            value = node.value
            targets = list(node.targets)
        elif isinstance(node, ast.AnnAssign):
            value = node.value
            targets = [node.target]
        else:
            continue
        if not isinstance(value, ast.Constant) or not isinstance(value.value, str):
            continue
        text_value: str = value.value
        for target in targets:
            if isinstance(target, ast.Name):
                out[target.id] = text_value
    return out


def _module_constants(module: str) -> dict[str, str]:
    """`src.auth_messages` のような名前からその定数表を読む (無ければ空)。"""
    path = SRC.joinpath(*module.removeprefix("src.").split(".")).with_suffix(".py")
    if not path.exists():
        path = SRC.joinpath(*module.removeprefix("src.").split("."), "__init__.py")
    if not path.exists():
        return {}
    return _constants(ast.parse(path.read_text(encoding="utf-8")))


def _imported_constants(tree: ast.Module) -> dict[str, str]:
    """`from src.auth_messages import TOKEN_REJECTED` の中身まで辿る。

    **定数を別ファイルに置いただけで検査から消える**のを防ぐ。
    """
    out: dict[str, str] = {}
    for node in tree.body:
        if not isinstance(node, ast.ImportFrom) or not node.module:
            continue
        if not node.module.startswith("src."):
            continue
        table = _module_constants(node.module)
        for alias in node.names:
            if alias.name in table:
                out[alias.asname or alias.name] = table[alias.name]
    return out


def _resolve(node: ast.expr, consts: dict[str, str]) -> str | None:
    """文言を表す式から、実際に利用者へ届く文字列を取り出す。"""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):  # f"..."
        return "".join(
            v.value for v in node.values if isinstance(v, ast.Constant) and isinstance(v.value, str)
        )
    if isinstance(node, ast.Name):
        return consts.get(node.id)
    return None


def _callee(node: ast.expr) -> str:
    """`user_detail(exc)` → "user_detail"。呼び出しでなければ式の種類名。"""
    if isinstance(node, ast.Call):
        func = node.func
        return func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "?")
    return type(node).__name__


def _messages(*, hidden: list[tuple[str, str]] | None = None) -> list[tuple[str, str]]:
    """(場所, 利用者に届く文言) の一覧。読めない式は `hidden` に積む。"""
    out: list[tuple[str, str]] = []
    for path in sorted(SRC.rglob("*.py")):
        if "_generated" in path.parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        consts = _imported_constants(tree) | _constants(tree)
        where = path.relative_to(SRC).as_posix()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
            if name not in ("HTTPException", "service_unavailable") or len(node.args) < 2:
                continue
            if where == "errors.py" and name == "HTTPException":
                # service_unavailable() の中身。文言は**呼び出し側**が渡すので、
                # ここではなく呼び出し側 (下の service_unavailable(...)) を見る。
                continue
            message = _resolve(node.args[1], consts)
            if message:
                out.append((where, message))
            elif hidden is not None:
                hidden.append((where, _callee(node.args[1])))
    return out


_HIDDEN: list[tuple[str, str]] = []
_ALL = _messages(hidden=_HIDDEN)


def test_利用者に返す文言はすべて日本語() -> None:
    bad = [(f, m) for f, m in _ALL if not _JA.search(m) and m not in _ALLOWED]
    assert not bad, "英語のまま利用者に届く文言があります:\n" + "\n".join(
        f"  {f}: {m}" for f, m in bad
    )


@pytest.mark.parametrize(("where", "message"), [(f, m) for f, m in _ALL if _JA.search(m)])
def test_文言に内部の識別子を混ぜない(where: str, message: str) -> None:
    """`byok_key not found` のような内部名が日本語文に紛れ込むのを防ぐ。"""
    assert not re.search(r"\b[a-z]+_[a-z_]+\b", message), f"{where}: 内部名が混じっている"
    assert not re.search(r"\bGAP-\d+", message), f"{where}: 社内の管理番号が混じっている"


def test_見張る対象が実際に存在する() -> None:
    """構文木の読み方が古くなって 0 件しか拾えなくなったら、この門は無言で無力化する。"""
    assert len(_ALL) > 250, f"文言をほとんど拾えていない ({len(_ALL)} 件)"


@pytest.mark.parametrize("where", ["dependencies.py", "rate_limit.py"])
def test_routeの外も見ている(where: str) -> None:
    """GAP-225 の再発防止 — 検査の範囲が routes/ に縮んだら落とす。

    ここが空になるのは「見る場所を狭めた」ときだけで、そのとき英語が戻っても
    誰も気づかない。**範囲そのものを検査する。**
    """
    assert [m for f, m in _ALL if f == where], f"{where} の文言を 1 件も拾えていない"


def test_許可した英語には理由がある() -> None:
    for code, reason in _ALLOWED.items():
        assert reason.strip(), f"{code}: 理由が空 — 空欄で許可を増やさない"


#: 文言を静的に取り出せない書き方 → その理由。**空欄で増やさない。**
#:
#: 定数でも f 文字列でもない式を detail に渡すと、この門からは中身が見えない。
#: **見えないものは守れない**ので、増やすときは「なぜ静的に決められないのか」と
#: 「代わりに何が文言を保証するのか」を書く。
_HIDDEN_OK: dict[str, str] = {
    "routes/cron/__init__.py: str(...)": (
        "CronExpressionError は利用者が書いた式のどこが悪いかを日本語で指す。"
        "日本語であることは test_cron_messages_are_japanese.py が固定する"
    ),
    "user_detail": "code → 日本語の表から引く (GAP-216)。表の中身は test_user_messages.py が固定",
    "unhandled_detail": "文言 + 参照 ID。文言は test_unhandled_error_message.py が固定",
    "validation_detail": "項目名 + 理由を組み立てる。中身は test_validation_error_response.py が固定",
    # GAP-280: 残件の **実数と中身** を本文に載せる。汎用文言だけでは「何が残って
    # いるのか」が分からず、利用者が片付けられない。PhaseError.message は
    # services/flow/phases.py で日本語を組み立てている。
    "routes/flow/__init__.py: Attribute(...)": (
        "PhaseError(open_items).message — 残件の実数を載せる (GAP-280)。"
        "日本語であることは test_phase_freeze_open_items.py が固定する"
    ),
    # GAP-285: 意味検索が使えない理由 + 次にやることを繋げる。
    # 前半は f 文字列の定数、後半は次にやること (可変数) の連結。
    "routes/knowledge/__init__.py: BinOp(...)": (
        "「準備を開始できません: <理由>（<次にやること>）」を組み立てる (GAP-285)。"
        "理由と次の手順は embeddings/route.py の日本語を使う"
    ),
    # GAP-284: 対応していない形式の **拡張子** を本文に出す。
    "routes/meetings/__init__.py: Name(...)": (
        "unsupported_file_reason() の戻り値 (日本語)。拡張子を含めて返す (GAP-284)。"
        "日本語であることは test_meetings_unsupported_format.py が固定する"
    ),
}


def test_文言を隠せる書き方が増えていない() -> None:
    """関数呼び出しの陰に文言を逃がすと、この門は素通りする (GAP-225 で実際に踏んだ)。"""
    bad = sorted(
        {
            f"{where}: {callee}(...)"
            for where, callee in _HIDDEN
            if callee not in _HIDDEN_OK and f"{where}: {callee}(...)" not in _HIDDEN_OK
        }
    )
    assert not bad, (
        "detail を静的に読めない書き方があります。定数か f 文字列にするか、"
        "_HIDDEN_OK に理由つきで足してください:\n  " + "\n  ".join(bad)
    )


def test_隠すことを認めた書き方には理由がある() -> None:
    for callee, reason in _HIDDEN_OK.items():
        assert reason.strip(), f"{callee}: 理由が空 — 空欄で許可を増やさない"
