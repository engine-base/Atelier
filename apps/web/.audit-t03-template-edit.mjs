/**
 * GAP-031⑤ 実操作監査 (S-T03 テンプレ編集 — T-A-42 scope expand)
 *
 * 検証: ① 一覧 + エディタ 2 ペイン (実 DB テンプレ) ② 基本情報/専門領域の編集 →
 * 「保存して全 WS 反映」→ DB 突合 (部分更新 + version 自動 increment) ③ スキル追加
 * (実 /admin/skills 由来の候補) → default_skills uuid[] DB 突合 ④ カテゴリ追加/削除
 * → text[] DB 突合 ⑤ 実展開先 (ai_employees.template_id 実カウント) 表示 ⑥ audit
 * template.update 証跡 ⑦ 変更なし保存は honest ブロック。
 * seed したテンプレ/社員のみ操作し、終了時に削除 (再実行可能・実テンプレ不変)。
 */
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const SP = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const sql = (q) =>
  execSync(`PGPASSWORD=devpass psql -h localhost -U atelier_dev -d atelier_dev -tAc "${q.replaceAll('"', '\\"')}"`, {
    encoding: 'utf8',
  }).trim();
const one = (q) => sql(q).split('\n')[0].trim();

const mark = Math.random().toString(36).slice(2, 7);
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

// 前回残留掃除
sql("delete from audit_logs where action='template.update' and target_id in (select id from ai_employee_templates where default_name like 't03audit-%')");
sql("delete from ai_employees where name like 't03audit-emp-%'");
sql("delete from ai_employee_templates where default_name like 't03audit-%'");

// seed: 監査専用テンプレ (実テンプレを汚さない) + 参照社員 2 名 (別 WS) + archived 1 名
const tpl = one(
  `insert into ai_employee_templates (default_name, default_display_name, department, role, system_prompt, specialty, default_knowledge_cats, version) values ('t03audit-${mark}','T03監査テンプレ-${mark}','sales','member','あなたは監査用テンプレです。','監査前スペシャリティ', array['監査カテゴリA']::text[], 1) returning id`,
);
const wsRows = sql('select id from workspaces where deleted_at is null limit 2').split('\n');
const [ws1, ws2] = [wsRows[0]?.trim(), (wsRows[1] ?? wsRows[0])?.trim()];
sql(
  `insert into ai_employees (workspace_id, template_id, name, display_name, role, department) values ('${ws1}','${tpl}','t03audit-emp-a-${mark}','監査社員A','member','sales'), ('${ws2}','${tpl}','t03audit-emp-b-${mark}','監査社員B','member','sales')`,
);
sql(
  `insert into ai_employees (workspace_id, template_id, name, display_name, role, department, archived) values ('${ws1}','${tpl}','t03audit-emp-c-${mark}','監査社員C(退役)','member','sales', true)`,
);
const expectedWs = one(
  `select count(distinct workspace_id) from ai_employees where template_id='${tpl}' and archived=false`,
);
check(!!tpl, `シード完了 (tpl ${tpl.slice(0, 8)} / 現役社員 2 名 + archived 1 名 / ${expectedWs} WS)`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });

await page.goto('http://localhost:3100/admin/s_t03', { waitUntil: 'networkidle' });

// ① 一覧 + エディタ 2 ペイン
const dbCount = one('select count(*) from ai_employee_templates');
await page.getByText(`${dbCount} 名のテンプレ`).waitFor({ state: 'visible', timeout: 20000 });
check(true, `① 一覧が実 DB 件数 (${dbCount} 件 — seed 込み)`);
await page.getByRole('button', { name: `T03監査テンプレ-${mark}` }).click();
const editor = page.getByRole('region', { name: `テンプレ編集: T03監査テンプレ-${mark}` });
await editor.waitFor({ state: 'visible', timeout: 15000 });
check((await editor.getByText(`t03audit-${mark}`).count()) === 1, '① 内部名 (変更不可) を実表示');
check((await editor.getByText('v1').count()) >= 1, '① 現 version v1 表示');

// ⑤ 実展開先 (ai_employees.template_id 実カウント — archived は数えない)
await editor.getByText(`展開先：${expectedWs} WS（自動同期）`).waitFor({ state: 'visible', timeout: 15000 });
check(true, `⑤ 展開先：${expectedWs} WS (DB 実カウント一致)`);
check(
  (await editor.getByText(new RegExp(`${expectedWs} ワークスペースの 2 体に次回利用時から適用`)).count()) === 1,
  '⑤ 注意文も実カウント (現役 2 体 — archived 除外)',
);
await page.screenshot({ path: `${SP}/t03-${mark}-editor.png` });

