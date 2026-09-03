"""GAP-200: 意味検索・文字起こしを「サーバーで動かす」選択を安全に取れること。

**これまでの実態**: 本番 Docker イメージに `--extra localrag` を入れていないので
fastembed / faster-whisper が**そもそも入っていない**。それなのにコード側は
「ローカル埋め込み」「このサーバー内の faster-whisper」と表示しうる状態で、
実際には検索は文字一致に落ち、文字起こしは利用者の PC 頼みだった。

ここで固定する事実:
  - 「入っているか」は **推測せず import で確かめる**
  - 「入れたつもりで入っていない」を warn として検出する
  - 既定 (入れない) は **運営費用が増えない** ことを文言で明示する
  - Dockerfile / deploy workflow が opt-in であり、
    メモリ不足のまま有効化できないこと
"""

from __future__ import annotations

import pathlib
from typing import Any, cast

import yaml

from src.services.server_ai import (
    BUNDLED_ENV,
    IMAGE_SIZE_NOTE,
    MODEL_CACHE_ENV,
    ServerAiStatus,
    describe_server_ai,
    server_ai_status,
)

ROOT = pathlib.Path(__file__).resolve().parents[3]


class TestStatus:
    def test_reads_declaration_and_cache_from_env(self) -> None:
        st = server_ai_status({BUNDLED_ENV: "1", MODEL_CACHE_ENV: "/app/.models"})
        assert st.declared is True
        assert st.model_cache == "/app/.models"

    def test_absent_declaration_is_off(self) -> None:
        st = server_ai_status({})
        assert st.declared is False
        assert st.model_cache is None

    def test_installed_flags_are_measured_not_declared(self) -> None:
        """宣言ではなく **実際に import できるか** で判定する。"""
        declared_only = server_ai_status({BUNDLED_ENV: "1"})
        measured = server_ai_status({})
        assert declared_only.embedding_installed == measured.embedding_installed
        assert declared_only.transcribe_installed == measured.transcribe_installed


class TestDescription:
    def test_off_says_cost_does_not_increase(self) -> None:
        st = ServerAiStatus(
            declared=False,
            embedding_installed=False,
            transcribe_installed=False,
            model_cache=None,
        )
        state, detail, next_steps = describe_server_ai(st)
        assert state == "off"
        assert "運営費用は増えません" in detail
        assert "利用者の PC" in detail
        assert IMAGE_SIZE_NOTE in detail
        assert "server_ai=true" in next_steps

    def test_on_says_who_pays(self) -> None:
        st = ServerAiStatus(
            declared=True,
            embedding_installed=True,
            transcribe_installed=True,
            model_cache="/app/.models",
        )
        state, detail, _ = describe_server_ai(st)
        assert state == "ok"
        assert "運営の費用" in detail

    def test_declared_but_missing_is_a_warning(self) -> None:
        """「入れたつもりで入っていない」— 一番見つけたい状態。"""
        st = ServerAiStatus(
            declared=True,
            embedding_installed=True,
            transcribe_installed=False,
            model_cache="/app/.models",
        )
        assert st.mismatch is True
        state, detail, next_steps = describe_server_ai(st)
        assert state == "warn"
        assert "faster-whisper" in detail
        assert "server_ai=true" in next_steps

    def test_not_declared_and_not_installed_is_not_a_warning(self) -> None:
        st = ServerAiStatus(
            declared=False,
            embedding_installed=False,
            transcribe_installed=False,
            model_cache=None,
        )
        assert st.mismatch is False


class TestDockerfile:
    @staticmethod
    def _text() -> str:
        return (ROOT / "apps" / "api" / "Dockerfile").read_text(encoding="utf-8")

    def test_defaults_to_not_installing(self) -> None:
        """既定でモデルを入れない (運営費用を勝手に増やさない)。"""
        assert "ARG INSTALL_LOCALRAG=0" in self._text()

    def test_extra_is_conditional(self) -> None:
        text = self._text()
        assert "--extra localrag" in text
        assert 'if [ "$INSTALL_LOCALRAG" = "1" ]' in text

    def test_models_are_prefetched_at_build_time(self) -> None:
        """実行時 DL にしない (最初の 1 人だけ数分待つのを避ける)。"""
        assert "prefetch_models.py" in self._text()

    def test_image_exposes_whether_it_is_bundled(self) -> None:
        assert "ATELIER_SERVER_AI_BUNDLED=${INSTALL_LOCALRAG}" in self._text()


