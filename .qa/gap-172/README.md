# GAP-172: `dev-bootstrap.sh` が migration を黙って skip し、半分欠けた DB を「完了」と表示していた

GAP-168/169 の検証中、このコンテナで DB を作り直したときに **18 本の migration が
skip されたまま「✓ DB ブートストラップ完了」と出た**。同じことは経営者の Mac で
新規セットアップした場合にも起きる (= アプリが動かない DB ができる)。

## 原因は 3 つ

### ① ファイル名の辞書順と依存順が一致しない
`ls supabase/migrations/*.sql | sort` は `gap-*.sql` を `t-d-*.sql` **より先**に並べる。
後から入った `gap-*` は土台の `t-d-*` に依存しているので、1 周だけの適用では必ず失敗する。
それを「Supabase 依存だから skip」と一括りにして飲み込んでいた。

→ **収束するまで何周でも回す**。1 周で 1 本でも新しく通れば次の周でさらに通せる
可能性がある。進捗ゼロになったら止め、**最後まで通らなかったものだけ**を
本物の失敗としてエラー本文つきで表示する。

### ② ロール GRANT が migration の後だった
RLS 越境試験の migration (`t-d-31` / `t-d-32`) は `authenticated` ロールに切り替えて
実データを読む。GRANT が後回しだと `permission denied for table chat_threads` で
必ず失敗し、**越境試験が 1 度も実行されない DB** ができていた (R-T08 は致命級ゲート)。

→ GRANT を関数化し、**migration の各周の頭でも流す**。

### ③ `grant all on all tables` が列レベルの REVOKE を取り消していた
migration が張った機密列の秘匿 (`encrypted_value` / `content_md` / `data` 等) が、
その後の `grant all` で**全部戻ってしまい、アプリロールから丸見えの DB** になっていた
(実測で `byok_api_keys` の列 revoke が消えていた)。

→ revoke を含む migration (15 本) を GRANT の**後**にもう一度流して最終状態にする。

### 併せて修正した 2 点
- `service_role` を `bypassrls` つきで作る (Supabase 本番と同じ性質。R-T07 の前提)。
  素の `create role` だったため、越境防止テストが
  「service_role exists but does not bypass RLS」で落ちる DB になっていた。
- `t-d-31` / `t-d-32` の fixture insert に `on conflict do nothing` を追加。
  後から入った `workspaces_bootstrap_owner_membership` トリガが owner membership を
  自動作成するようになり、明示 insert が重複キーで落ちるようになっていた。

## 実測 (`bootstrap.txt`)

```
=== 修正前 ===
→ migration: 63 applied / 20 skipped   → それでも「✓ 完了」
   public テーブル数: 48 (delivery_phases / mock_contents / output_design_templates /
   knowledge_candidates / project_flow_stages / artifact_files が丸ごと無い)

=== 修正後 ===
→ migration: 83 applied / 0 skipped (2 周で収束)
→ revoke: 15 本を再適用
   public テーブル数: 56 / 上記テーブルすべて OK
   service_role BYPASSRLS: true
   機密列 revoke: permission denied for table project_credentials  ← 秘匿が効いている
   非機密列は読める (count(id)): 0                                 ← 列 GRANT は生きている
```

さらに、この**まっさらな DB に対して RLS テスト (`tests/rls`) が全件 PASS** する
ことを確認した (修正前の DB では R-T06 / R-T07 が落ちていた)。
