# per-task /goal テンプレート

`dispatcher.sh` + `tickets.json` から自動生成して `/goal` コマンドに投入する。

## テンプレート (placeholders を tickets.json#T-X-Y の値で埋める)

```
タスク {TASK_ID} "{TITLE}" の絶対ゴール

============================================
[共通の徹底ルール] (全タスク共通 / 違反 = 実装中止)
============================================
1. selected-stack.json の確定済技術を必ず使う
   代替・placeholder・「あとで」「動けばいい」は禁止
2. acceptance_criteria_inline の定量条件 (80%/0-error/100%) を絶対に下げない
3. files_changed_predicted の new/modify を 1 文字も逸脱しない
   逸脱が必要なら tickets.json 更新 PR を先行
4. CI gate 10 種は実体実装で全 PASS (soft-pass / || true で吞まない)
5. 仕様変更が必要なら手を止めて tickets.json を更新する

============================================
[このタスク固有]
============================================
Group / Phase / Wave: {GROUP} / {PHASE} / W{WAVE}
担当: {ASSIGNED_EMPLOYEE}
Depends on: {DEPENDS_ON}

editable (このブランチで新規/編集 OK):
{FILES_NEW_AND_MODIFY}

shared_read (参照のみ・編集禁止):
{FILES_SHARED_READ}

forbidden (他タスク専有・絶対に触れない):
{FILES_FORBIDDEN}

3-tier AC (全 PASS 必須):
  Tier 1 structural:
{TIER_1_BULLETS}

  Tier 2 functional (EARS 5 形式):
{TIER_2_BULLETS}

  Tier 3 regression (v3-gate.yml 10 種):
{TIER_3_BULLETS}

test_scenarios:
{TEST_SCENARIOS}

============================================
[逸脱検出]
============================================
- 上記 editable 以外のファイルを touch した瞬間 → STOP
- 上記 AC を満たさずに「動いた」と判断した瞬間 → STOP
- 「あとで」「TODO」「placeholder」を口にした瞬間 → gap tracker 登録
- selected-stack と異なる技術を選んだ瞬間 → STOP
- このゴールから逸脱した瞬間 → S-E01 escalation
```

## 自動生成

`scripts/generate_goal.py <TASK_ID>` を実行すると tickets.json から該当 task の
フィールドを読み込んで上記テンプレートを埋めた文字列を標準出力に印刷する。
