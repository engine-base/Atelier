/** GAP-152 e2e: フェーズバー表示 → UI からフェーズ確定 → 凍結スナップショット閲覧。 */
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
const OUT = process.env.OUT ?? ".";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.context().addCookies([
  { name: "atelier_access", value: mintJwt(USER), domain: "localhost", path: "/" },
]);
await page.goto(`http://localhost:3100/chat?project=${PROJ}`, { waitUntil: "networkidle" });
await page.waitForSelector('section[aria-label="プロジェクト進行フロー"]', { timeout: 30000 });
await page.waitForSelector('[aria-label="フェーズ"]', { timeout: 15000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/gap152-phase-bar.png` });
console.log("PHASE_BAR: visible");

// フェーズ確定 (明示承認フロー)
await page.getByRole("button", { name: "フェーズを確定…" }).click();
const confirmText = await page.textContent('div:has(> div > button:text("確定して次フェーズへ"))').catch(() => null);
console.log("CONFIRM_PANEL:", confirmText ? confirmText.slice(0, 80) : "(shown)");
await page.screenshot({ path: `${OUT}/gap152-freeze-confirm.png` });
await page.getByRole("button", { name: "確定して次フェーズへ" }).click();
await page.waitForSelector('[role="status"]', { timeout: 20000 });
const notice = await page.$eval('[role="status"]', (e) => e.textContent);
console.log("FREEZE_NOTICE:", notice?.slice(0, 90));
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/gap152-after-freeze.png` });

// 凍結フェーズ1 のスナップショット閲覧 (読み取り専用)
await page.getByRole("button", { name: "フェーズ1を表示" }).click();
await page.waitForSelector('[role="note"]', { timeout: 15000 });
const banner = await page.$eval('[role="note"]', (e) => e.textContent);
console.log("FROZEN_BANNER:", banner?.slice(0, 110));
const completeButtons = await page.$$('button[aria-label$="を完了"]');
console.log("COMPLETE_BUTTONS_IN_FROZEN_VIEW:", completeButtons.length);
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/gap152-frozen-view.png` });
await browser.close();
console.log("DONE");
