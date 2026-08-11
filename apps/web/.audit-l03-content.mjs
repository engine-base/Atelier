/**
 * GAP-029 実操作監査 (S-L03 クライアントポータル実コンテンツ — R-T08 経営者承認済)
 *
 * 検証: ① 招待 (SQL seed) → API 署名 → cookie 設定 → ポータル実描画 ② バナーの
 * リンク有効期限 (実 expires_at) ③ 工程進捗バー + 実 % ④ 成果物一覧 (stage 毎
 * 最新版 + 実在フォーマットのみ) ⑤ モックギャラリー (画面毎最新版 + 全 N 画面)
 * ⑥ コメント投稿 → DB 突合 (author_invitation_id + audit) → 一覧反映 → 運営返信
 * 表示 / 社内メモ非表示 ⑦ R-T08 越境 (別 project の全 content endpoint 403 +
 * 他 project target への投稿 404) ⑧ view-only 招待では投稿フォーム非表示。
 * seed した project/招待のみ操作し、終了時に削除 (再実行可能)。
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const SP = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const sql = (q) =>
  execSync(`PGPASSWORD=devpass psql -h localhost -U atelier_dev -d atelier_dev -tAc "${q.replaceAll('"', '\\"')}"`, {
    encoding: 'utf8',
  }).trim();
const one = (q) => sql(q).split('\n')[0].trim();
const api = async (method, path, body, bearer) => {
  const r = await fetch(`http://localhost:8000${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const mark = Math.random().toString(36).slice(2, 7);
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

// 前回残留掃除
sql("delete from comments where target_id in (select id from workflow_outputs where project_id in (select id from projects where name like 'L03監査-%'))");
sql("delete from audit_logs where action in ('client.signin','client.comment.create') and target_id in (select id from client_invitations where email like 'l03-audit-%')");
sql("delete from client_invitations where email like 'l03-audit-%'");
sql("delete from workflow_outputs where project_id in (select id from projects where name like 'L03監査-%')");
sql("delete from mocks where project_id in (select id from projects where name like 'L03監査-%')");
sql("delete from phases where project_id in (select id from projects where name like 'L03監査-%')");
sql("delete from projects where name like 'L03監査-%'");

// ── seed: 監査専用 project + phases/outputs/mocks + 招待 2 種 ──
const ws = one("select w.id from workspaces w join users u on u.id = w.owner_user_id where u.email='design-audit@example.com' and w.deleted_at is null limit 1");
const proj = one(`insert into projects (workspace_id, name, client_name, project_type) values ('${ws}','L03監査-${mark}','監査クライアント様','client_work') returning id`);
sql(`insert into phases (project_id, "order", name, status) values ('${proj}',1,'ヒアリング','completed'), ('${proj}',2,'要件','in_progress'), ('${proj}',3,'納品','pending')`);
const outHear = one(`insert into workflow_outputs (project_id, stage, version, html_path, summary) values ('${proj}','hearing',2,'h2.html','ヒアリング v2') returning id`);
sql(`insert into workflow_outputs (project_id, stage, version, html_path, md_path) values ('${proj}','hearing',1,'h1.html','h1.md')`);
sql(`insert into workflow_outputs (project_id, stage, version, md_path) values ('${proj}','requirements',1,'r1.md')`);
sql(`insert into mocks (project_id, screen_name, html_storage_path, version) values ('${proj}','トップページ','mocks/t1.html',1), ('${proj}','トップページ','mocks/t2.html',2), ('${proj}','カート','mocks/c1.html',1)`);
const tokenFull = `l03-audit-full-${mark}-0123456789`;
const tokenView = `l03-audit-view-${mark}-0123456789`;
const hash = (t) => createHash('sha256').update(t).digest('hex');
const invFull = one(
  `insert into client_invitations (project_id, email, token_hash, scopes, expires_at) values ('${proj}','l03-audit-${mark}@ext.example','${hash(tokenFull)}',jsonb_build_array('view','comment'), now() + interval '7 days') returning id`,
);
sql(`insert into client_invitations (project_id, email, token_hash, scopes, expires_at) values ('${proj}','l03-audit-view-${mark}@ext.example','${hash(tokenView)}',jsonb_build_array('view'), now() + interval '7 days')`);
const otherProj = one(`select id from projects where id != '${proj}' and deleted_at is null limit 1`);
check(!!proj && !!invFull && !!otherProj, `シード完了 (proj ${proj.slice(0, 8)} / 招待 2 種 / 越境先 ${otherProj.slice(0, 8)})`);

// ── API 署名 (view+comment) ──
const signin = await api('POST', '/client/auth/signin', {
  invitation_token: tokenFull, display_name: `小松様-${mark}`,
  agree_legal: true, agree_confidential: true,
});
const jwt = signin.json?.data?.client_access_token;
check(signin.status === 200 && !!jwt, '① 招待 → client JWT 署名 (view+comment)');

// ── ⑦ R-T08 越境 (API): 別 project の全 content endpoint 403 ──
for (const p of ['overview', 'outputs', 'mocks', 'comments']) {
  const r = await api('GET', `/client/projects/${otherProj}/${p}`, undefined, jwt);
  check(r.status === 403, `⑦ R-T08 越境 403: GET /${p}`);
}
const crossPost = await api('POST', `/client/projects/${otherProj}/comments`, {
  target_type: 'workflow_output', target_id: outHear, content: '越境投稿',
}, jwt);
check(crossPost.status === 403, '⑦ R-T08 越境 403: POST /comments');
const otherTarget = one(`select id from workflow_outputs where project_id != '${proj}' and deleted_at is null limit 1`);
if (otherTarget) {
  const crossTarget = await api('POST', `/client/projects/${proj}/comments`, {
    target_type: 'workflow_output', target_id: otherTarget, content: '他projectのtargetへ',
  }, jwt);
  check(crossTarget.status === 404, '⑦ R-T08 他 project の target は存在ごと秘匿 (404)');
} else {
  check(true, '⑦ (他 project の成果物なし — target 越境は pytest で担保)');
}

// ── UI: cookie 設定 → ポータル実描画 ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await ctx.addCookies([{ name: 'atelier_client_access', value: jwt, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(`http://localhost:3100/client/s_l03?project=${proj}`, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: `L03監査-${mark}` }).waitFor({ state: 'visible', timeout: 20000 });

// ② バナー: 実 expires_at からの残日数
check((await page.getByText('リンク有効期限：残り 7 日').count()) === 1, '② リンク有効期限：残り 7 日 (実 expires_at)');
// ③ 工程進捗
const flow = page.getByRole('list', { name: '工程進捗' });
check(await flow.isVisible(), '③ 工程進捗バー描画');
check((await page.getByText('33%').count()) === 1, '③ 進捗 33% (completed 1/3 実計算)');
const wsName = one(`select name from workspaces where id='${ws}'`);
check((await page.getByText(`運営：${wsName}`, { exact: false }).count()) === 1, '③ 運営表示 (実 workspace 名)');
// ④ 成果物 (stage 毎最新版 + 実在フォーマット)
const outputsSec = page.getByRole('region', { name: '成果物' });
check((await outputsSec.getByText('ヒアリングサマリー').count()) === 1, '④ 成果物: ヒアリングサマリー (最新 v2 のみ)');
check((await outputsSec.getByText(/v2 · HTML$/).count()) === 1, '④ v2 は HTML のみ (実在フォーマット)');
check((await outputsSec.getByText('要件定義書').count()) === 1, '④ 要件定義書 v1 (MD)');
// ⑤ モック
const mocksSec = page.getByRole('region', { name: 'モック' });
check((await page.getByText('全 2 画面').count()) === 1, '⑤ 全 2 画面 (画面毎最新版の実カウント)');
check((await mocksSec.getByText('トップページ').count()) === 1, '⑤ トップページ (v2 最新のみ)');
check((await mocksSec.getByText(/^v2 ·/).count()) === 1, '⑤ トップページは v2 表示');
await page.screenshot({ path: `${SP}/l03c-${mark}-portal.png`, fullPage: true });

// ⑥ コメント投稿 → DB 突合 → 一覧反映
const form = page.getByRole('region', { name: 'コメントを投稿' });
await form.getByLabel('コメント対象').selectOption(`workflow_output:${outHear}`);
await form.getByLabel('コメント内容').fill(`L03監査-§2の内訳確認-${mark}`);
await form.getByRole('button', { name: 'コメントを投稿' }).click();
await page.getByText('コメントを投稿しました。運営側に共有されます。').waitFor({ state: 'visible', timeout: 15000 });
const cRow = one(`select id || '|' || (author_invitation_id = '${invFull}')::text || '|' || (author_user_id is null)::text from comments where content = 'L03監査-§2の内訳確認-${mark}'`);
const [commentId, byInv, noUser] = cRow.split('|');
check(byInv === 'true' && noUser === 'true', '⑥ コメントが author_invitation_id で DB 永続 (staff にならない)');
check(
  one(`select count(*) from audit_logs where action='client.comment.create' and target_id='${commentId}'`) === '1',
  '⑥ audit client.comment.create 記録',
);
const commentsSec = page.getByRole('region', { name: 'あなたのコメント' });
await commentsSec.getByText('あなたのコメント（1）').waitFor({ state: 'visible', timeout: 15000 });
check((await commentsSec.getByText(`L03監査-§2の内訳確認-${mark}`).count()) === 1, '⑥ 投稿が一覧に実反映 (invalidate)');

// ⑥ 運営返信 (見える) + 無関係社内メモ (見えない)
const staffUid = one("select id from users where email='design-audit@example.com'");
sql(`insert into comments (target_type, target_id, author_user_id, content, parent_comment_id) values ('workflow_output','${outHear}','${staffUid}','運営返信-${mark}','${commentId}')`);
sql(`insert into comments (target_type, target_id, author_user_id, content) values ('workflow_output','${outHear}','${staffUid}','社内メモ-${mark}')`);
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('region', { name: 'あなたのコメント' }).getByText(`運営返信-${mark}`).waitFor({ state: 'visible', timeout: 20000 });
check(true, '⑥ 自分のコメントへの運営返信は見える');
check((await page.getByText(`社内メモ-${mark}`).count()) === 0, '⑥ 無関係な社内コメントは見えない (最小開示)');
await page.screenshot({ path: `${SP}/l03c-${mark}-comments.png`, fullPage: true });

// ⑧ view-only 招待 → 投稿フォーム非表示 + 閲覧は可能
const signinView = await api('POST', '/client/auth/signin', {
  invitation_token: tokenView, agree_legal: true, agree_confidential: true,
});
const jwtView = signinView.json?.data?.client_access_token;
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await ctx2.addCookies([{ name: 'atelier_client_access', value: jwtView, domain: 'localhost', path: '/' }]);
const page2 = await ctx2.newPage();
await page2.goto(`http://localhost:3100/client/s_l03?project=${proj}`, { waitUntil: 'networkidle' });
await page2.getByRole('heading', { name: `L03監査-${mark}` }).waitFor({ state: 'visible', timeout: 20000 });
await page2.getByRole('region', { name: '成果物' }).waitFor({ state: 'visible', timeout: 15000 });
check((await page2.getByRole('region', { name: 'コメントを投稿' }).count()) === 0, '⑧ view-only は投稿フォーム非表示 (閲覧は可)');
await page2.screenshot({ path: `${SP}/l03c-${mark}-viewonly.png` });

await browser.close();
// 後片付け
sql(`delete from comments where target_id in (select id from workflow_outputs where project_id='${proj}')`);
sql("delete from audit_logs where action in ('client.signin','client.comment.create') and (target_id in (select id from client_invitations where email like 'l03-audit-%') or target_id = '" + commentId + "')");
sql(`delete from client_invitations where project_id='${proj}'`);
sql(`delete from workflow_outputs where project_id='${proj}'`);
sql(`delete from mocks where project_id='${proj}'`);
sql(`delete from phases where project_id='${proj}'`);
sql(`delete from projects where id='${proj}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shots: ${SP}/l03c-${mark}-*.png)`);
process.exit(failures === 0 ? 0 : 1);
