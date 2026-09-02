# 受け入れ基準 - {{FEATURE_NAME}}

**作成日:** {{CREATED_DATE}}
**作成者:** {{CREATED_BY}}
**対象スプリント:** {{SPRINT_NUMBER}}
**ステータス:** {{STATUS}}（Draft / Review / Approved）

---

## {{STORY_TITLE}}

**ユーザーストーリー:** {{USER_STORY}}

**優先度:** {{PRIORITY}}
**見積もり:** {{STORY_POINTS}}pt

---

## 前提条件

{{PRECONDITIONS}}

---

## 受け入れ基準

### 正常系

#### AC-001: {{AC_001_TITLE}}
**概要:** {{AC_001_SUMMARY}}

```gherkin
Given {{GIVEN_001}}
When  {{WHEN_001}}
Then  {{THEN_001}}
```

---

#### AC-002: {{AC_002_TITLE}}
**概要:** {{AC_002_SUMMARY}}

```gherkin
Given {{GIVEN_002}}
When  {{WHEN_002}}
Then  {{THEN_002}}
```

---

### 異常系

#### AC-{{ERROR_AC_NUM}}: {{ERROR_AC_TITLE}}
**概要:** {{ERROR_AC_SUMMARY}}

```gherkin
Given {{GIVEN_ERROR}}
When  {{WHEN_ERROR}}
Then  {{THEN_ERROR}}
```

---

### 境界値

#### AC-{{BOUNDARY_AC_NUM}}: {{BOUNDARY_AC_TITLE}}
**概要:** {{BOUNDARY_AC_SUMMARY}}

```gherkin
Given {{GIVEN_BOUNDARY}}
When  {{WHEN_BOUNDARY}}
Then  {{THEN_BOUNDARY}}
```

---

### 中断・再開

> 多ステップ・状態遷移を伴う機能のみ。中断点／中断時の状態保持／再開導線／冪等性（重複・不整合防止）／未完状態の期限を網羅する。

#### AC-{{RESUME_AC_NUM}}: 途中離脱からの再開
**概要:** {{RESUME_AC_SUMMARY}}

```gherkin
Given {{GIVEN_RESUME}}
And   入力途中（{{RESUME_STEP}}）で離脱・中断した状態
When  {{WHEN_RESUME}}
Then  中断点（{{RESUME_STEP}}）から再開でき、入力済みデータが保持されている
```

---

#### AC-{{IDEMPOTENT_AC_NUM}}: 二重送信での冪等性
**概要:** {{IDEMPOTENT_AC_SUMMARY}}

```gherkin
Given {{GIVEN_IDEMPOTENT}}
When  同一操作を二重に送信する（{{WHEN_IDEMPOTENT}}）
Then  処理は一度だけ確定し、重複レコード・二重課金・不整合が発生しない
```

---

#### AC-{{EXPIRY_AC_NUM}}: 未完状態の期限切れ
**概要:** {{EXPIRY_AC_SUMMARY}}

```gherkin
Given 未完了のまま{{EXPIRY_DURATION}}が経過した状態
When  期限到達を検知する
Then  未完状態が破棄またはリセットされ、{{EXPIRY_RESULT}}
```

---

### 異常系（UI / API / データ / 復旧 の4レイヤー）

> 全機能必須。4レイヤーそれぞれに最低1件のACを置く。
> - **UI**：分かりやすいメッセージ／リトライ導線／状態の出し分け
> - **API**：4xx（入力・権限）／5xx（サーバ）の応答
> - **データ**：ロールバック／整合性の担保
> - **復旧**：失敗→停止→復活、外部依存ダウン時の挙動

#### AC-{{ERR_UI_AC_NUM}}: 異常系（UI）
**概要:** {{ERR_UI_SUMMARY}}

```gherkin
Given {{GIVEN_ERR_UI}}
When  {{WHEN_ERR_UI}}
Then  「{{ERR_UI_MESSAGE}}」という分かりやすいメッセージが表示され、リトライ導線が提示される
```

---

#### AC-{{ERR_API_AC_NUM}}: 異常系（API）
**概要:** {{ERR_API_SUMMARY}}

```gherkin
Given {{GIVEN_ERR_API}}
When  {{WHEN_ERR_API}}
Then  {{ERR_API_STATUS}}（例: 400/401/403/409/500）が返却され、エラー内容が判別できる
```

---

#### AC-{{ERR_DATA_AC_NUM}}: 異常系（データ）
**概要:** {{ERR_DATA_SUMMARY}}

```gherkin
Given {{GIVEN_ERR_DATA}}
When  処理の途中で失敗する（{{WHEN_ERR_DATA}}）
Then  変更がロールバックされ、データ整合性が保たれる（中途半端な状態が残らない）
```

---

#### AC-{{ERR_RECOVERY_AC_NUM}}: 異常系（復旧）
**概要:** {{ERR_RECOVERY_SUMMARY}}

```gherkin
Given 外部依存（{{ERR_RECOVERY_DEP}}）がダウンしている状態
When  {{WHEN_ERR_RECOVERY}}
Then  処理は安全に停止し、復旧後に{{ERR_RECOVERY_RESULT}}（データ消失・多重実行が起きない）
```

---

## AC一覧サマリー

> 種別には「正常系 / 異常系 / 境界値 / 中断・再開 / 異常系(UI) / 異常系(API) / 異常系(データ) / 異常系(復旧)」を用いる。

| ID | タイトル | 種別 | 優先度 | テスト担当 |
|----|---------|------|--------|----------|
{{AC_SUMMARY_ROWS}}

---

## スコープ外

{{OUT_OF_SCOPE}}

---

## 備考・補足

{{NOTES}}

---

*作成日: {{CREATED_DATE}} / 作成者: {{CREATED_BY}} / 承認者: {{APPROVER}}*
