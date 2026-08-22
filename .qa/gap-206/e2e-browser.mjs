/**
 * GAP-206 実ブラウザ e2e (Playwright / Chromium)
 *
 * 見るもの:
 *   ① 旧版のままの利用者に **再同意の導線が実際に画面へ出る**
 *      (これまで導線が無く、GAP-188/204 で足した条項が旧版同意者に効きにくかった)
 *   ② 「同意する」で **画面が見せた版**が記録され、帯が消える
 *   ③ 強制しない — 「あとで」で閉じられ、同じ版では出ない
 *   ④ 503 の **理由がブラウザから読める** (CORS expose_headers)
 *      → 保存先の未設定を「パソコンを繋いでください」と誤案内しない
 *
 * どこで動くか: 画面 = SaaS クラウド (Vercel)、API/DB = SaaS クラウド。
 * ここでは全て手元の実サーバー (web :3100 / API :8123 / Postgres :54322)。
 */
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";

// @playwright/test は apps/web に入っている。ESM の import はこのファイルの場所から
// 解決されるため、実行時の作業ディレクトリ (apps/web) を基準に読み込む。
const require = createRequire(`${process.cwd()}/`);
const { chromium } = require("@playwright/test");

const WEB = process.env.WEB ?? "http://localhost:3100";
const API = process.env.API ?? "http://127.0.0.1:8123";
const SECRET = process.env.JWT_SECRET ?? "e2e-secret";
const USER = process.env.E2E_USER_ID;
const OUT = process.env.OUT ?? ".";
if (!USER) throw new Error("E2E_USER_ID が未設定です (wrapper から渡します)");

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
const check = (cond, m) => (cond ? ok(m) : ng(m));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([
  { name: "atelier_access", value: mintJwt(USER), domain: "localhost", path: "/" },
]);
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log(`     [browser console] ${m.text()}`);
});

console.log("[1] 旧版のままの利用者に **再同意の帯が出る**");
await page.goto(`${WEB}/projects`, { waitUntil: "domcontentloaded" });
const banner = page.getByRole("region", { name: "規約の更新のお知らせ" });
await banner.waitFor({ timeout: 20000 });
const bannerText = (await banner.innerText()).replace(/\s+/g, " ").trim();
console.log(`     帯の文言: ${bannerText}`);
check(bannerText.includes("利用規約"), "更新された規約の名前が出ている");
check(!bannerText.includes("プライバシーポリシー"), "同意済みのものは載せない (余計な不安を与えない)");
const readLink = page.getByRole("link", { name: "利用規約を読む" });
check((await readLink.getAttribute("href")) === "/terms", "本文を読むリンクがある");
await page.screenshot({ path: `${OUT}/gap206-banner.png` });

console.log("[2] 読むリンクが **本当に本文へ着く**");
await readLink.click();
await page.waitForURL("**/terms", { timeout: 20000 });
// 本文は正本 (DB) を API から取りに行くので、読み込み完了を待つ
await page.getByText("第1条", { exact: false }).first().waitFor({ timeout: 20000 });
const termsBody = await page.locator("body").innerText();
check(termsBody.includes("第9条"), "GAP-204 で足した条項 (第9条) が本文に載っている");
check(
  termsBody.includes("機械学習") || termsBody.includes("学習"),
  "機械学習への利用禁止の条項が読める",
);
await page.screenshot({ path: `${OUT}/gap206-terms.png`, fullPage: false });

console.log("[3] 「同意する」で記録され、帯が消える");
await page.goBack({ waitUntil: "domcontentloaded" });
await banner.waitFor({ timeout: 20000 });
const posted = [];
page.on("request", (r) => {
  if (r.url().includes("/me/consents") && r.method() === "POST") posted.push(r.postData());
});
await page.getByRole("button", { name: "同意する" }).click();
await banner.waitFor({ state: "detached", timeout: 20000 });
ok("同意したら帯が消えた");
console.log(`     送った内容: ${posted.join(" / ")}`);
check(posted.length === 1, `同意が要るものだけに送った (${posted.length} 回)`);
check(
  posted[0]?.includes("terms_of_service") && posted[0]?.includes("2026-08-21"),
  "**画面が見せた版**を指定して記録している",
);
await page.screenshot({ path: `${OUT}/gap206-after-accept.png` });

console.log("[4] 読み込み直しても出ない (記録が効いている)");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
check(!(await banner.isVisible().catch(() => false)), "再読み込みでも帯は出ない");

console.log("[5] 503 の **理由がブラウザから読める** (誤案内をやめる根拠)");
const probe = await page.evaluate(async (api) => {
  const res = await fetch(`${api}/auth/oauth/google/start`, { credentials: "include" });
  return {
    status: res.status,
    reason: res.headers.get("X-Atelier-Reason"),
    detail: (await res.json().catch(() => ({}))).detail ?? null,
  };
}, API);
console.log(`     実応答: ${JSON.stringify(probe)}`);
check(probe.status === 503, "503 が返っている");
check(probe.reason === "provider_disabled", `理由が読める (${probe.reason})`);
check(
  probe.reason !== "bridge_offline",
  "**未接続と決めつけない** — この 503 は PC の未接続ではない",
);
check(typeof probe.detail === "string" && probe.detail.length > 0, "本文にも理由が書かれている");

console.log("[6] 強制しない — 「あとで」で閉じられ、同じ版では出ない");
// 別の利用者 (まだ旧版のまま) で確かめる
const other = process.env.E2E_USER_ID_2;
if (!other) throw new Error("E2E_USER_ID_2 が未設定です");
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx2.addCookies([
  { name: "atelier_access", value: mintJwt(other), domain: "localhost", path: "/" },
]);
const page2 = await ctx2.newPage();
await page2.goto(`${WEB}/projects`, { waitUntil: "domcontentloaded" });
const banner2 = page2.getByRole("region", { name: "規約の更新のお知らせ" });
await banner2.waitFor({ timeout: 20000 });
ok("旧版のままの利用者には出ている");
await page2.getByRole("button", { name: "あとで" }).click();
await banner2.waitFor({ state: "detached", timeout: 10000 });
ok("「あとで」で閉じられる (同意しないと使えない、にはしない)");
await page2.reload({ waitUntil: "domcontentloaded" });
await page2.waitForTimeout(2500);
check(!(await banner2.isVisible().catch(() => false)), "同じ版なら再表示しない (しつこくしない)");
const stillPending = await page2.evaluate(async (api) => {
  const token = document.cookie.match(/atelier_access=([^;]+)/)[1];
  const res = await fetch(`${api}/me/consents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await res.json()).data.needs_consent;
}, API);
check(stillPending === true, "閉じただけで **同意したことにはしていない** (記録は増えない)");
await page2.screenshot({ path: `${OUT}/gap206-dismissed.png` });

await browser.close();
console.log("");
if (failures > 0) {
  console.log(`FAIL: ${failures} 件`);
  process.exit(1);
}
console.log("PASS: 再同意の導線が実ブラウザで機能し、503 の理由も画面から読める");
