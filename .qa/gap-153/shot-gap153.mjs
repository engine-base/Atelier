/** GAP-153 e2e: 運営 S-T06 のキュレーション承認キュー → 承認 → セキュリティ除外タブ。 */
import { chromium } from "@playwright/test";
import { createHmac } from "node:crypto";

const b64url = (b) => Buffer.from(b).toString("base64url");
function mintAdminJwt(userId) {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(
    JSON.stringify({
      sub: userId,
      role: "authenticated",
      aud: "authenticated",
      app_metadata: { role: "admin" },
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  const s = createHmac("sha256", "e2e-secret").update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

const USER = "42d41d69-c7f7-4269-87ff-ea98e887d09d";
const OUT = process.env.OUT ?? ".";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
await page.context().addCookies([
  { name: "atelier_access", value: mintAdminJwt(USER), domain: "localhost", path: "/" },
]);
await page.goto("http://localhost:3100/admin/s_t06", { waitUntil: "networkidle" });
await page.waitForSelector('section[aria-label="ナレッジ自動キュレーション"]', {
  timeout: 30000,
});
await page.waitForSelector('text=[一般化] 見積レビューの観点', { timeout: 15000 });
// 匿名化済み本文を開いて撮影
await page.click("summary:has-text('匿名化済み本文を確認')");
await page.waitForTimeout(400);
const sec = page.locator('section[aria-label="ナレッジ自動キュレーション"]');
await sec.screenshot({ path: `${OUT}/gap153-queue.png` });

// 承認 → platform ナレッジとして公開
await page.getByRole("button", { name: "承認して全アカウント共有" }).click();
await page.waitForSelector('[role="status"]', { timeout: 20000 });
console.log(
  "APPROVE_NOTICE:",
  await page.$eval('[role="status"]', (e) => e.textContent?.slice(0, 70)),
);
await page.waitForTimeout(600);
await sec.screenshot({ path: `${OUT}/gap153-approved.png` });

// セキュリティ除外タブ (リークスキャンの検出内容)
await page.getByRole("tab", { name: "セキュリティ除外" }).click();
await page.waitForSelector("text=リークスキャン:", { timeout: 15000 });
console.log(
  "SECURITY_TAB:",
  await page.$eval("li", (e) => e.textContent?.slice(0, 120)),
);
await page.waitForTimeout(400);
await sec.screenshot({ path: `${OUT}/gap153-security.png` });
await browser.close();
console.log("DONE");
