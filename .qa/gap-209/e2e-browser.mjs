/**
 * GAP-209 実ブラウザ e2e (Playwright / Chromium)
 *
 * 見るもの:
 *   ① **帰れない画面をなくした** — 通知センター / プロフィール / WS 切替 /
 *      PJ 切替 / 検索 (t-uc-36〜40) にシェル (ナビ + ヘッダー) が付いている。
 *      これまでは丸ごと bare で、押して飛んだ先に戻る導線が無く、
 *      **ブラウザの戻るでしか帰れなかった**。
 *   ② 初回ウォークスルー (t-uc-35) は **意図して素のまま**（全部にシェルを
 *      付けたのではないことを見る）。
 *   ③ **出る口がある** — アバターがメニューになり、サインアウトが出る。
 *   ④ **出る口が本当に効く** — 押すと
 *        - サーバー側で refresh token が失効する（盗まれても使えない）
 *        - cookie が消える
 *        - localStorage の「前の人の文脈」も消える
 *        - サインイン画面に着地する
 */
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/`);
const { chromium } = require("@playwright/test");

const WEB = process.env.WEB ?? "http://localhost:3100";
const API = process.env.API ?? "http://127.0.0.1:8123";
const SECRET = process.env.JWT_SECRET ?? "e2e-secret";
const OUT = process.env.OUT ?? ".";
const USER = process.env.E2E_USER_ID;
const WS = process.env.E2E_WORKSPACE_ID;
const REFRESH_BEFORE = process.env.E2E_REFRESH_BEFORE;
const REFRESH_AFTER = process.env.E2E_REFRESH_AFTER;
if (!USER || !WS || !REFRESH_BEFORE || !REFRESH_AFTER) {
  throw new Error("E2E_USER_ID / E2E_WORKSPACE_ID / E2E_REFRESH_BEFORE / E2E_REFRESH_AFTER が未設定です");
}

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

const refreshStatus = async (token) => {
  const res = await fetch(`${API}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: token }),
  });
  return res.status;
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([
  { name: "atelier_access", value: mintJwt(USER), domain: "localhost", path: "/" },
]);
const page = await ctx.newPage();

// --------------------------------------------------------------------------- //
console.log("[0] 土台 — サインアウト前は refresh が通る");
// --------------------------------------------------------------------------- //
{
  const st = await refreshStatus(REFRESH_BEFORE);
  console.log(`     POST /auth/refresh (before) -> ${st}`);
  check(st === 200, "失効させる前は refresh が 200 で通る (この後の 401 が意味を持つ)");
}

// --------------------------------------------------------------------------- //
console.log("");
console.log("[1] 帰れない画面をなくした — t-uc-36〜40 にシェルが付いている");
// --------------------------------------------------------------------------- //
const SHELLED = [
  ["/t-uc-36", "通知センター"],
  ["/t-uc-37", "プロフィール"],
  ["/t-uc-38", "ワークスペース切替"],
  ["/t-uc-39", "プロジェクト切替"],
  ["/t-uc-40", "検索"],
];
/** 見えるまで待つ。isVisible() は待たない即時判定なので使わない
 *  (最初はそれで書いて、まだ hydrate していない画面を「無い」と誤判定した)。 */
const visible = (loc, timeout = 20000) =>
  loc
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);

for (const [path, name] of SHELLED) {
  await page.goto(`${WEB}${path}?workspace=${WS}`, { waitUntil: "domcontentloaded" });
  const nav = page.getByRole("navigation", { name: "ホーム" }).first();
  const avatar = page.getByRole("button", { name: /^アカウント: / }).first();
  check(await visible(nav), `${path} (${name}) にナビがある — ブラウザの戻る以外で帰れる`);
  check(await visible(avatar), `${path} (${name}) にアカウントメニューがある`);
}
await page.screenshot({ path: `${OUT}/gap209-shelled.png` });

