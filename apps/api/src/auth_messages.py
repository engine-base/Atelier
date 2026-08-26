"""サインイン券 (JWT) を断るときに、利用者へ何と言うか (GAP-225)。

なぜ別ファイルなのか
--------------------
GAP-216/218 で「利用者に届く文言は日本語」に揃えたが、**直したのは
`src/routes/` の中だけ**だった。実際に文言を出しているのは route だけでは
ない。券の検証は `src/dependencies.py`、混雑の制限は `src/rate_limit.py` に
あり、どちらも route より手前で応答を返す。**手前で返す文言は、route を見る
検査からは永久に外れる。**

実測 (2026-08-26 / 通し J22-02 の途中):

    GET /me                          → 401 {"detail":"missing bearer token"}
    GET /me  (壊れた券)              → 401 {"detail":"malformed token"}
    GET /me  (署名が合わない券)      → 401 {"detail":"malformed signature"}

画面はこの `detail` をそのまま出す (`apps/web/lib/auth/*.ts` は
`typeof json.detail === "string"` ならそれを投げる)。つまり日本語の製品で、
**期限が切れただけの人に英語の内部語を見せていた**。

理由を利用者に伝えない
----------------------
「署名が違う」「payload が壊れている」「sub が無い」の区別は、利用者にとって
一切意味が無い。次にやることはどれも同じ **「もう一度サインインする」**。
区別が要るのは運営だけなので、**理由はサーバーログにだけ**書き、応答は 1 種類に
揃える (どの断り方をしたかを外から数えられないようにする副次効果もある)。
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

#: 券が無い = まだサインインしていない。
SIGNIN_REQUIRED = "サインインが必要です。サインインしてから、もう一度お試しください。"

#: 券はあるが使えない (期限切れ / 壊れている / 系統違い) — 理由は問わず 1 文。
TOKEN_REJECTED = (
    "サインインの有効期限が切れているか、正しくありません。もう一度サインインしてください。"
)

#: 署名鍵が設定されていない = 運営側の設定漏れ。利用者は何もできない。
AUTH_NOT_CONFIGURED = "サーバー側で問題が発生しました。時間をおいて、もう一度お試しください。"


def log_token_rejection(reason: str) -> str:
    """断った理由をログに残し、**利用者に見せる 1 文**を返す。

    `reason` は運営向けの英語で構わない (ログにしか出ない)。
    """
    logger.info("token rejected: %s", reason)
    return TOKEN_REJECTED
