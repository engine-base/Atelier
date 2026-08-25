#!/usr/bin/env python3
"""GAP-204: **サーバーだけにあるべき中身**が画面側に混ざっていないかを機械検査する。

## なぜ必要か

ブラウザに配った HTML/CSS/JS は必ず相手の手元に届く。見た目が真似されるのは
止められない。**止められるのは「中身」の方**:

  - AI 社員のプロンプト（どう考えさせているか）
  - スキル本文（何を知っているか）
  - 出力テンプレートの本文（どう書かせているか）

これらは Atelier の中核で、**1 行でも画面側の JS に混ざったら丸ごと読まれる**。
今までは「混ざっていないはず」を目視でしか確認できなかった。ここで機械化する。

## 何を見るか

1. **本番ソースマップが出ていないこと** — 出ていると元の TypeScript が
   まるごとダウンロードできる。1 行の設定ミスで起きるので設定と成果物の両方を見る。
2. **画面側の JS にサーバー専用の文字列が無いこと** — プロンプト等を書いている
   Python から**長い日本語の文字列を自動で抜き出し**、それがビルド成果物に
   含まれていないか探す。**一覧を手で書かない**ので、プロンプトを直しても腐らない。

## 意図的に共有している文言

利用者向けのエラー文など、サーバーと画面の両方に同じ日本語がある場合は
`client-leak-allowlist.txt` に理由つきで書く。**使われなくなった許可は
エラーにする**ので、許可リストが惰性で膨らまない。

## 使い方

    python3 scripts/ci/check-client-leak.py            # ビルド済み .next を検査
    python3 scripts/ci/check-client-leak.py --build    # 先に build してから検査
"""

from __future__ import annotations

import argparse
import ast
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "apps" / "web"
NEXT_STATIC = WEB / ".next" / "static"
NEXT_CONFIG = WEB / "next.config.ts"
ALLOWLIST = Path(__file__).resolve().parent / "client-leak-allowlist.txt"

#: プロンプト・テンプレ本文を組み立てている「サーバー専用」モジュール。
#: ここに書かれた長い日本語は **画面側に出てはいけない**。
SERVER_ONLY_SOURCES = [
    "apps/api/src/services/chat_sse/__init__.py",
    "apps/api/src/services/chat_sse/agent_sdk.py",
    "apps/api/src/services/chat_sse/summary.py",
    "apps/api/src/services/outputs/revise.py",
    "apps/api/src/services/outputs/fix_proposals.py",
    "apps/api/src/services/outputs/file_edit.py",
    "apps/api/src/services/outputs/templates.py",
    "apps/api/src/services/meetings/analysis.py",
    "apps/api/src/services/sales_docs/generate.py",
    "apps/api/src/services/workflow/proposals.py",
    "apps/api/src/services/knowledge/auto_capture.py",
    "apps/api/src/services/knowledge/curation.py",
    "apps/api/src/services/cron/actions.py",
    "apps/api/src/services/mocks/design_note.py",
    "apps/api/src/services/mocks/generate.py",
    "apps/api/src/services/mocks/revise.py",
]

#: ここより下を探す範囲 (プロンプトを持つファイルの取りこぼしを機械的に見つける)。
DISCOVERY_ROOT = "apps/api/src"

#: **プロンプトである印**。この文字列を含む Python は必ず SERVER_ONLY_SOURCES に
#: 載っていなければならない。「〜してください」等は利用者向けメッセージにも出るので
#: 印にしない (誤検知だらけになると誰も見なくなる)。
PROMPT_MARKER = "あなたは"

#: 印を含むが **プロンプトではない**と確認済みのファイル (理由つきで書く)。
NOT_A_PROMPT: dict[str, str] = {}

#: これより短い文字列は「ラベル」であって中身ではないので対象外。
MIN_MARKER_CHARS = 16

_JAPANESE = re.compile(r"[぀-ヿ一-鿿]")


