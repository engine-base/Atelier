# GAP-144: スキル本文 (SKILL.md) の DB 層秘匿

## 経営者確認 (2026-08-18)

「スキルは管理（運用）側の画面で設定する状態にしていたはず。各ユーザーが勝手に
作ることはできない。こちらで準備したもの・スキルの詳細は各ユーザーには見えない
状態で使える、だよね？？」

## 確認結果 (元からできていた部分)

- **作成・編集・削除・装着は運営 admin 専用** (T-A-49): POST/PATCH/DELETE
  /admin/skills* は is_admin gate (非 admin は 403) + service_role 書込 + audit。
  DB 側も RLS (skills_no_insert/update/delete) + GAP-144 で grant 剥奪の二重防御。
- **一般ユーザーの API には本文が出ない**: GET /skills (カタログ) は
  SkillLiteResponse (id/name/version/description/is_active) のみ。content_md を
  返すのは admin 専用 GET /admin/skills[/{id}] だけ。
- **利用は「効果だけ」**: 装着スキルの SKILL.md はチャット/モック生成の
  system prompt に注入される (ユーザーは本文を見ずに恩恵だけ受ける)。

## 見つけた穴 (このゲートで修正)

本番の認証は Supabase Auth 発行 JWT をそのまま使うため、その JWT は
**Supabase PostgREST (DB 直叩き API) でも有効**。skills の RLS は
`skills_select_all using (true)` で行レベルは全開放しており、**列を隠す力が
無い** — 悪意あるユーザーが PostgREST を直接叩けば content_md (スキル本文 =
運営のノウハウ) と allowed_* (運用設定) を全文読めた。

## 対処 (gap-144_skills_content_revoke.sql — GAP-131 vault と同手法)

- authenticated / anon から skills の**表全体 grant を剥奪**
- authenticated には**カタログ用の軽量列のみ**列単位で grant し直す
  (id, name, version, description, is_active, created_at, updated_at)
- API 内部の本文読取を **service 経路に一本化**:
  - チャット/モック生成の注入 → `services/skills.fetch_skills_md` (新設)
  - admin 閲覧 → `list_skills_admin` / `get_skill_admin` を service 経路化
    (route の is_admin gate は従来どおり)

## 証跡

- `db-column-revoke.txt`: authenticated role で
  `select content_md from skills` → **permission denied** /
  軽量列の select は成功 (実 DB での列 revoke 実証)。
- tests/routes/test_skills.py::test_gap144_content_md_hidden_from_authenticated_role:
  拒否 + カタログ可 + admin 詳細は本文を維持 + 注入経路 (fetch_skills_md) 継続
  を 1 本で回帰テスト化。
- pytest: test_skills + test_admin 37 PASS / test_chat_sse + test_chat +
  test_mock_generate 43 PASS (注入の継続確認)。ruff / pyright 0。

## どこで動くか / 誰の費用か

すべて SaaS クラウド側 (DB grant + FastAPI)。費用影響なし。
