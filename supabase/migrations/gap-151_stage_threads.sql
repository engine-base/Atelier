-- GAP-151: 工程ごとの専用スレッド (経営者すり合わせ: 「チャットというタブでは
-- なく工程ごとに備わっている」「スレッドは各工程の中にある感じ」「社員は固定的に
-- こっちで決めておく」)
--
-- 各フローステージが自分の会話 (chat_thread) を 1 本持つ。担当社員は
-- ステージ × 部門で固定 (運営テンプレの部門代表)。スレッドが消されたら
-- null に戻り、次に開いたとき再作成される。

alter table public.project_flow_stages
  add column if not exists thread_id uuid references public.chat_threads(id) on delete set null;

comment on column public.project_flow_stages.thread_id is
  'GAP-151: この工程の専用会話。工程を開くと自動作成される (担当 = 部門の代表社員で固定)。';
