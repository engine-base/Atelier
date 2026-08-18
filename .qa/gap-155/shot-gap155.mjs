/** GAP-155 e2e: スタジオで旧版の「差分」→ unified diff モーダルの実表示を撮る。 */
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
const MOCK_V4 = "bd800ca7-4a86-457e-81ca-84ae09579bd0"; // 料金ページ v4
const OUT = process.env.OUT ?? ".";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.context().addCookies([
  { name: "atelier_access", value: mintJwt(USER), domain: "localhost", path: "/" },
]);
await page.goto(`http://localhost:3100/mocks?mock=${MOCK_V4}`, { waitUntil: "networkidle" });
await page.waitForSelector('section[aria-label="モックスタジオ"]', { timeout: 30000 });
// v3 行の「差分」ボタン (v3 と表示中 v4 の比較)
const diffBtn = page.getByRole("button", { name: "v3 と表示中バージョンの差分" });
await diffBtn.waitFor({ timeout: 15000 });
await diffBtn.click();
await page.waitForSelector('[role="dialog"][aria-label="バージョン間差分"]', { timeout: 15000 });
await page.waitForTimeout(600);
const header = await page.$eval('[role="dialog"][aria-label="バージョン間差分"] h2', (e) => e.textContent);
console.log("DIFF_MODAL_HEADER:", header);
const body = await page.$eval('pre[aria-label="差分本文"]', (e) => e.textContent.slice(0, 200));
console.log("DIFF_BODY_HEAD:", body.replace(/\n/g, "\\n"));
await page.screenshot({ path: `${OUT}/gap155-diff-modal.png` });
await page.getByRole("button", { name: "差分を閉じる" }).click();
await page.screenshot({ path: `${OUT}/gap155-studio-after-close.png` });
await browser.close();
console.log("DONE");
