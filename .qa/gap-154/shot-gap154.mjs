/** GAP-154 e2e: WS設定 → 出力テンプレート (議事録) を UI から保存 → 設定済みバッジ。 */
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
const WS = "ffd0c431-54a6-4553-ae6a-edec74df64b1";
const OUT = process.env.OUT ?? ".";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.context().addCookies([
  { name: "atelier_access", value: mintJwt(USER), domain: "localhost", path: "/" },
]);
await page.addInitScript(
  ([ws]) => window.localStorage.setItem("atelier_current_workspace", ws),
  [WS],
);
await page.goto("http://localhost:3100/workspace-settings", { waitUntil: "networkidle" });
await page.waitForSelector('section[aria-label="出力テンプレート"]', { timeout: 30000 });
// 議事録の型を作成
await page.getByRole("tab", { name: "議事録・ヒアリングメモ" }).click();
await page.fill('input[placeholder*="標準見積"]', "社内標準 議事録");
await page.fill(
  "textarea",
  "## 出席者\n## 決定事項\n## 宿題（担当 / 期限）\n## 次回打合せ",
);
await page.screenshot({ path: `${OUT}/gap154-editor.png` });
await page.getByRole("button", { name: "保存" }).click();
await page.waitForSelector('[role="status"]', { timeout: 20000 });
console.log(
  "SAVE_NOTICE:",
  await page.$eval('[role="status"]', (e) => e.textContent?.slice(0, 80)),
);
await page.waitForTimeout(800);
const tab = await page.getByRole("tab", { name: /議事録/ }).textContent();
console.log("TAB_AFTER_SAVE:", tab);
await page.screenshot({ path: `${OUT}/gap154-saved.png` });
await browser.close();
console.log("DONE");
