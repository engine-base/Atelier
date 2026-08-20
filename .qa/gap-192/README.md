# GAP-192 — 本番 deploy が migration を黙って skip する穴を塞ぐ

経営者質問:
> 「これまでいくつかマイグレーション追加ありってあるけど、ちゃんとこれは自動で
>   追加されているってことよね？？」

調べた結果、**ローカルは自動。本番には穴がありました。**

## 調査結果

| どこ | migration の適用 | 状態 |
|---|---|---|
| ローカル（Mac） | `dev-update.sh` → `dev-bootstrap.sh` が全 migration + seed を冪等適用 | ✅ 自動 |
| 本番（Fly.io） | `deploy.yml` が deploy の**前**に適用 | ⚠️ **穴があった** |

### 穴の中身

```yaml
- name: Apply DB migrations (schema-only)
  if: ${{ env.PROD_DATABASE_URL != '' }}   # ← secret 未設定なら黙って skip
```

`PROD_DATABASE_URL` が未設定だと、migration ステップが**静かに飛ばされたまま
deploy が成功扱いで完走**する。つまり **「新しいコードを、古いスキーマの本番へ
流す」= 起動後に 500** という事故を CI が素通ししていた。

これは **GAP-172 でローカルについて直したのと同じ穴が、本番側に残っていた**もの。

## 直したこと

1. **未設定なら deploy を止める**（黙って skip しない）
   ```
   ::error:: PROD_DATABASE_URL secret is not set.
   ::error:: 設定するまで deploy しません（古いスキーマの本番へ新しいコードを流さないため）。
   ```
2. migration / seed ステップの条件を `PROD_DATABASE_URL != ''` から
   **`skip_migrations != true`** に変更 — secret の有無で挙動が変わらないようにした
3. skip したい場合は `workflow_dispatch` の **`skip_migrations` を明示的に true**
   にする（既定 false）。使ったときは warning を出す
4. ヘッダのコメントを実態に合わせて「(任意 / 推奨)」→「**必須**」に修正

## 順序（変更なし・テストで固定）

`Verify secrets` → **`Apply migrations`** → **`Apply seeds`** → `Deploy` → `Smoke test`

migration が deploy より前でないと「新コードが古いスキーマを触る」瞬間ができるので、
この順序もテストで固定した。

## テスト

`apps/api/tests/test_deploy_and_catchup.py` — 5 件。
deploy.yml を実際にパースして、
- 未設定なら `exit 1` すること
- `if: PROD_DATABASE_URL != ''` に**戻さない**こと（それが原因だった）
- skip は明示 opt-in（既定 false）であること
- migration/seed が Deploy より前であること
を機械で守る。

## ⚠️ 経営者への確認事項

**`PROD_DATABASE_URL` の GitHub Secret が設定されているか確認してください。**
未設定の場合、今回の変更により **deploy が止まります**（これは意図した動作です。
古いスキーマの本番へ新しいコードを流すより安全なため）。

なお本番 deploy は現在 `workflow_dispatch`（手動）のみで、まだ公開していません。
