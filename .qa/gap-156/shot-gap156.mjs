/** GAP-156 e2e: 既存資料の一括取り込み → 自動仕分け結果 → 完了工程の確定反映。 */
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
const PROJ = "08cd08c5-4027-4ad6-8427-8a89145df648";
const DIR = process.env.DEMO_DIR;
const OUT = process.env.OUT ?? ".";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
await page.context().addCookies([
  { name: "atelier_access", value: mintJwt(USER), domain: "localhost", path: "/" },
]);
await page.goto(`http://localhost:3100/import?project=${PROJ}`, { waitUntil: "networkidle" });
await page.waitForSelector('section[aria-label="既存資料の取り込み"]', { timeout: 30000 });
await page.waitForTimeout(1500); // hydration 完了後に設定 (remount で消えないように)
await page.setInputFiles('input[aria-label="取り込むファイルを選択"]', [
  `${DIR}/requirements-notes.md`,
  `${DIR}/member-mypage.html`,
  `${DIR}/test-spec.html`,
  `${DIR}/old-logo.png`,
]);
const nFiles = await page.$eval('input[aria-label="取り込むファイルを選択"]', (el) => el.files?.length ?? -1);
console.log("INPUT_FILES:", nFiles);
console.log(
  "PICKED_TEXT:",
  await page.textContent("section[aria-label=\"既存資料の取り込み\"]").then((t) => t?.includes("件選択中")),
);
await page.getByRole("button", { name: "取り込む", exact: true }).click({ timeout: 15000 });
await page.waitForSelector("text=取り込み結果", { timeout: 30000 });
const summary = await page.$eval("h2", (e) => e.textContent);
console.log("RESULT:", summary);
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/gap156-results.png` });
// 提案チェック済みの工程を確定反映
const applyBtn = page.getByRole("button", { name: /工程を完了として反映/ });
console.log("APPLY_LABEL:", await applyBtn.textContent());
await applyBtn.click();
await page.waitForSelector('[role="status"]', { timeout: 30000 });
console.log("APPLIED:", await page.$eval('[role="status"]', (e) => e.textContent?.slice(0, 60)));
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/gap156-applied.png` });
// 進行タブで現在地を確認
await page.goto(`http://localhost:3100/chat?project=${PROJ}`, { waitUntil: "networkidle" });
await page.waitForSelector('section[aria-label="プロジェクト進行フロー"]', { timeout: 30000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/gap156-flow-after.png` });
await browser.close();
console.log("DONE");