// ⑦ 変更なし保存は honest ブロック (API を呼ばず client-side で明示)
await editor.getByRole('button', { name: '保存して全 WS 反映' }).click();
await editor.getByText('変更がありません。').waitFor({ state: 'visible', timeout: 10000 });
check(
  one(`select version from ai_employee_templates where id='${tpl}'`) === '1',
  '⑦ 変更なし保存はブロック (version 不変)',
);

// ② 基本情報 + 専門領域を編集 → 保存 → DB 突合 (部分更新 + version increment)
await editor.getByLabel('デフォルト表示名').fill(`T03監査テンプレ-${mark}改`);
await editor.getByLabel('役職').selectOption('lead');
await editor.getByLabel(/専門領域（specialty）/).fill(`監査後スペシャリティ-${mark}`);

// ③ スキル追加 (実 /admin/skills 由来の候補から先頭を装着)
const skillSelect = editor.getByLabel('追加するスキル');
const optionValues = await skillSelect.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
check(optionValues.length >= 1, `③ スキル候補が実スキル (${optionValues.length} 件)`);
const chosenSkill = optionValues[0];
await skillSelect.selectOption(chosenSkill);
await editor.getByRole('button', { name: 'スキル追加' }).click();

// ④ カテゴリ削除 + 追加
await editor.getByRole('button', { name: 'カテゴリ 監査カテゴリA を外す' }).click();
await editor.getByLabel('追加するカテゴリ名').fill(`監査カテゴリB-${mark}`);
await editor.getByRole('button', { name: 'カテゴリ追加' }).click();

await editor.getByRole('button', { name: '保存して全 WS 反映' }).click();
await page.getByText(/テンプレを保存しました（v2 — 全 WS の参照社員に次回利用時から反映）/).waitFor({ state: 'visible', timeout: 15000 });
const row = one(
  `select default_display_name||'|'||role||'|'||specialty||'|'||version||'|'||department||'|'||array_to_string(default_skills,',')||'|'||array_to_string(default_knowledge_cats,',') from ai_employee_templates where id='${tpl}'`,
);
check(
  row === `T03監査テンプレ-${mark}改|lead|監査後スペシャリティ-${mark}|2|sales|${chosenSkill}|監査カテゴリB-${mark}`,
  '②③④ DB 突合: 部分更新 (department 不変) + version 1→2 + uuid[] スキル + text[] カテゴリ',
);
await page.screenshot({ path: `${SP}/t03-${mark}-saved.png` });

// 保存後はサーバー再取得値でエディタが再構成される (v2 表示)
await editor.getByText('v2', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
check(true, '② 保存後に v2 を実表示 (invalidate → 再取得)');

// ② 2 回目の保存でさらに increment (保存のたびに版が上がる)
await editor.getByLabel(/専門領域（specialty）/).fill(`監査後スペシャリティ-${mark}-v3`);
await editor.getByRole('button', { name: '保存して全 WS 反映' }).click();
await page.getByText(/テンプレを保存しました（v3 /).waitFor({ state: 'visible', timeout: 15000 });
check(
  one(`select version from ai_employee_templates where id='${tpl}'`) === '3',
  '② 2 回目保存で version 2→3 (自動 increment)',
);

// ⑥ audit 証跡 (template.update × 2、変更フィールド記録)
check(
  one(`select count(*) from audit_logs where action='template.update' and target_id='${tpl}'`) === '2',
  '⑥ audit template.update が 2 件 (保存回数と一致)',
);
check(
  one(
    `select after->>'version' from audit_logs where action='template.update' and target_id='${tpl}' order by created_at desc limit 1`,
  ) === '3',
  '⑥ audit.after に新 version 記録',
);
await page.screenshot({ path: `${SP}/t03-${mark}-final.png` });

await browser.close();
sql(`delete from audit_logs where action='template.update' and target_id='${tpl}'`);
sql("delete from ai_employees where name like 't03audit-emp-%'");
sql(`delete from ai_employee_templates where id='${tpl}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shots: ${SP}/t03-${mark}-*.png)`);
process.exit(failures === 0 ? 0 : 1);