def _fragments(text: str) -> set[str]:
    """文全体だけでなく **一文ずつ** も見張る。

    Python は隣り合う文字列リテラルを 1 つに繋げてしまうため、AST から取れるのは
    「プロンプト全文」になる。全文だけを探すと **一部だけ抜き取られた漏洩**を
    見逃す (実 e2e で踏んだ)。そこで句点・改行で割った断片も対象にする。
    """
    out: set[str] = set()
    whole = text.strip()
    if len(whole) >= MIN_MARKER_CHARS and _JAPANESE.search(whole):
        out.add(whole)
    for piece in re.split(r"[。\n]", text):
        frag = piece.strip()
        if len(frag) >= MIN_MARKER_CHARS and _JAPANESE.search(frag):
            out.add(frag)
    return out


def japanese_literals(path: Path) -> set[str]:
    """Python から日本語を含む長い文字列リテラルを抜き出す (正規表現ではなく AST)。"""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            found |= _fragments(node.value)
    return found


def files_with_prompts() -> list[str]:
    """プロンプトを持つ Python を **機械的に洗い出す**。

    `SERVER_ONLY_SOURCES` は手で書く一覧なので、**新しくプロンプトを持つ
    ファイルを足したときの登録漏れ**が起きる。それを検知できないと、
    そのファイルの中身は検査を素通りしてしまう (実際に 4 ファイル漏れていた)。
    """
    root = ROOT / DISCOVERY_ROOT
    found: list[str] = []
    for path in sorted(root.rglob("*.py")):
        if "__pycache__" in str(path):
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError:  # pragma: no cover - 壊れた .py は type check 側の責務
            continue
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and PROMPT_MARKER in node.value
            ):
                found.append(str(path.relative_to(ROOT)))
                break
    return found


def check_registration(problems: list[str]) -> None:
    """**登録漏れをサボれなくする** (GAP-206)。

    プロンプトを持つのに検査対象へ登録されていないファイルがあれば落とす。
    誤検知だった場合は `NOT_A_PROMPT` に理由つきで書く (黙って除外させない)。
    """
    registered = set(SERVER_ONLY_SOURCES)
    for rel in files_with_prompts():
        if rel in registered or rel in NOT_A_PROMPT:
            continue
        problems.append(
            f"プロンプトを持つのに検査対象になっていません: {rel} "
            f"— SERVER_ONLY_SOURCES に追加してください "
            f"(プロンプトでないなら NOT_A_PROMPT に理由つきで)"
        )
    for rel, reason in NOT_A_PROMPT.items():
        if not (ROOT / rel).exists():
            problems.append(f"NOT_A_PROMPT の項目が実在しません: {rel} ({reason})")


def load_allowlist() -> dict[str, str]:
    """意図的に共有している文言 (文字列 -> 理由)。"""
    if not ALLOWLIST.exists():
        return {}
    allowed: dict[str, str] = {}
    for raw in ALLOWLIST.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        text, _, reason = line.partition("\t")
        allowed[text.strip()] = reason.strip() or "(理由未記入)"
    return allowed


def client_chunks() -> list[Path]:
    """画面側へ配られる JS だけを対象にする (`.next/server` はサーバー側なので除く)。"""
    if not NEXT_STATIC.exists():
        return []
    return sorted(p for p in NEXT_STATIC.rglob("*.js") if p.is_file())


def escaped_variants(text: str) -> list[str]:
    """バンドラは日本語をそのまま出すことも \\uXXXX に逃がすこともある。両方見る。"""
    escaped = "".join(f"\\u{ord(ch):04x}" if ord(ch) > 127 else ch for ch in text)
    return [text, escaped, escaped.upper().replace("\\U", "\\u")]


