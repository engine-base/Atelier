# 3 役セッション メッセージプロトコル (PM / dev / qa)

> 対象: ターミナル版 Claude Code のセッション間メッセージ (cross-session messaging) で
> PM・実装 (dev)・検証 (qa) の 3 セッションがバトンリレーで自走するための共通規約。
> 各役割の責務は `pm.md` / `dev.md` / `qa.md`。起動と復旧は `README.md`。

## 大原則

1. **仕様の正はファイル、メッセージはバトン**。メッセージはテキストのみで
   コンテキストを共有しない。仕様・進捗・検収結果はすべてリポジトリのファイル
   (`07_tasks/tickets.json` / `docs/gap-tracker.md` / `.flow/state.json` /
   `.flow/reports/`) に書き、受け手はファイルを読み直してから動く。
   メッセージ本文だけを根拠に実装・検収してはならない。
2. **同時に動くのは常に 1 役 (バトン保持者) だけ**。git の書き込み・commit は
   バトン保持者のみが行う (競合防止)。バトンを持っていない役はメッセージ受信まで
   何もしない。
3. **自分のターンは「state 更新 + バトン送信」までやって初めて終了**。
   Stop hook (`scripts/agents/flow-stop-hook.sh`) が、バトン未送信のまま
   ターンを終えようとすると差し戻す。
4. **ユーザー (経営者) への連絡窓口は PM のみ**。dev / qa はユーザーに直接
   確認せず、PM へ ESCALATE する。

## メッセージ種別 (件名プレフィックス必須)

| 種別 | 送信者 → 受信者 | 意味 | 本文に必須の内容 |
|---|---|---|---|
| `TASK_READY` | pm → dev | このタスク(束)を実装せよ | タスク ID(束)、**タスクパッケージ `.flow/tasks/<ID>.md` のパス (必須 — pm.md 参照。上流成果物の由来・実装方針・完了定義を含む)**、束の場合は先頭タスクと bundle 構成、特記事項 |
| `IMPL_DONE` | dev → qa | 実装完了、検証せよ | タスク ID、commit hash、変更ファイル要約、実行済みテストと結果、監査スクリプトのパス |
| `QA_PASS` | qa → pm | 検証合格、検収せよ | タスク ID、実行した検証一覧と結果、QA レポートのパス (`.flow/reports/`) |
| `QA_FAIL` | qa → dev | 不合格、修正せよ | タスク ID、**再現手順つき**の不合格項目 (期待/実際)、QA レポートのパス。修正ループを速くするため dev へ直接返す |
| `ACCEPTED` | pm → dev | 検収完了。次タスクがあれば続けて `TASK_READY` | タスク ID、検収チェックリスト結果のパス |
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
- `handoff` = バトンを渡し終えた宣言。**必ず実際にメッセージを送信してから**実行する
  (先に handoff してからメッセージを忘れるのが最悪の事故)。
- `wait-user` / `idle` は停止が正当な状態。hook は通す。

## 標準ループ

```
ユーザー「開始」→ PM
PM:  tickets.json / gap-tracker を読む → 次の束を決定
     → flow.sh take pm → TASK_READY 送信 → flow.sh handoff pm dev → 停止
dev: flow.sh take dev → begin-task.sh / 実装 / テスト / 監査 / commit
     → IMPL_DONE 送信 → flow.sh handoff dev qa → 停止
qa:  flow.sh take qa → 独立検証 (dev の自己申告を信用しない)
     → PASS: QA_PASS → handoff qa pm / FAIL: QA_FAIL → handoff qa dev → 停止
PM:  検収チェックリスト (pm.md) → ACCEPTED + 次の TASK_READY、または FIX_REQUEST
     → 節目・確認事項があれば wait-user でユーザーに報告して待つ
```

## 連続進行モード (autopilot — 既定の運転方針)

この運用の目的は「**人間は上流 (仕様) を作り込み済み。実行は放置で全タスクが
終わる**」こと。したがって:

