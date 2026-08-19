# GAP-168: Bridge 未接続なら「接続フロー」をその場に出す (チャット以外の全画面)

経営者指摘 (2026-08-19):
「以前実装で、もし接続できていない場合、接続させるフローが出てくる状態に
更新しているはずだけど、なんで出てない？ バグじゃないか？？」

**指摘のとおり、私の実装漏れ (実バグ) でした。**

## 元々どうだったか → どうしたか

| | 修正前 | 修正後 (GAP-168) |
|---|---|---|
| 接続フローの置き場所 | `ConnectionStatus.tsx` の中の非公開 `ConnectFlow` — **チャット画面 (S-E01) にしか無い** | `components/bridge/BridgeConnectFlow.tsx` に切り出した共通部品 |
| モックの改訂が未接続で失敗 | 「AI 実行経路が使えません (Bridge がオフラインの可能性)」の**文字だけ**。繋ぐ手段が画面に無い | 指示欄の直前に **接続フロー**（インストール導線 → 接続トークン発行 → 「アプリで接続」） |
| モックの新規生成が未接続 | 同上（文字だけ） | 同上 |
| 出力デザインテンプレの作成/改訂が未接続 | 同上（文字だけ） | 同上 |
| Excel/PDF の AI ファイル修正が未接続 | 同上（文字だけ） | 同上 |
| グローバル toast (503) | 「**サーバーでエラーが発生しました。**」= 嘘（サーバーは正常。未接続なのはユーザーの PC） | 「お使いのパソコン (Bridge) が未接続です。画面の案内から接続してください。」 |

**どこで動くか / 誰の費用か**: 接続フローの画面と、トークン発行 API (`POST /bridge-tokens`)
は SaaS クラウド側。実行そのもの (モック生成・改訂、テンプレ生成、ファイル修正) は
**利用者本人の PC の Bridge = 本人の Claude サブスク**。この画面が出るのは
「本人の PC が繋がっていない」状態であり、運営の API キーへ勝手に切り替えることはしない
(偽の成功を出さない)。

## 実装

- `components/bridge/BridgeConnectFlow.tsx` — チャット画面にしか無かった接続手順を
  そのまま切り出し (GAP-122 の内容を変えていない)。`ConnectionStatus` はこれを使う形に変更。
- `components/bridge/BridgeOfflineNotice.tsx` — 「何が止まったか」+ 「どこで動くか」+
  折りたたみ可能な接続フロー。`isBridgeOffline(error)` (= ApiError 503) も公開。
- 露出させた画面:
  - `app/templates/_components/DesignTemplateStudio.tsx` (テンプレの作成 / 改訂)
  - `app/outputs/s_g01/_components/SheetEditor.tsx` (ファイルの AI 修正依頼 — GAP-166)
  - `app/mocks/s_h01/_components/MockViewer(.Container).tsx` (モックの改訂)
  - `app/mocks/s_h01/_components/MockListContainer.tsx` (モックの生成)
  - `app/mocks/s_h01/_components/MockCanvas.tsx` (キャンバス内の改訂)
- `lib/query-client.ts` — 503 の toast 文言を実態に合わせた。

## 証拠 (実ブラウザ + 実 API。**fake LLM を切った = 実行経路ゼロの本物の 503**)

API は `ATELIER_ALLOW_FAKE_LLM` を**設定せずに**起動しているので、下記の 503 は
スタブではなく「本当に実行経路が無い」状態そのものです。

- `168-templates.png` — テンプレスタジオで「改訂を依頼」→ 未接続 → 接続フロー
- `168-output-file-edit.png` — Excel 成果物の「AI にファイルごと直してもらう」→ 接続フロー
  (toast も「サーバーでエラー」ではなく未接続の文言になっている)
- `168-mock-studio.png` — モックスタジオでワンダに改訂依頼 → 指示欄の直前に接続フロー
- `168-mock-new.png` — モック一覧の「新規モック」→「生成する」→ 接続フロー
- `168-token-issued.png` — 実際に「接続トークンを発行」を押し、`atelier-bridge://connect`
  の「アプリで接続」リンクが出るところまで実測

e2e スクリプト出力 (実測値):

```
TEMPLATES_ALERT: お使いのパソコン (Bridge) が未接続のためテンプレの改訂を実行できません
TEMPLATES_FLOW: true
OUTPUT_ALERT: お使いのパソコン (Bridge) が未接続のためファイルの AI 修正依頼を実行できません
OUTPUT_FLOW: true
MOCK_ALERT: お使いのパソコン (Bridge) が未接続のためモックの改訂を実行できません
MOCK_FLOW: true
MOCKLIST_ALERT: お使いのパソコン (Bridge) が未接続のためモックの生成を実行できません
MOCKLIST_FLOW: true
CONNECT_HREF_SCHEME: atelier-bridge://connect
CONNECT_HAS_TOKEN: true
```

## 自動テスト

- `tests/bundle-h/bridge-offline-notice.test.tsx` (8):
  文言と「どこで動くか」の明示 / `POST /bridge-tokens` の実パスと
  `atelier-bridge://connect?api=…&token=…` の実 href / 折りたたみ /
  `isBridgeOffline` は 503 のみ / テンプレ・成果物・モックの 3 画面で接続フローが出る /
  503 の toast 文言
- 既存テストも「文字だけ」から「文字 + 接続フロー」へ書き換え済
  (`design-template-studio` / `sheet-editor` / `uc13-mock-viewer`)
