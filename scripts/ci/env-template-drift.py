#!/usr/bin/env python3
"""環境変数テンプレートの drift 検査 (T-F-43 / GAP-107 解消)。

**目的**: 「コードが読む必須の環境変数」と「`.env.example` に登録されている変数」の
乖離を機械検出する。`ATELIER_BYOK_ENCRYPTION_KEY` は未設定だと BYOK API が 500 を
返す必須キーなのに、`apps/api/.env.example` にも `SECRETS.md` にも無かった
(GAP-107)。単発修正で終わらせず、同型の drift を再発させないための検査。

**判定方針** (誤検知でゲートを常時赤にしないための三段):

1. コード側の**既定値つき読み取りは自動で任意扱い**。
   `os.environ.get("X", "claude-sonnet-4-6")` のように**空でないリテラル既定値**が
   あるものは、未設定でも動くので任意とみなす。
   → ただし `os.environ.get("X", "")` は**任意扱いにしない**。これはまさに
      GAP-107 の形 (既定値は空文字で、直後に「未設定なら 500」と分岐する) であり、
      ここを任意にすると検査の意味が無くなる。
2. 上記で拾えないもの (`os.environ.get("FLAG") == "1"` 形の feature flag、
   プラットフォームが自動注入する変数、テスト専用) は **ALLOWLIST に理由つきで**
   明示する。理由文字列が空の項目は起動時に弾く (理由なし許可を作らせない)。
3. それ以外は**必須**。テンプレートに名前が無ければ変数名と読み取り箇所を示して
   exit 1。

**実値混入の検査** (逆方向): テンプレートと `SECRETS.md` には**名前だけ**を書く。
`.env.example` は「`=` の右辺に 1 文字でもあれば値」で判定する。末尾の `=` を
「値なし」と誤判定してはいけない — Fernet 鍵 (SECRETS.md が案内している生成方法
そのもの) は常に `=` で終わるため、実鍵を書いても素通りしてしまう (QA_FAIL-3)。
加えて実値と判別できる形 (Fernet / sk-… / JWT / 接続文字列の資格情報 / 長い乱数) を
テンプレートと運用 docs の両方で検出する。

テンプレートは `NAME=` だけでなく `# NAME=` のコメント形も「登録済み」と扱う
(既存の `.env.example` が任意フラグをコメントで案内しているため)。

usage:
  python3 scripts/ci/env-template-drift.py [--root <repo>] [--verbose]
exit code:
  0 = drift・実値混入なし / 1 = drift または実値混入あり / 2 = 設定エラー
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

# ─────────────────────────────────────────────────────────────────────────────
# ALLOWLIST — 「コードは読むがテンプレートに無くてよい」変数。理由の記載は必須。
# 空文字の理由を書くとこのスクリプト自身が exit 2 で落ちる。
# ─────────────────────────────────────────────────────────────────────────────
ALLOWLIST: dict[str, str] = {
    # --- feature flag: 未設定 = 既定の挙動。運用者が触る必要は通常ない ---
    "ATELIER_ALLOW_FAKE_LLM": "テスト専用の echo LLM フラグ。未設定 = 実 LLM (本番既定)",
    "ATELIER_WEB_SEARCH_DISABLED": "feature flag。未設定 = web_search 有効 (既定)",
    "ATELIER_PROMPT_CACHE_DISABLED": "feature flag。未設定 = prompt cache 有効 (既定)",
    "ATELIER_RATE_LIMIT_DISABLED": "テスト用 kill switch。未設定 = レート制限有効 (既定)",
    "ATELIER_EMAIL_DRY_RUN": "開発時にメール送信を抑止するフラグ。未設定 = 実送信 (既定)",
    "ATELIER_INNGEST_ENABLED": "cron worker の mount フラグ。未設定 = OFF (既定)",
    "ATELIER_CRON_OVERRIDE": "cron 式の一時上書き。未設定 = schedule.cron を使用",
    "ATELIER_SKILLS_DIR": "スキル配置の上書き。未設定 = リポジトリ同梱ディレクトリ",
    "INNGEST_DEV": "Inngest dev server 用トグル。未設定 = 本番モード (既定)",
    # --- プラットフォームが自動注入する (人間が .env に書くものではない) ---
    "NEXT_PUBLIC_VERCEL_ENV": "Vercel が build 時に自動注入する",
    "NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA": "Vercel が build 時に自動注入する",
    "NODE_ENV": "Node.js / Next.js のランタイム既定値。人間が設定しない",
}

# ─────────────────────────────────────────────────────────────────────────────
# 走査対象 — 本番実行経路のみ。テストコードは対象外 (テスト専用 env を拾わない)。
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ScanTarget:
    """1 つの `.env.example` に対応するコード走査範囲。"""

    label: str
    template: str
    paths: tuple[str, ...]
    suffixes: tuple[str, ...]


SCAN_TARGETS: tuple[ScanTarget, ...] = (
    ScanTarget(
        label="apps/api",
        template="apps/api/.env.example",
        paths=("apps/api/src", "apps/api/main.py", "apps/api/inngest_config.py"),
        suffixes=(".py",),
    ),
    ScanTarget(
        label="apps/web",
        template="apps/web/.env.example",
        paths=(
            "apps/web/app",
            "apps/web/components",
            "apps/web/lib",
            "apps/web/providers",
        ),
        suffixes=(".ts", ".tsx"),
    ),
)

EXCLUDED_PARTS = frozenset({"tests", "test", "node_modules", "__pycache__", ".next", "_generated"})

# ─────────────────────────────────────────────────────────────────────────────
# 実値混入の検査 — テンプレートと運用 docs には**名前だけ**を書く。
# `.env.example` は「= の後ろに 1 文字でもあれば値」で判定する。
# 末尾の "=" で「値なし」と判定してはいけない: Fernet 鍵 (SECRETS.md で案内している
# 生成方法そのもの) は常に "=" で終わるため、実鍵を書いても素通りしてしまう。
# ─────────────────────────────────────────────────────────────────────────────
VALUE_SCAN_DOCS: tuple[str, ...] = ("SECRETS.md",)
"""`.env.example` に加えて秘匿値の形を走査する運用 docs。"""

SECRET_SHAPE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "Fernet 鍵 (urlsafe-base64 44 文字)",
        re.compile(r"(?<![A-Za-z0-9_\-])[A-Za-z0-9_\-]{43}=(?![A-Za-z0-9_\-=])"),
    ),
    ("provider API キー (sk-…)", re.compile(r"\bsk-[A-Za-z0-9_\-]{12,}")),
    ("Stripe キー (sk_live_… / sk_test_…)", re.compile(r"\bsk_(?:live|test)_[A-Za-z0-9]{12,}")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}")),
    (
        # ローカル開発用の URL (localhost / 127.0.0.1) は秘匿値ではなく手順の一部
        # (docker-compose の固定値) なので除外する。既存テンプレのコメントに
        # `postgresql+asyncpg://atelier_dev:devpass@localhost:5432/...` があり、
        # これを消すと tier_3「既存コメントを削除しない」に反する。
        "接続文字列の資格情報",
        re.compile(
            r"\b[a-z][a-z0-9+.\-]*://[A-Za-z0-9_\-.%]+:[A-Za-z0-9_\-.%]+@"
            r"(?!localhost\b|127\.0\.0\.1\b)",
        ),
    ),
    (
        "token_urlsafe 相当の長い乱数",
        re.compile(r"(?<![A-Za-z0-9_\-])[A-Za-z0-9_\-]{48,}(?![A-Za-z0-9_\-])"),
    ),
)
"""実値と判別できる形。名前だけの登録なら 1 つも一致しない。"""

# ─────────────────────────────────────────────────────────────────────────────
# 抽出 regex
# ─────────────────────────────────────────────────────────────────────────────
_PY_GET_RE = re.compile(
    r"""os\.(?:environ\.get|getenv)\(\s*["'](?P<name>[A-Z][A-Z0-9_]*)["']\s*(?:,\s*(?P<default>[^)]*?))?\s*\)""",
)
_PY_INDEX_RE = re.compile(r"""os\.environ\[\s*["'](?P<name>[A-Z][A-Z0-9_]*)["']\s*\]""")
_TS_RE = re.compile(
    r"""process\.env(?:\.(?P<dot>[A-Z][A-Z0-9_]*)|\[\s*["'](?P<bracket>[A-Z][A-Z0-9_]*)["']\s*\])"""
    r"""(?P<tail>\s*(?:\|\||\?\?)\s*(?P<default>["'][^"']*["']|[A-Za-z0-9_.]+))?""",
)
_NONEMPTY_LITERAL_RE = re.compile(
    r"""^(?:["'](?P<s>.+)["']|\d+(?:\.\d+)?|True|False|true|false)$"""
)
_TEMPLATE_NAME_RE = re.compile(r"^\s*#?\s*(?P<name>[A-Z][A-Z0-9_]*)\s*=")


@dataclass(frozen=True)
class EnvRead:
    """コード中の 1 箇所の環境変数読み取り。"""

    name: str
    site: str
    optional: bool
    reason: str


def _is_nonempty_literal(default: str | None) -> bool:
    """既定値が「空でないリテラル」なら True (= 未設定でも動く)。"""
    if default is None:
        return False
    candidate = default.strip()
    if not candidate:
        return False
    match = _NONEMPTY_LITERAL_RE.match(candidate)
    if match is None:
        return False
    quoted = match.group("s")
    # `os.environ.get("X", "")` は「空文字既定 → 直後に必須チェック」の形なので任意にしない
    return quoted is None or quoted.strip() != ""


def _iter_files(root: Path, target: ScanTarget) -> list[Path]:
    files: list[Path] = []
    for raw in target.paths:
        path = root / raw
        if path.is_file():
            files.append(path)
            continue
        if not path.is_dir():
            continue
        for candidate in sorted(path.rglob("*")):
            if candidate.suffix not in target.suffixes or not candidate.is_file():
                continue
            if EXCLUDED_PARTS & set(candidate.parts):
                continue
            if candidate.name.startswith("test_") or ".test." in candidate.name:
                continue
            files.append(candidate)
    return files


def scan_reads(root: Path, target: ScanTarget) -> list[EnvRead]:
    """走査範囲から環境変数の読み取りを全て抽出する。"""
    reads: list[EnvRead] = []
    for file in _iter_files(root, target):
        rel = file.relative_to(root)
        for lineno, line in enumerate(file.read_text(encoding="utf-8").splitlines(), start=1):
            site = f"{rel}:{lineno}"
            for match in _PY_GET_RE.finditer(line):
                optional = _is_nonempty_literal(match.group("default"))
                reads.append(
                    EnvRead(
                        match.group("name"),
                        site,
                        optional,
                        "コード側に空でない既定値あり" if optional else "",
                    ),
                )
            for match in _PY_INDEX_RE.finditer(line):
                reads.append(EnvRead(match.group("name"), site, False, ""))
            for match in _TS_RE.finditer(line):
                name = match.group("dot") or match.group("bracket")
                optional = _is_nonempty_literal(match.group("default"))
                reads.append(
                    EnvRead(
                        name,
                        site,
                        optional,
                        "コード側に空でない既定値あり" if optional else "",
                    ),
                )
    return reads


def parse_template(path: Path) -> set[str]:
    """`.env.example` に登録済みの変数名を返す (コメント形 `# NAME=` も登録済み扱い)。"""
    if not path.is_file():
        return set()
    names: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        match = _TEMPLATE_NAME_RE.match(line)
        if match is not None:
            names.add(match.group("name"))
    return names


@dataclass(frozen=True)
class Drift:
    """テンプレート未登録の必須変数 1 件。"""

    target: str
    name: str
    sites: tuple[str, ...]


@dataclass(frozen=True)
class ValueLeak:
    """テンプレート / 運用 docs に実値が書かれている疑い 1 件。"""

    site: str
    kind: str
    excerpt: str


def _excerpt(text: str) -> str:
    """漏洩箇所の抜粋。**実値そのものはログに出さない**ため頭 4 文字だけ残す。"""
    head = text[:4]
    return f"{head}… ({len(text)} chars)"


def find_value_leaks(root: Path) -> list[ValueLeak]:
    """`.env.example` と運用 docs に実値が混入していないか検査する。

    - `.env.example`: `NAME=` の右辺に 1 文字でもあれば実値とみなす
      (末尾 "=" で「値なし」と判定しない — Fernet 鍵は "=" で終わる)。
    - `.env.example` + 運用 docs: 実値と判別できる形 (Fernet 鍵 / sk-… / JWT /
      接続文字列の資格情報 / 長い乱数) が現れたら実値とみなす。
    """
    leaks: list[ValueLeak] = []
    templates = [root / target.template for target in SCAN_TARGETS]

    for template in templates:
        if not template.is_file():
            continue
        rel = template.relative_to(root)
        for lineno, line in enumerate(template.read_text(encoding="utf-8").splitlines(), start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            name, sep, value = stripped.partition("=")
            if sep and value.strip():
                leaks.append(
                    ValueLeak(
                        f"{rel}:{lineno}", f"{name.strip()} に値が入っている", _excerpt(value)
                    ),
                )

    for path in [*templates, *(root / doc for doc in VALUE_SCAN_DOCS)]:
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            for kind, pattern in SECRET_SHAPE_PATTERNS:
                match = pattern.search(line)
                if match is not None:
                    leaks.append(ValueLeak(f"{rel}:{lineno}", kind, _excerpt(match.group(0))))

    return leaks


def find_drift(root: Path, target: ScanTarget) -> tuple[list[Drift], list[EnvRead]]:
    """走査範囲の drift と、判定に使った全読み取りを返す。"""
    registered = parse_template(root / target.template)
    reads = scan_reads(root, target)

    required_sites: dict[str, list[str]] = {}
    for read in reads:
        if read.optional or read.name in ALLOWLIST or read.name in registered:
            continue
        required_sites.setdefault(read.name, []).append(read.site)

    drifts = [
        Drift(target.label, name, tuple(sites)) for name, sites in sorted(required_sites.items())
    ]
    return drifts, reads


def validate_allowlist() -> list[str]:
    """理由が空の許可を検出する (理由なし許可を作らせない)。"""
    return [name for name, reason in ALLOWLIST.items() if not reason.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="リポジトリルート (既定: カレント)")
    parser.add_argument("--verbose", action="store_true", help="判定内訳を全て表示する")
    args = parser.parse_args()

    root = Path(args.root).resolve()

    missing_reasons = validate_allowlist()
    if missing_reasons:
        print("::error::ALLOWLIST に理由の無い項目があります: " + ", ".join(missing_reasons))
        return 2

    all_drifts: list[Drift] = []
    for target in SCAN_TARGETS:
        template = root / target.template
        if not template.is_file():
            print(f"::error::template not found: {target.template}")
            return 2

        drifts, reads = find_drift(root, target)
        all_drifts.extend(drifts)

        if args.verbose:
            registered = parse_template(template)
            names = sorted({read.name for read in reads})
            print(f"\n[{target.label}] {len(names)} env var(s) read, template={target.template}")
            for name in names:
                if name in ALLOWLIST:
                    state = f"allowlisted ({ALLOWLIST[name]})"
                elif name in registered:
                    state = "registered"
                elif all(read.optional for read in reads if read.name == name):
                    state = "optional (code default)"
                else:
                    state = "MISSING"
                print(f"  - {name}: {state}")

    leaks = find_value_leaks(root)

    if all_drifts:
        print("\n::error::環境変数テンプレートに drift があります (必須なのに未登録):")
        for drift in all_drifts:
            print(f"  [{drift.target}] {drift.name}")
            for site in drift.sites:
                print(f"      read at {site}")
        print(
            "\n対処: 対象の .env.example に変数名を追記する (実値は書かない)。"
            "\n      任意変数なら ALLOWLIST に理由つきで登録するか、コード側に"
            " 空でない既定値を与える。",
        )

    if leaks:
        print("\n::error::テンプレート / 運用 docs に実値が混入しています (名前だけを書くこと):")
        for leak in leaks:
            print(f"  {leak.site}  {leak.kind}  {leak.excerpt}")
        print(
            "\n対処: 値を削って名前だけにする (生成方法はコメントで案内する)。"
            "\n      実値が git に入った場合は当該シークレットを直ちにローテーションする"
            " (SECRETS.md 4.)。",
        )

    if all_drifts or leaks:
        return 1

    print(
        f"env-template-drift: OK — 未登録の必須変数 0 件 / 実値混入 0 件"
        f" ({len(SCAN_TARGETS)} template + {len(VALUE_SCAN_DOCS)} docs)。",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
