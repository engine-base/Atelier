# 実機リハーサル手順 (初回 30 分 — これが通れば本運用開始)

> 目的: 机上で検証できない 4 点 — ①ccstart の起動タイミング ②セッション間
> メッセージの実往復 ③hook の実発火 ④スマホ接続 — を、壊れてもよい
> ダミータスク 1 件で確認する。結果は最後のチェックリストごと Claude
> (このキットを作ったセッション) に報告すれば、実測に基づいて調整される。

## 準備 (5 分)

```bash
cd <プロジェクトルート>
git pull
claude --version   # v2.1.224 以上であること
./scripts/ccstart.sh
```

## STEP 1: 起動確認 (5 分)

- [ ] 3 ペイン (左 pm / 右上 dev / 右下 qa) に claude が起動した
- [ ] 各ペインで役割注入が効いている (「PM 準備完了」「dev 準備完了」
      「qa 準備完了」と応答する)。※役割注入は SessionStart hook なので
      起動タイミングに関係なく入るはず — 入らなければそれ自体が重要な報告事項
- [ ] `/rename` が入った (各ペイン上部/タイトルで確認。空振りしていたら手で
      `/rename pm` 等を打ち、「CC_BOOT_WAIT を伸ばす必要あり」とメモ)
- [ ] `/rc` の QR/リンクが表示された → スマホの Claude アプリ Code タブで
      pm セッションが見える

## STEP 2: ダミータスクで 1 周 (15 分)

pm ペインに次を貼る:

> リハーサル開始。タスク「REHEARSAL-1: docs/agents/README.md の文中から
> 誤字または改善できる表現を 1 箇所だけ直す」を protocol どおりに回してください。
> タスクパッケージを書き、dev に払い出すこと。

観察ポイント (上から順に起きるはず):

- [ ] pm が `.flow/tasks/REHEARSAL-1.md` を書いてから dev にメッセージを送った
- [ ] **dev ペインが勝手に動き出した** (これがセッション間メッセージの実証)
- [ ] dev が修正 → commit → `.flow/reports/REHEARSAL-1-impl.md` → qa へ送信
- [ ] qa が自分で diff/ファイルを確認して pm へ QA_PASS (または dev へ QA_FAIL)
- [ ] pm が検収して「完了」の報告をこちらに向けて書いた
- [ ] 途中で誰かが止まったら: `./scripts/agents/flow.sh status` を実行して
      出力をメモ → そのペインに「protocol.md に従って続きを進めて」と一言で
      復旧するかを確認 (これも重要な実測データ)

## STEP 3: スマホと再開の確認 (5 分)

- [ ] スマホから pm に「現在の進捗を教えて」と送って返答が来る
- [ ] 任意: どれか 1 ペインを Ctrl+C で殺し、`CC_ROLE=dev claude --continue`
      で再開 → 役割とバトン状態が自動注入されて続きを認識するか

## 報告テンプレ (これをそのまま Claude に貼る)

```
リハーサル結果:
- 起動: 3 ペイン起動 [OK/NG]、役割注入 [OK/NG: どのペイン]、/rename [OK/空振り: どのペイン]、/rc [OK/NG]
- 1 周: パッケージ作成 [OK/NG] → dev 自動起動 [OK/NG] → 実装 [OK/NG] → qa 検証 [OK/NG] → 検収 [OK/NG]
- 止まった箇所と flow.sh status の出力: (あれば)
- スマホ: 表示 [OK/NG]、返信 [OK/NG]
- 気づいたこと: (自由記述)
```

## 後片付け

```bash
git log --oneline -3   # REHEARSAL-1 の commit を確認 (残してよければそのまま)
tmux kill-session -t flow-<リポジトリ名>
```
