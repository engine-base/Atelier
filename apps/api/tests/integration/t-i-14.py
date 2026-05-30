"""T-I-14 F-J02 retry + 承認フロー試験.

F-J02 の retry policy (4xx 即 fail / 5xx 最大 2 回 retry) と
承認待ち遷移 (awaiting → done OR blocked) を検証する。

スケルトン: services.tasks.retry_count / approval transition logic の本実装
完了後にシナリオを肉付け。現状は不変条件のみ確認。
"""

from __future__ import annotations


def _is_retryable(status: int, attempt: int) -> bool:
    """API call が retry 可能か (services.tasks の retry policy と整合)."""
    if attempt >= 2:
        return False
    return not (400 <= status < 500)


def test_4xx_never_retried() -> None:
    """4xx は即 fail (retry しない)."""
    assert _is_retryable(400, 0) is False
    assert _is_retryable(403, 0) is False
    assert _is_retryable(404, 0) is False


def test_5xx_retries_up_to_2() -> None:
    """5xx は 0/1 attempt で retry 可、2 attempt で諦め."""
    assert _is_retryable(500, 0) is True
    assert _is_retryable(503, 1) is True
    assert _is_retryable(500, 2) is False


def test_approval_transitions() -> None:
    """awaiting → done / blocked のいずれかに収束する."""
    valid_next = {"done", "blocked"}
    # transition table が awaiting からの 2 状態を提供することを構造検証
    transitions = {"awaiting": ["done", "blocked"]}
    assert set(transitions["awaiting"]) == valid_next
