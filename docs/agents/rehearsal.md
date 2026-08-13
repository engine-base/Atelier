# 実機リハーサル手順 (初回 30 分 — これが通れば本運用開始)

> 目的: 机上で検証できない 4 点 — ①ccstart の起動タイミング ②セッション間
> メッセージの実往復 ③hook の実発火 ④スマホ接続 — を、壊れてもよい
> ダミータスク 1 件で確認する。結果は最後のチェックリストごと Claude
> (このキットを作ったセッション) に報告すれば、実測に基づいて調整される。

## 準備 (5 分)

```bash
cd ~/path/to/Atelier
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
      `/rename pm` 等を打ち、「CC_BOOT_TRIES を伸ばす必要あり」とメモ)
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
tmux kill-session -t flow-Atelier
```

## 実走記録 (2026-08-11・クラウドコンテナで先行実走済み)

Mac を待たず、開発コンテナ (claude CLI v2.1.227 + tmux) で STEP 1〜2 相当を実走した。
**Mac で残る確認は「/rc スマホ接続」と「Mac 固有の起動タイミング」の 2 点のみ。**

### 実証できたこと (すべて人間の操作ゼロで発生)

1. ccstart で 3 ペイン起動 + /rename 自動投入 + SessionStart hook の役割注入
2. pm がタスクパッケージ (.flow/tasks/REHEARSAL-1.md) を規約どおり作成 —
   ダミータスクが tickets.json 外であることの例外宣言まで自発的に記載
3. **メッセージ受信で dev が自動起動**して実装 (README の実在する記載ミスを発見・修正) →
   impl レポート → qa へ IMPL_DONE
4. **qa も自動起動して独立検証し、本物の差分を検出して QA_FAIL** (タスクパッケージの
   「commit 不要」に対し、フロー外の運用者が入れた commit の存在を突き止めた)
5. dev は QA_FAIL を受けて調査し、**独断せず pm へ ESCALATE** (プロトコル遵守) →
   pm が FIX_REQUEST → dev 対応、の失敗系分岐まで一周
6. flow.sh のバトン記録と Stop hook 環境が全遷移で機能

### 運用上の学び (Mac 運用にも適用)

- **フロー外から repo に手を入れない**。運用者の割り込み commit が QA_FAIL の
  引き金になった (qa が正しく検出した = 検証の独立性が本物である証明でもある)
- pm への裁定伝達と dev の ESCALATE 処理が交錯すると、pm が裁定を読む前に
  FIX_REQUEST を出すことがある。**裁定は「ESCALATE を受けてから」返すのが安全**
  (pm が止まって待っている状態で送る)
- root 環境 (Linux サーバー等) では `--permission-mode bypassPermissions` が CLI に
  拒否される。`NO_AUTO=1` + `.claude/settings.local.json` の許可リストで代替できる
  (Mac の通常ユーザーでは非該当)
