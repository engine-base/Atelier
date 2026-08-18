-- GAP-155: 同時編集ガード (経営者すり合わせ:「デザインは複数人同時だと怖くないか」
-- 「ブランチはやらない。誰がどう変えたかわかって戻せたらいいレベル。モック以外もね」)
--
-- 実バグの是正: mocks に (project, 画面, version) の一意制約が無く、
-- 2 人が同時に改訂すると「v4 が 2 つ」できる余地があった (DB 実確認)。
-- 一意制約を張り、人間の改訂の同時衝突は API が 409 で誠実に伝える
-- (黙って積み直すと後勝ちが先勝ちの変更を含まない「消えたように見える」
-- 状態になるため、リトライではなくユーザーに再確認させる)。
-- Bridge の成果物取り込み (新規ファイル由来) だけはリトライで吸収する。

-- 万一の既存重複は version を+1 して退避してから制約を張る (データは消さない)
with dup as (
  select id, row_number() over (
    partition by project_id, screen_name, version order by created_at
  ) - 1 as extra
  from public.mocks where deleted_at is null
)
update public.mocks m
set version = m.version + d.extra,
    updated_at = now()
from dup d
where m.id = d.id and d.extra > 0;

create unique index if not exists mocks_project_screen_version_uq
  on public.mocks (project_id, screen_name, version)
  where deleted_at is null;

-- workflow_outputs も同様 (HTML 文書は project+stage、ファイルは +file_name で連鎖)
create unique index if not exists workflow_outputs_chain_version_uq
  on public.workflow_outputs (
    project_id, stage, coalesce(meta ->> 'file_name', ''), version
  )
  where deleted_at is null;
