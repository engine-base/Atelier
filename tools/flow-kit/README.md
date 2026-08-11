# flow-kit — どのプロジェクトでも使える 3 役自走運用 (PM / dev / qa)

ターミナル版 Claude Code のセッション間メッセージで「PM が仕様から払い出し →
dev が実装 → qa が独立検証 → PM が検収して次へ」のバトンリレーを自走させる
汎用キット。Atelier で運用している仕組みの移植可能版。

## 他のプロジェクトへの導入 (1 コマンド)

```bash
# この Atelier リポジトリから任意のプロジェクトへ
./tools/flow-kit/install.sh ~/path/to/other-project
```

導入されるもの:

| 配置先 | 内容 | 既存がある場合 |
|---|---|---|
| `scripts/ccstart.sh` | caffeinate + tmux 3 ペイン + /rename + /rc + boot 投入のワンコマンド起動 | 上書き (常に最新) |
| `scripts/agents/flow.sh` / `flow-stop-hook.sh` | バトン管理 + ターン終了強制 | 上書き (常に最新) |
| `docs/agents/*.md` + `boot/*.txt` | プロトコル・役割定義・**project.md (プロジェクト固有設定)** | 保持 (上書きしない) |
| `.claude/settings.json` | Stop hook の配線 | 既存設定にマージ |
| `.gitignore` | `.flow/` (ランタイム状態) | 済みならスキップ |

## プロジェクトごとに違う部分は `docs/agents/project.md` に集約

キット本体 (スクリプト・プロトコル・役割の骨格) は完全に汎用で、
プロジェクト固有なのは次の 5 点だけ。導入後に `project.md` を埋める:

1. 仕様の正 (どのファイルが SPEC か)
2. タスクの出どころ (PM が何から払い出すか)
3. dev の DoD (完了と言える条件・実行コマンド)
4. qa の検証手段 (何を再実行して確かめるか)
5. 検収基準と「人間承認が必須の操作」

埋めずに起動しても、PM が初回ターンでリポジトリを調査して下書きを作り、
ユーザーに確認してから運用を始める。

- 使い方・復旧手順: 導入先の `docs/agents/README.md` (テンプレは `templates/README.md`)
- Atelier 自身は `docs/agents/` にこのキットの Atelier 特化版 (tickets.json /
  begin-task.sh / 13 gate 前提) を配置済みで、そちらが優先される

## 更新の配り方

キットを改良したら、各プロジェクトで `install.sh` を再実行するだけ
(スクリプトは最新化され、各プロジェクトの役割定義・project.md は保持される)。