def check_internal_ids(problems: list[str]) -> None:
    """GAP-210: **社内の課題番号を画面へ出さない。**

    通しの検証で、新規登録の同意チェックの文言に `GAP-180/181` がそのまま
    出ているのを見つけた。利用者には意味が分からないうえ、**同意文に
    社内の管理番号が混じっている**状態は同意の体裁として良くない
    (何に同意したのかが濁る)。コメントに書くのは自由だが、
    **配られる JS に出たら落とす**。
    """
    hits: list[str] = []
    for chunk in client_chunks():
        text = chunk.read_text(encoding="utf-8", errors="ignore")
        for m in set(re.findall(r"GAP-\d{2,4}", text)):
            hits.append(f"{m} ({chunk.relative_to(WEB)})")
    for h in sorted(set(hits)):
        problems.append(
            f"画面側 JS に社内の課題番号が出ています: {h} "
            "— 利用者向けの文言から外してください (コード内のコメントは可)"
        )


def check_source_maps(problems: list[str]) -> None:
    """本番ソースマップが出ていないこと (設定と成果物の両方)。"""
    if NEXT_CONFIG.exists():
        config = NEXT_CONFIG.read_text(encoding="utf-8")
        if re.search(r"productionBrowserSourceMaps\s*:\s*true", config):
            problems.append(
                "next.config.ts で productionBrowserSourceMaps が true になっている "
                "— 元の TypeScript がまるごとダウンロードできる状態です"
            )
    maps = list(NEXT_STATIC.rglob("*.map")) if NEXT_STATIC.exists() else []
    if maps:
        shown = ", ".join(str(p.relative_to(WEB)) for p in maps[:5])
        problems.append(
            f"画面側にソースマップが {len(maps)} 個配られています ({shown}) "
            "— 元のソースが読めてしまいます"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true", help="先に web を build する")
    args = parser.parse_args()

    if args.build:
        print("→ apps/web を build しています…")
        subprocess.run(["pnpm", "--filter", "@atelier/web", "build"], cwd=ROOT, check=True)

    problems: list[str] = []
    check_source_maps(problems)
    check_registration(problems)

    chunks = client_chunks()
    if not chunks:
        print(
            "❌ ビルド成果物 (.next/static) が見つかりません。"
            "--build を付けるか、先に build してください。",
            file=sys.stderr,
        )
        return 2

    markers: dict[str, str] = {}  # 文字列 -> 出どころ
    for rel in SERVER_ONLY_SOURCES:
        path = ROOT / rel
        if not path.exists():
            problems.append(f"検査対象が見つかりません: {rel} (移動・削除されました)")
            continue
        for text in japanese_literals(path):
            markers.setdefault(text, rel)

    allowed = load_allowlist()
    used_allowances: set[str] = set()

    haystack = "\n".join(p.read_text(encoding="utf-8", errors="ignore") for p in chunks)

    leaked: list[tuple[str, str]] = []
    for text, origin in sorted(markers.items()):
        if not any(v in haystack for v in escaped_variants(text)):
            continue
        if text in allowed:
            used_allowances.add(text)
            continue
        leaked.append((text, origin))

    print(f"検査対象: 画面側 JS {len(chunks)} ファイル / サーバー専用の文言 {len(markers)} 件")

    for text, origin in leaked:
        preview = text if len(text) <= 60 else text[:57] + "…"
        problems.append(f"画面側 JS に流出: 「{preview}」 (出どころ {origin})")

    check_internal_ids(problems)

    stale = set(allowed) - used_allowances
    for text in sorted(stale):
        preview = text if len(text) <= 40 else text[:37] + "…"
        problems.append(
            f"許可リストの不要な項目: 「{preview}」 — もう流出していないので削除してください"
        )

    if problems:
        print()
        print(f"❌ {len(problems)} 件の問題:")
        for p in problems:
            print(f"  - {p}")
        print()
        print("対処: 該当の文言をサーバー側だけに残すか、")
        print("      意図的な共有なら scripts/ci/client-leak-allowlist.txt に理由つきで追記。")
        return 1

    print("✅ サーバー専用の中身は画面側に出ていません / ソースマップも配られていません")
    if allowed:
        print(f"   (意図的に共有している文言 {len(allowed)} 件は許可済み)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
