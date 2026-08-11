# 3 役セッション メッセージプロトコル (PM / dev / qa)

> 対象: ターミナル版 Claude Code のセッション間メッセージ (cross-session messaging) で
> PM・実装 (dev)・検証 (qa) の 3 セッションがバトンリレーで自走するための共通規約。
> 各役割の責務は `pm.md` / `dev.md` / `qa.md`。プロジェクト固有の仕様源・DoD は
> `project.md`。起動と復旧は `README.md`。

## 大原則

1. **仕様の正はファイル、メッセージはバトン**。メッセージはテキストのみで
   コンテキストを共有しない。仕様・進捗・検収結果はすべてリポジトリのファイル
   (`project.md` に列挙された SPEC / `.flow/state.json` / `.flow/reports/`) に書き、
   受け手はファイルを読み直してから動く。メッセージ本文だけを根拠に実装・検収しない。
2. **同時に動くのは常に 1 役 (バトン保持者) だけ**。git の書き込み・commit は
   バトン保持者のみが行う (競合防止)。バトンを持っていない役はメッセージ受信まで
   何もしない。
3. **自分のターンは「state 更新 + バトン送信」までやって初めて終了**。
   Stop hook (`scripts/agents/flow-stop-hook.sh`) が、バトン未送信のまま
   ターンを終えようとすると差し戻す。
4. **ユーザーへの連絡窓口は PM のみ**。dev / qa はユーザーに直接確認せず、
   PM へ ESCALATE する。

## メッセージ種別 (件名プレフィックス必須)

| 種別 | 送信者 → 受信者 | 意味 | 本文に必須の内容 |
|---|---|---|---|
| `TASK_READY` | pm → dev | このタスクを実装せよ | タスク ID/名、**タスクパッケージ `.flow/tasks/<ID>.md` のパス (必須 — pm.md 参照。上流成果物の由来・実装方針・受け入れ条件・完了定義を含む)**、特記事項 |
| `IMPL_DONE` | dev → qa | 実装完了、検証せよ | タスク ID、commit hash、変更ファイル要約、実行済みテストと結果 |
| `QA_PASS` | qa → pm | 検証合格、検収せよ | タスク ID、実行した検証一覧と結果、QA レポートのパス (`.flow/reports/`) |
| `QA_FAIL` | qa → dev | 不合格、修正せよ | タスク ID、**再現手順つき**の不合格項目 (期待/実際)、QA レポートのパス |
| `ACCEPTED` | pm → dev | 検収完了。次があれば続けて `TASK_READY` | タスク ID、検収結果のパス |
| `FIX_REQUEST` | pm → dev | 検収 NG / 仕様変更に伴う修正 | タスク ID、修正内容、更新した仕様ファイルの場所 |
| `ESCALATE` | dev/qa → pm | 判断できない事項の上申 | 何に詰まったか、選択肢と推奨、関連ファイル |
| `STATUS?` | pm → dev/qa | 生存確認・進捗確認 | 応答期限の目安 |

メッセージは「`種別: タスクID — 一行要約`」を先頭に置き、本文は簡潔に。
詳細はファイルに書いてパスを渡す。

## 状態ファイル `.flow/state.json` (gitignore 済・ランタイム専用)

`scripts/agents/flow.sh` で更新する。手で JSON を編集しない。

```bash
./scripts/agents/flow.sh take <自分の役割> <タスクID> [メモ]   # バトンを受け取った直後に実行
./scripts/agents/flow.sh handoff <自分> <相手> "<種別: 要約>"  # メッセージ送信の直後に実行
./scripts/agents/flow.sh wait-user "<ユーザーへの確認内容>"     # PM がユーザー回答待ちに入るとき
./scripts/agents/flow.sh idle "<完了サマリ>"                    # 予定分すべて完了したとき (PM のみ)
./scripts/agents/flow.sh status                                 # 現在の保持者と履歴を表示
```

- `take` = 「私が作業中 (handoff_sent=false)」。この状態でターンを終えようとすると
  Stop hook がブロックする。
- `handoff` = バトンを渡し終えた宣言。**必ず実際にメッセージを送信してから**実行する。
- `wait-user` / `idle` は停止が正当な状態。hook は通す。

## 標準ループ

```
ユーザー「開始」→ PM
PM:  project.md の SPEC / タスク源を読む → 次のタスクを決定
     → flow.sh take pm → TASK_READY 送信 → flow.sh handoff pm dev → 停止
dev: flow.sh take dev → 実装 → project.md の DoD を全て満たす → commit
     → IMPL_DONE 送信 → flow.sh handoff dev qa → 停止
qa:  flow.sh take qa → 独立検証 (dev の自己申告を信用しない)
     → PASS: QA_PASS → handoff qa pm / FAIL: QA_FAIL → handoff qa dev → 停止
PM:  検収 (pm.md + project.md の基準) → ACCEPTED + 次の TASK_READY、または FIX_REQUEST
     → 節目・確認事項があれば wait-user でユーザーに報告して待つ
```

## エスカレーション必須条件 (dev/qa は自己判断禁止)

- 仕様変更が必要 (SPEC と実装が矛盾 / 完了条件が満たせない) → **PM が** SPEC を
  更新してから指示し直す
- `project.md` の「人間承認が必須の操作」に該当 → PM 経由で**ユーザーの明示承認**を
  得るまで着手しない
- 外部サービス契約・鍵・課金が前提のタスク → PM へ返す
- 同一タスクで QA_FAIL が 3 回 → qa は dev ではなく PM へ ESCALATE
- レート制限・環境異常で続行不能 → 可能なら PM へ、PM 自身なら wait-user