// --------------------------------------------------------------------------- //
console.log("");
console.log("[2] 初回ウォークスルー (t-uc-35) は意図して素のまま");
// --------------------------------------------------------------------------- //
{
  await page.goto(`${WEB}/t-uc-35`, { waitUntil: "domcontentloaded" });
  // 「画面が出ていないから nav も無い」という空振りの合格を作らないため、
  // まずウォークスルー本体が描かれていることを確かめる。
  check(
    await visible(page.getByText("ようこそ Atelier へ").first()),
    "t-uc-35 のウォークスルーが実際に出ている (空の画面で判定していない)",
  );
  const navCount = await page.getByRole("navigation", { name: "ホーム" }).count();
  check(navCount === 0, "t-uc-35 にはナビを出していない (全部に付けたのではない)");
  await page.screenshot({ path: `${OUT}/gap209-walkthrough.png` });
}

// --------------------------------------------------------------------------- //
console.log("");
console.log("[3] 出る口がある — アバターがメニューになった");
// --------------------------------------------------------------------------- //
await page.goto(`${WEB}/t-uc-37?workspace=${WS}`, { waitUntil: "domcontentloaded" });
const avatar = page.getByRole("button", { name: /^アカウント: / }).first();
await avatar.waitFor({ timeout: 30000 });
await avatar.click();
const menu = page.getByRole("menu", { name: "アカウントメニュー" });
check(await menu.isVisible({ timeout: 10000 }).catch(() => false), "アバターを押すとメニューが開く");
const signOutBtn = page.getByRole("menuitem", { name: "サインアウト" });
check(
  await signOutBtn.isVisible({ timeout: 10000 }).catch(() => false),
  "メニューに **サインアウト** がある (これまでアプリ本体に出る口が無かった)",
);
check(
  await page.getByRole("menuitem", { name: "プロフィール" }).isVisible().catch(() => false),
  "プロフィールへの導線も残っている (置き換えで機能を減らしていない)",
);
await page.screenshot({ path: `${OUT}/gap209-menu.png` });

// --------------------------------------------------------------------------- //
console.log("");
console.log("[4] 出る口が本当に効く — 押した後に何が消えるか");
// --------------------------------------------------------------------------- //
// 「前の人の文脈」を実際に置いてから押す
await page.evaluate(() => {
  window.localStorage.setItem("atelier_current_workspace", "前の人のワークスペース");
  window.localStorage.setItem("atelier_current_project", "前の人のプロジェクト");
});
await signOutBtn.click();

const landed = await page
  .waitForURL(/\/signin(\?|$)/, { timeout: 30000 })
  .then(() => true)
  .catch(() => false);
check(landed, "押すとサインイン画面に着地する (押して黙る、をしない)");
console.log(`     着地 URL: ${page.url()}`);

const cookies = await ctx.cookies();
const access = cookies.find((c) => c.name === "atelier_access");
check(!access || !access.value, "cookie (atelier_access) が消えている");

const leftovers = await page.evaluate(() => ({
  ws: window.localStorage.getItem("atelier_current_workspace"),
  pj: window.localStorage.getItem("atelier_current_project"),
}));
console.log(`     localStorage 残り: ${JSON.stringify(leftovers)}`);
check(
  leftovers.ws === null && leftovers.pj === null,
  "localStorage の前の人の文脈も消えている (共有 PC で次の人に見せない)",
);

{
  const st = await refreshStatus(REFRESH_AFTER);
  console.log(`     POST /auth/refresh (after) -> ${st}`);
  check(
    st === 401,
    "**サインアウト後は refresh token が通らない** (盗まれた token が生き続けない)",
  );
}
await page.screenshot({ path: `${OUT}/gap209-after-signout.png` });

// --------------------------------------------------------------------------- //
console.log("");
console.log("[5] 出た後に中へ戻れないこと (cookie を捨てただけで終わっていない)");
// --------------------------------------------------------------------------- //
{
  await page.goto(`${WEB}/t-uc-37`, { waitUntil: "domcontentloaded" });
  const redirected = await page
    .waitForURL(/\/signin(\?|$)/, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check(redirected, "サインアウト後に画面を直接開いてもサインインへ戻される");
}

await browser.close();
console.log("");
if (failures > 0) {
  console.log(`FAIL: ${failures} 件`);
  process.exit(1);
}
console.log("PASS: 帰れない画面が無くなり、出る口が本当に効いている");
