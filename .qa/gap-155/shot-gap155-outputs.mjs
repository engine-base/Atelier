/** GAP-155 e2e: S-G01 で「前版との差分」モーダル + 旧版の「この版を復元」ボタンを撮る。 */
import { chromium } from "@playwright/test";
import { createHmac } from "node:crypto";

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
  const s = createHmac("sha256", "e2e-secret").update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

const USER = "42d41d69-c7f7-4269-87ff-ea98e887d09d";
const OUT_V2 = "a3c69490-486c-49e7-9177-4e70c7de2d4d"; // 御見積書（改訂版） v2
const OUT_V1 = "d0ecb163-9825-485a-8e09-c807065ecb83"; // 御見積書 v1 (旧版)
const OUT = process.env.OUT ?? ".";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.context().addCookies([
  { name: "atelier_access", value: mintJwt(USER), domain: "localhost", path: "/" },
]);
// v2 (改訂版) 表示 → 「前版との差分」
await page.goto(`http://localhost:3100/outputs?output=${OUT_V2}`, { waitUntil: "networkidle" });
const diffBtn = page.getByRole("button", { name: "v1 との差分" });
await diffBtn.waitFor({ timeout: 30000 });
await diffBtn.click();
await page.waitForSelector('[role="dialog"][aria-label="バージョン間差分"]', { timeout: 15000 });
await page.waitForTimeout(500);
console.log(
  "OUTPUT_DIFF_HEADER:",
  await page.$eval('[role="dialog"][aria-label="バージョン間差分"] h2', (e) => e.textContent),
);
await page.screenshot({ path: `${OUT}/gap155-output-diff.png` });
// 旧版 v1 表示 → 「この版を復元」が出る
await page.goto(`http://localhost:3100/outputs?output=${OUT_V1}`, { waitUntil: "networkidle" });
const restoreBtn = page.getByRole("button", { name: "この版を復元" });
await restoreBtn.waitFor({ timeout: 30000 });
console.log("RESTORE_BUTTON_VISIBLE: true");
await page.screenshot({ path: `${OUT}/gap155-output-restore-btn.png` });
await browser.close();
console.log("DONE");