class TestDeployWorkflow:
    @staticmethod
    def _wf() -> dict[Any, Any]:
        raw = (ROOT / ".github" / "workflows" / "deploy.yml").read_text(encoding="utf-8")
        return cast("dict[Any, Any]", yaml.safe_load(raw))

    def test_gap285_server_ai_is_on_by_default_and_opt_out_is_explicit(self) -> None:
        """GAP-285: 既定を「入れる」に変えた。

        以前は明示 opt-in だったため、push での自動 deploy には一度も効かず、
        本番の意味検索がずっと unavailable のままだった (通し J35-01 / J35-07)。
        外すのは **明示的に false を選んだときだけ** にする。
        """
        wf = self._wf()
        # PyYAML は `on:` を True (bool) として解釈する
        triggers = cast("dict[str, Any]", wf.get("on") or wf[True])
        inputs = triggers["workflow_dispatch"]["inputs"]
        # 空 = 既定 (on)。"false" を選んだときだけ外れる
        assert inputs["server_ai"]["default"] == ""
        assert "false" in inputs["server_ai"]["options"]

    def test_gap285_default_is_resolved_before_the_vm_check(self) -> None:
        """push での自動 deploy にも効かせるため、入力ではなく解決済みの値を使う。"""
        wf = self._wf()
        steps = cast("list[dict[str, Any]]", wf["jobs"]["fly"]["steps"])
        names = [s.get("name") for s in steps]
        assert "Resolve server-side AI setting" in names
        assert names.index("Resolve server-side AI setting") < names.index(
            "Verify VM size for server-side AI"
        )
        resolve = next(s for s in steps if s.get("name") == "Resolve server-side AI setting")
        assert 'VALUE="true"' in resolve["run"]
        assert '"$INPUT" = "false"' in resolve["run"]

    def test_gap285_deploy_verifies_the_parts_are_actually_there(self) -> None:
        """「入れたつもりで入っていない」を本番の最初のユーザーが踏む前に落とす (G-11)。"""
        wf = self._wf()
        steps = cast("list[dict[str, Any]]", wf["jobs"]["fly"]["steps"])
        names = [s.get("name") for s in steps]
        assert "Verify server-side AI is actually present" in names
        check = next(
            s for s in steps if s.get("name") == "Verify server-side AI is actually present"
        )
        assert "/health/capabilities" in check["run"]
        assert '"embeddings":true' in check["run"]
        assert "exit 1" in check["run"]

    def test_build_arg_is_passed(self) -> None:
        wf = self._wf()
        steps = cast("list[dict[str, Any]]", wf["jobs"]["fly"]["steps"])
        deploy = next(s for s in steps if s.get("name") == "Deploy")
        assert "INSTALL_LOCALRAG=$LOCALRAG" in deploy["run"]
        # GAP-285: 既定は入れる。外すのは明示的に false を選んだときだけ
        assert "LOCALRAG=1" in deploy["run"]
        assert 'if [ "$SERVER_AI" = "false" ]' in deploy["run"]

    def test_vm_size_is_verified_before_deploy(self) -> None:
        """メモリ不足のまま有効化すると OOM で落ちるだけになる。"""
        wf = self._wf()
        steps = cast("list[dict[str, Any]]", wf["jobs"]["fly"]["steps"])
        names = [s.get("name") for s in steps]
        assert "Verify VM size for server-side AI" in names
        assert names.index("Verify VM size for server-side AI") < names.index("Deploy")
        verify = next(s for s in steps if s.get("name") == "Verify VM size for server-side AI")
        assert "exit 1" in verify["run"]
        # GAP-285: 入力そのものではなく、解決済みの値で判定する
        assert "steps.server_ai.outputs.value" in verify["if"]

    def test_vm_check_runs_whenever_server_ai_is_on(self) -> None:
        wf = self._wf()
        steps = cast("list[dict[str, Any]]", wf["jobs"]["fly"]["steps"])
        verify = next(s for s in steps if s.get("name") == "Verify VM size for server-side AI")
        assert "steps.server_ai.outputs.value == 'true'" in verify["if"]


class TestPrefetchScript:
    def test_fails_the_build_when_a_model_is_missing(self) -> None:
        """「入れたつもりで入っていない」イメージを本番へ出さない。"""
        text = (ROOT / "apps" / "api" / "scripts" / "prefetch_models.py").read_text(
            encoding="utf-8"
        )
        assert "return 0 if all(ok for ok, _ in results) else 1" in text

    def test_uses_the_same_model_names_as_the_app(self) -> None:
        """本番と違うモデルを取り込んで「入っているのに使われない」を作らない。"""
        text = (ROOT / "apps" / "api" / "scripts" / "prefetch_models.py").read_text(
            encoding="utf-8"
        )
        assert "from src.embeddings.local import DEFAULT_MODEL, MODEL_ENV" in text
        assert "from src.services.meetings.stt import DEFAULT_LOCAL_MODEL, LOCAL_MODEL_ENV" in text


def test_fly_memory_and_server_ai_stay_consistent() -> None:
    """VM のサイズと「サーバー実行を有効にしたか」が食い違わないこと。

    小さい VM (256/512MB) のままなら server_ai は使えない — その状態で
    有効化しようとすると deploy が VM チェックで止まる (上のテストで確認済み)。
    VM を 1GB 以上へ上げたなら、それは意図的にサーバー実行へ寄せた状態。
    """
    text = (ROOT / "fly.toml").read_text(encoding="utf-8")
    small = any(f'memory = "{m}"' in text for m in ("256mb", "512mb"))
    large = any(f'memory = "{m}"' in text for m in ("1024mb", "2048mb", "4096mb"))
    assert small or large, "fly.toml の memory が想定外の値です"
    if small:
        # 小さい VM ならサーバー実行はできない。Dockerfile の既定も 0 のままであること。
        docker = (ROOT / "apps" / "api" / "Dockerfile").read_text(encoding="utf-8")
        assert "ARG INSTALL_LOCALRAG=0" in docker
    else:
        # GAP-285: VM を上げたのは、サーバー実行へ寄せたから。実測の上振れ
        # (埋め込み 1,554MB) が入りきる大きさであること。1GB は「ふだんは動くが
        # 長い文章の日に OOM」= 一番たちの悪い壊れ方になる。
        assert 'memory = "2048mb"' in text or 'memory = "4096mb"' in text
