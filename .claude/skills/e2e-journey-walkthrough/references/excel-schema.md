# Excel スキーマ・列定義・blocking ルール

`scripts/journey_workbook.py` が生成/更新する Excel の仕様。

## ワークブック構成（3シート）

### Sheet `Plan`（ジャーニー行 = 検証単位。1行1ステップ）
| 列 | 意味 |
|---|---|
| id | 一意ID(例 `admin-onboard-01`)。update の対象キー |
| order | 実行順(整数, 依存順トポロジカル)。小さいほど先 |
| role | アカウントタイプ(admin / tenant / customer / client_portal / guest 等) |
| phase | onboard / auth / configure / operate / outcome |
| data_condition | existing(既存を使う) / create-new(作成・編集してから) |
| branch | happy / validation / permission / empty / limit / conflict / cancel / isolation |
| depends_on | 前提行の id をカンマ区切り(空可)。未達なら BLOCKED |
| action | 何をするか(1行)。例「空き枠を選んで予約する」 |
| steps | 実操作手順(画面での具体操作。改行可) |
| expected | 期待結果。**「何が画面に出れば成功か」**を具体的に |
| status | TODO / PASS / FAIL / BLOCKED / SKIP(理由必須) |
| evidence | スクショパス / URL / 実データ(予約番号等) |
| note | 補足・FAIL理由・SKIP理由・gap起票番号 |

### Sheet `Roles`（ロールと依存関係)
| 列 | 意味 |
|---|---|
| role | ロール名 |
| how_to_enter | 入口(サインアップ/ログイン経路・別cookie・招待トークン等) |
| goal | そのロールの最終成果(outcome) |
| provides | このロールが作る/設定する前提(後続が消費) |
| consumes | このロールが消費する前提(どのロールの provides) |

### Sheet `Summary`（進捗と blocking 判定）
- 総行数 / PASS / FAIL / BLOCKED / TODO / SKIP の件数と割合。
- `DONE?` セル: 全行が PASS(または理由付き SKIP) なら `YES`、それ以外は `NO`。
- role別・branch別の PASS 率も出す。

## plan.json スキーマ（init に渡す）
```json
{
  "project": "アプリ名",
  "discovered": { "roles": ["admin","tenant","customer"], "dependency_note": "admin→tenant→customer" },
  "rows": [
    {
      "id": "tenant-configure-slot-01",
      "order": 20,
      "role": "tenant",
      "phase": "configure",
      "data_condition": "create-new",
      "branch": "happy",
      "depends_on": ["admin-provision-tenant-01"],
      "action": "予約枠を新規作成する",
      "steps": "店舗ログイン→枠管理→新規→日時/定員入力→保存",
      "expected": "作成した枠が一覧に表示され、ユーザー側の検索に出る",
      "status": "TODO", "evidence": "", "note": ""
    }
  ]
}
```

## blocking ルール（絶対原則6の実装）
- `status` サブコマンドは、**全行が PASS または (SKIP かつ note に理由あり)** のときだけ exit 0。
- TODO / FAIL / BLOCKED が1行でもあれば exit 1 を返し、未達行を一覧表示する。
- スキル完了報告の前に必ず `status` を実行し、exit 0 とスクショ添付を確認する。exit 1 の状態で
  「完了しました」と言ってはいけない。
- `Summary!DONE?` が `YES` でない限り、ユーザーに「通しテスト完了」と報告しない。

## 運用メモ
- 保存先は `<project>/.qa/e2e-journey/journey-<YYYYMMDD>.xlsx`。既存があれば追記更新（再実行で回帰）。
- FAIL を実装修正で直した後は、当該行を再実行して PASS に更新（直しっぱなしで status を書き換えない）。
- SKIP は「この環境では該当機能なし」等の正当理由がある時のみ。理由を note に必須で書く。
