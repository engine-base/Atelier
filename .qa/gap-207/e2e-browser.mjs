/**
 * GAP-207 実ブラウザ e2e (Playwright / Chromium)
 *
 * 経営者指摘:
 *   「オンボーディングやその他でサイドバーいらないときは表示させなくていいよね？
 *     その時押されても困るしUX悪いし」
 *
 * これまでの実態:
 *   新規登録直後（ワークスペースがまだ 1 つも無い）でも、サイドバーに
 *   「プロジェクト / AI社員 / ナレッジ / テンプレート / 承認待ち / WS設定」の
 *   6 本を出していた。**どれもワークスペースが無いと空か作れない画面**なので、
 *   押しても何も起きない。TopBar にも中身の無いワークスペースピルが出ていた。
 *
 * 見るもの:
 *   ① ワークスペースが無い間は nav・ピル・検索・通知を出さない（本文は出る）
 *   ② ワークスペースを 1 つ作ったら、その場で従来どおり出る
 *   ③ 既存ユーザー（ワークスペースあり）では今までどおり
 */
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/`);
const { chromium } = require("@playwright/test");

const WEB = process.env.WEB ?? "http://localhost:3100";
const SECRET = process.env.JWT_SECRET ?? "e2e-secret";
const OUT = process.env.OUT ?? ".";
const NEW_USER = process.env.E2E_USER_NEW;
const OLD_USER = process.env.E2E_USER_WITH_WS;
if (!NEW_USER || !OLD_USER) throw new Error("E2E_USER_NEW / E2E_USER_WITH_WS が未設定です");

const b64url = (b) => Buffer.from(b).toString("base64url");
function mintJwt(userId) {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(
    JSON.stringify({
      sub: userId,
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  const s = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

let failures = 0;
const ok = (m) => console.log(`  OK   ${m}`);
const ng = (m) => {
  console.log(`  NG   ${m}`);
  failures += 1;
};
const check = (c, m) => (c ? ok(m) : ng(m));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

async function openAs(userId) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([
    { name: "atelier_access", value: mintJwt(userId), domain: "localhost", path: "/" },
  ]);
  const page = await ctx.newPage();
  return { ctx, page };
}

const NAV = ["プロジェクト", "AI社員", "ナレッジ", "テンプレート", "承認待ち", "WS設定"];

console.log("[1] ワークスペースが無い人: 押しても何もできない nav を出さない");
const a = await openAs(NEW_USER);
await a.page.goto(`${WEB}/projects`, { waitUntil: "domcontentloaded" });
// オンボーディング本文が出るまで待つ
await a.page.getByText("最初のワークスペースを作成").waitFor({ timeout: 30000 });
ok("ワークスペース作成のオンボーディングが出ている");
for (const label of NAV) {
  const n = await a.page.getByRole("link", { name: label, exact: true }).count();
  check(n === 0, `サイドバーの「${label}」を出していない`);
}
check(
  (await a.page.locator('[aria-label^="ワークスペース: "]').count()) === 0,
  "中身の無いワークスペースピルを出していない",
);
check(
  (await a.page.getByRole("link", { name: "検索" }).count()) === 0,
  "検索を出していない（探すものがまだ無い）",
);
check(
  (await a.page.getByRole("link", { name: /通知センター/ }).count()) === 0,
  "通知センターを出していない（承認するものがまだ無い）",
);
check(
  (await a.page.locator('header[role="banner"] img[src*="logo-lockup"]').count()) > 0,
  "ヘッダーが空にならないようロゴは残っている",
);
await a.page.screenshot({ path: `${OUT}/gap207-onboarding.png` });

console.log("[2] ワークスペースを作ったら、その場で出る");
await a.page.getByPlaceholder("例：ENGINE BASE").fill("E2E ワークスペース");
await a.page.getByRole("button", { name: "ワークスペースを作成" }).click();
await a.page.getByRole("link", { name: "AI社員", exact: true }).waitFor({ timeout: 30000 });
ok("作成した直後にサイドバーが出た（再読み込み不要）");
check(
  (await a.page.locator('[aria-label^="ワークスペース: "]').count()) > 0,
  "ワークスペースピルも出た",
);
check(
  (await a.page.getByRole("link", { name: "検索" }).count()) > 0,
  "検索も戻った",
);
await a.page.screenshot({ path: `${OUT}/gap207-after-create.png` });
await a.ctx.close();

console.log("[3] 既存ユーザー（ワークスペースあり）は今までどおり");
const b = await openAs(OLD_USER);
await b.page.goto(`${WEB}/projects`, { waitUntil: "domcontentloaded" });
await b.page.getByRole("link", { name: "AI社員", exact: true }).waitFor({ timeout: 30000 });
for (const label of NAV) {
  const n = await b.page.getByRole("link", { name: label, exact: true }).count();
  check(n > 0, `「${label}」が出ている`);
}
await b.page.screenshot({ path: `${OUT}/gap207-existing-user.png` });
await b.ctx.close();

await browser.close();
console.log("");
if (failures > 0) {
  console.log(`FAIL: ${failures} 件`);
  process.exit(1);
}
console.log("PASS: 使えないときは出さない / 使えるようになったら出る");