1. **PM は ACCEPTED を出したら、停止せずそのまま次の束の `TASK_READY` を出す**。
   タスク源 (tickets.json / gap-tracker) が尽きるまでこれを繰り返す。
   「次に進んでよいですか」という確認のための wait-user は**禁止**。
2. **`wait-user` で停止してよいのは次の限定列挙のみ**:
   - 致命級ゲート (R-T08 / T-D-22 / T-A-45 / T-I-24 相当) の承認
   - 仕様変更が必要で、上流成果物 (ヒアリング〜API 設計〜tickets.json) の
     どこにも答えが無い判断
   - 外部契約・鍵 (OAuth / Stripe 等) が前提で人間にしか進められない
   - タスク源をすべて消化した (このときは `idle` + 最終サマリ)
   - レート制限・環境異常で続行不能
3. **進捗報告は「非停止」で行う**。検収ごとの報告は
   `.flow/reports/progress.md` に追記して次の TASK_READY と同時に流す
   (ユーザーはスマホでいつでも読める)。報告のために止まらない。
4. 列挙外の「聞きたいこと」が出たら、**自分の推奨案を採用して進み**、採用した
   判断と根拠を progress.md に記録する (次のユーザー接点でまとめて追認を得る)。

## 検証用 worktree (qa 必須 / 束 C の実害を受けて追加)

3 役は**同一ワーキングツリーを共有している**。バトン制は git の *書き込み* 競合は防ぐが、
**読み取り時点のツリーの状態**までは保証しない。束 C で実害が出た: qa が「修正前の状態」の
つもりでビルドしたツリーには dev の修正が既に入っており、**PRE-FIX を測ったつもりで
POST-FIX を測っていた**。結果、dev の正しい申告を qa が誤って否定し、PM がそれを採用して
台帳を 2 回書き換える事故になった (GAP-118)。

したがって、**過去 commit との A/B 比較やビルド成果物の検証は、共有ツリーで行ってはならない**。

```bash
# 隔離ツリーを作って測る (共有ツリーには一切触れない)
git worktree add /tmp/atelier-verify-<用途> <commit-ish>
cd /tmp/atelier-verify-<用途> && <install> && <build> && <測定>
git worktree remove /tmp/atelier-verify-<用途>
```

共有ツリーでファイルを一時的に差し替えて測る運用は**禁止**する
(`git show <rev>:<path> > <path>` のような手順を含む)。

測定時は次を必ず記録する:
- **測定対象ファイルの中身**をビルド直前に自分で表示・記録する
  (HEAD の表示とファイル実体が一致する保証はない)
- **成果物のハッシュ/ファイル名** — どのビルドの産物かを対応づけられる形で
- 「修正前は壊れていなかった」は、**修正前の状態を自分で再構成して測ったときにのみ**言う

## エスカレーション必須条件 (dev/qa は自己判断禁止)

- 仕様変更が必要 (tickets.json と実装が矛盾 / AC が満たせない) → CLAUDE.md の
  仕様変更プロトコルに従い **PM が** tickets.json を更新する
- 致命級ゲート (R-T08 / T-D-22 / T-A-45 / T-I-24 相当) に触れる → PM 経由で
  **ユーザー (経営者) の明示承認**を得るまで着手しない
- 外部契約・鍵 (OAuth / Stripe 等) が前提のタスク → PM へ返す
- 同一タスクで QA_FAIL が 3 回 → qa は dev ではなく PM へ ESCALATE
- レート制限・環境異常で続行不能 → 可能なら PM へ、PM 自身なら wait-user
- **ESCALATE を受けた PM は、裁定を出す前に自分宛の未処理メッセージ (ユーザー/運用者
  からの裁定・補足) が無いか必ず確認する**。ユーザー裁定と矛盾する FIX_REQUEST を
  出さない (コンテナ実走で検出した交錯事故の再発防止 — rehearsal.md 実走記録参照)
