# supabase/seed — 運営固定データ

migration 適用後に `scripts/ci/apply-seeds.sh` が辞書順で流す。全て UPSERT で再実行安全。

## 法務文書 (legal_documents) はここに置かない — migration が正本 (GAP-220)

2026-08-26 の通し (J00-04) で、**新しい環境では seed が必ず失敗する**ことが分かった。

```
ERROR: duplicate key value violates unique constraint "legal_documents_current_uidx"
DETAIL: Key (doc_type, locale)=(tokushoho, ja) already exists.
```

経緯はこう:

1. `t-d-25.sql` は法務文書の初版 (2026-05-25) を `is_current = true` で入れる seed だった
2. その後 GAP-188 / GAP-204 / GAP-208 が **migration として**新しい版を入れ、
   現行を 2026-08-22 に移した
3. 新しい環境では migration → seed の順に流れるので、seed が
   **既に現行がある doc_type に、古い版をもう一度 current として立てようとする**
   → 部分 unique index に衝突して落ちる

`apply-seeds.sh` は `set -euo pipefail` + `ON_ERROR_STOP=1` なので、ここで
**exit 3** になる。CI の DB 用意も、`deploy.yml` の「Apply DB seeds」も同じく落ちる。

しかも **成功していたらもっと悪かった**。seed の tokushoho は運営統括責任者が
「（担当者名）」のままの古い文面で、GAP-208 で直した内容を**上書きで巻き戻す**。
落ちていたおかげで巻き戻らなかっただけ。

したがって `t-d-25.sql` は削除した。**法務文書は migration が単一の正本**で、
版を足すときも migration で足す (旧版は同意記録の突き合わせ用に残し、
`is_current` だけ移す)。

> 同じ表を seed と migration の両方が書くと、どちらが勝つかは適用順で決まる。
> 「両方に書いてある」状態自体が事故なので、**表ごとに持ち主を 1 つに決める**。
