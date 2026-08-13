"""T-F-43: scripts/ci/env-template-drift.py の検証 (GAP-107 再発防止)。

要点:
- **現行コードベースに対して exit 0**。検査を入れて赤いまま置かない。
- テンプレートから 1 変数を消すと exit 1 になり、変数名と読み取り箇所を出す
  (= 検査が実際に効いていることの確認)。
- 既定値つき・許可リスト済みは誤検知しない。
- 許可リストの理由は必須 (理由なし許可を作れない)。
"""

from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path
from types import ModuleType

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCRIPT = _REPO_ROOT / "scripts" / "ci" / "env-template-drift.py"


def _load_module() -> ModuleType:
    """ハイフン入りファイル名なので importlib で直接読む。"""
    spec = importlib.util.spec_from_file_location("env_template_drift", _SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


drift_mod = _load_module()


@pytest.mark.unit
class TestScriptExists:
    def test_script_is_present(self) -> None:
        assert _SCRIPT.is_file()

    def test_allowlist_entries_all_have_reasons(self) -> None:
        """UNWANTED: 理由の無い許可を作らせない。"""
        assert drift_mod.validate_allowlist() == []


@pytest.mark.unit
class TestOptionalDetection:
    @pytest.mark.parametrize(
        "default",
        ['"claude-sonnet-4-6"', "'meetings'", '"28800"', "15", "True"],
    )
    def test_nonempty_literal_defaults_are_optional(self, default: str) -> None:
        assert drift_mod._is_nonempty_literal(default) is True

    @pytest.mark.parametrize("default", [None, "", '""', "''", '"   "', "os.getcwd()"])
    def test_empty_or_dynamic_defaults_are_not_optional(self, default: str | None) -> None:
        """`os.environ.get("X", "")` は GAP-107 の形。任意扱いにしない。"""
        assert drift_mod._is_nonempty_literal(default) is False


@pytest.mark.unit
class TestTemplateParsing:
    def test_reads_plain_and_commented_names(self, tmp_path: Path) -> None:
        template = tmp_path / ".env.example"
        template.write_text(
            "# comment line\nFOO=\nBAR=value\n# BAZ=1   … 任意フラグ\nnot_a_var\n",
            encoding="utf-8",
        )
        assert drift_mod.parse_template(template) == {"FOO", "BAR", "BAZ"}

    def test_missing_template_is_empty(self, tmp_path: Path) -> None:
        assert drift_mod.parse_template(tmp_path / "absent") == set()


@pytest.mark.unit
class TestAgainstCurrentRepository:
    def test_current_codebase_passes(self) -> None:
        """現行コードベースで drift 0 件 (完了条件)。"""
        for target in drift_mod.SCAN_TARGETS:
            drifts, _reads = drift_mod.find_drift(_REPO_ROOT, target)
            assert drifts == [], f"{target.label}: {drifts}"

    def test_byok_key_is_registered(self) -> None:
        """GAP-107 の当該変数がテンプレートに登録されている。"""
        registered = drift_mod.parse_template(_REPO_ROOT / "apps" / "api" / ".env.example")
        assert "ATELIER_BYOK_ENCRYPTION_KEY" in registered

    def test_byok_key_is_documented_in_secrets_md(self) -> None:
        secrets_md = (_REPO_ROOT / "SECRETS.md").read_text(encoding="utf-8")
        assert "ATELIER_BYOK_ENCRYPTION_KEY" in secrets_md
        # 生成方法つきで登録されていること
        assert "Fernet.generate_key()" in secrets_md

    def test_templates_and_docs_contain_no_values(self) -> None:
        """UNWANTED critical: テンプレート / SECRETS.md に実値を書かない。"""
        assert drift_mod.find_value_leaks(_REPO_ROOT) == []


@pytest.mark.unit
class TestValueLeakDetection:
    """QA_FAIL-3 回帰。

    旧実装の唯一の防波堤は `stripped.endswith("=")` で「値なし」を判定しており、
    **末尾が "=" になる Fernet 鍵 (SECRETS.md が案内している生成方法そのもの) の
    実値を書いても素通り**していた。判定を「= の右辺に 1 文字でもあれば値」へ
    直し、さらに実値の形 (Fernet / sk-… / JWT / 接続文字列) でも検出する。
    """

    @staticmethod
    def _template(root: Path, body: str) -> None:
        for name in ("apps/api/.env.example", "apps/web/.env.example"):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf-8")
        (root / "apps" / "api" / ".env.example").write_text(body, encoding="utf-8")

    def test_real_fernet_key_in_template_is_detected(self, tmp_path: Path) -> None:
        """末尾 "=" の実鍵を「値なし」と誤判定しない (本 FAIL の中核)。"""
        from cryptography.fernet import Fernet

        key = Fernet.generate_key().decode()
        assert key.endswith("="), "前提: Fernet 鍵は '=' で終わる"
        self._template(tmp_path, f"ATELIER_BYOK_ENCRYPTION_KEY={key}\n")

        leaks = drift_mod.find_value_leaks(tmp_path)

        assert leaks, "実 Fernet 鍵が検出されていない"
        kinds = {leak.kind for leak in leaks}
        assert "ATELIER_BYOK_ENCRYPTION_KEY に値が入っている" in kinds
        assert "Fernet 鍵 (urlsafe-base64 44 文字)" in kinds
        # 実値そのものは出力に出さない (CI ログへの二次漏洩を防ぐ)
        assert all(key not in leak.excerpt for leak in leaks)

    def test_real_fernet_key_in_secrets_md_is_detected(self, tmp_path: Path) -> None:
        """AC は「.env.example **or** SECRETS.md」。docs 側も検査対象。"""
        from cryptography.fernet import Fernet

        self._template(tmp_path, "ATELIER_BYOK_ENCRYPTION_KEY=\n")
        (tmp_path / "SECRETS.md").write_text(
            f"| BYOK | 1Password | `{Fernet.generate_key().decode()}` |\n",
            encoding="utf-8",
        )

        leaks = drift_mod.find_value_leaks(tmp_path)

        assert [leak.kind for leak in leaks] == ["Fernet 鍵 (urlsafe-base64 44 文字)"]
        assert leaks[0].site.startswith("SECRETS.md:")

    @pytest.mark.parametrize(
        ("value", "kind"),
        [
            ("sk-abcdefghijklmnopqrstuvwx", "provider API キー (sk-…)"),
            ("sk_live_ABCdef1234567890", "Stripe キー (sk_live_… / sk_test_…)"),
            ("eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0", "JWT"),
            (
                "postgresql+asyncpg://user:s3cr3tpass@db.example.com/atelier",
                "接続文字列の資格情報",
            ),
        ],
    )
    def test_secret_shapes_in_docs_are_detected(
        self,
        tmp_path: Path,
        value: str,
        kind: str,
    ) -> None:
        self._template(tmp_path, "FOO=\n")
        (tmp_path / "SECRETS.md").write_text(f"例: {value}\n", encoding="utf-8")

        assert kind in {leak.kind for leak in drift_mod.find_value_leaks(tmp_path)}

    def test_placeholders_and_local_dev_urls_are_not_flagged(self, tmp_path: Path) -> None:
        """UNWANTED: 誤検知でゲートを常時赤にしない。"""
        self._template(
            tmp_path,
            "# ローカル: postgresql+asyncpg://atelier_dev:devpass@localhost:5432/atelier_dev\n"
            '# 生成: python3 -c "from cryptography.fernet import Fernet; '
            'print(Fernet.generate_key().decode())"\n'
            "ATELIER_DB_URL=\n"
            "ATELIER_BYOK_ENCRYPTION_KEY=\n",
        )
        (tmp_path / "SECRETS.md").write_text(
            '| BYOK 暗号化キー | 1Password | `python3 -c "...Fernet.generate_key()..."` |\n'
            "flyctl secrets set ATELIER_BYOK_ENCRYPTION_KEY='<保管庫の値>'\n"
            'git log -p --all | grep -iE "service_role|postgres://.*:.*@"\n',
            encoding="utf-8",
        )

        assert drift_mod.find_value_leaks(tmp_path) == []

    def test_main_exits_one_when_a_value_is_present(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        from cryptography.fernet import Fernet

        self._template(tmp_path, f"ATELIER_BYOK_ENCRYPTION_KEY={Fernet.generate_key().decode()}\n")
        monkeypatch.setattr(sys, "argv", ["env-template-drift.py", "--root", str(tmp_path)])

        assert drift_mod.main() == 1
        assert "実値が混入" in capsys.readouterr().out


@pytest.mark.unit
class TestDetectsMissingVariable:
    def test_removing_one_variable_is_detected_with_read_site(self, tmp_path: Path) -> None:
        """EVENT-DRIVEN: テンプレから 1 変数を消すと変数名と読み取り箇所を指す。"""
        root = tmp_path
        (root / "apps" / "api" / "src").mkdir(parents=True)
        shutil.copy(
            _REPO_ROOT / "apps" / "api" / ".env.example",
            root / "apps" / "api" / ".env.example",
        )
        (root / "apps" / "api" / "src" / "svc.py").write_text(
            'import os\n\nKEY = os.environ.get("ATELIER_BYOK_ENCRYPTION_KEY", "")\n',
            encoding="utf-8",
        )
        target = drift_mod.ScanTarget(
            label="apps/api",
            template="apps/api/.env.example",
            paths=("apps/api/src",),
            suffixes=(".py",),
        )

        # テンプレート登録済みの状態では検出されない
        assert drift_mod.find_drift(root, target)[0] == []

        # 1 変数を消すと検出される
        template = root / "apps" / "api" / ".env.example"
        template.write_text(
            "\n".join(
                line
                for line in template.read_text(encoding="utf-8").splitlines()
                if not line.startswith("ATELIER_BYOK_ENCRYPTION_KEY")
            ),
            encoding="utf-8",
        )
        drifts, _reads = drift_mod.find_drift(root, target)

        assert len(drifts) == 1
        assert drifts[0].name == "ATELIER_BYOK_ENCRYPTION_KEY"
        assert drifts[0].sites == ("apps/api/src/svc.py:3",)

    def test_optional_variable_is_not_reported(self, tmp_path: Path) -> None:
        """UNWANTED: 既定値つき変数は誤検知しない。"""
        root = tmp_path
        (root / "apps" / "api" / "src").mkdir(parents=True)
        (root / "apps" / "api" / ".env.example").write_text("", encoding="utf-8")
        (root / "apps" / "api" / "src" / "svc.py").write_text(
            'import os\n\nMODEL = os.environ.get("ATELIER_SOME_MODEL", "claude-sonnet-4-6")\n',
            encoding="utf-8",
        )
        target = drift_mod.ScanTarget(
            label="apps/api",
            template="apps/api/.env.example",
            paths=("apps/api/src",),
            suffixes=(".py",),
        )

        assert drift_mod.find_drift(root, target)[0] == []

    def test_test_files_are_not_scanned(self, tmp_path: Path) -> None:
        """テスト専用 env を必須扱いしない。"""
        root = tmp_path
        (root / "apps" / "api" / "src" / "tests").mkdir(parents=True)
        (root / "apps" / "api" / ".env.example").write_text("", encoding="utf-8")
        (root / "apps" / "api" / "src" / "tests" / "test_x.py").write_text(
            'import os\n\nX = os.environ["ONLY_IN_TESTS"]\n',
            encoding="utf-8",
        )
        target = drift_mod.ScanTarget(
            label="apps/api",
            template="apps/api/.env.example",
            paths=("apps/api/src",),
            suffixes=(".py",),
        )

        assert drift_mod.find_drift(root, target)[0] == []

    def test_typescript_reads_are_detected(self, tmp_path: Path) -> None:
        root = tmp_path
        (root / "apps" / "web" / "lib").mkdir(parents=True)
        (root / "apps" / "web" / ".env.example").write_text("", encoding="utf-8")
        (root / "apps" / "web" / "lib" / "x.ts").write_text(
            "export const a = process.env.NEXT_PUBLIC_NEEDED;\n"
            "export const b = process.env.NEXT_PUBLIC_HAS_DEFAULT || 'https://x';\n",
            encoding="utf-8",
        )
        target = drift_mod.ScanTarget(
            label="apps/web",
            template="apps/web/.env.example",
            paths=("apps/web/lib",),
            suffixes=(".ts", ".tsx"),
        )

        drifts, _reads = drift_mod.find_drift(root, target)
        assert [d.name for d in drifts] == ["NEXT_PUBLIC_NEEDED"]


@pytest.mark.unit
class TestCliExitCodes:
    def test_main_returns_zero_for_current_repo(
        self,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        monkeypatch.setattr(sys, "argv", ["env-template-drift.py", "--root", str(_REPO_ROOT)])
        assert drift_mod.main() == 0
        out = capsys.readouterr().out
        assert "未登録の必須変数 0 件" in out
        assert "実値混入 0 件" in out

    def test_main_returns_two_when_template_missing(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        monkeypatch.setattr(sys, "argv", ["env-template-drift.py", "--root", str(tmp_path)])
        assert drift_mod.main() == 2
        assert "template not found" in capsys.readouterr().out

    def test_main_returns_one_and_names_the_variable(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        for name in ("apps/api/.env.example", "apps/web/.env.example"):
            path = tmp_path / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf-8")
        (tmp_path / "apps" / "api" / "src").mkdir(parents=True)
        (tmp_path / "apps" / "api" / "src" / "svc.py").write_text(
            'import os\n\nKEY = os.environ["ATELIER_NEEDS_TEMPLATE"]\n',
            encoding="utf-8",
        )
        monkeypatch.setattr(sys, "argv", ["env-template-drift.py", "--root", str(tmp_path)])

        assert drift_mod.main() == 1
        out = capsys.readouterr().out
        assert "ATELIER_NEEDS_TEMPLATE" in out
        assert "apps/api/src/svc.py:3" in out

    def test_verbose_lists_classification(
        self,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        monkeypatch.setattr(
            sys,
            "argv",
            ["env-template-drift.py", "--root", str(_REPO_ROOT), "--verbose"],
        )
        assert drift_mod.main() == 0
        out = capsys.readouterr().out
        assert "ATELIER_BYOK_ENCRYPTION_KEY: registered" in out
        assert "allowlisted" in out
