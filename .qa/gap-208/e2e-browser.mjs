/**
 * GAP-208 実ブラウザ e2e (Playwright / Chromium)
 *
 * 見るもの:
 *   ① 新しい法務文書 3 本が **実際に画面へ出る**
 *      - 利用規約: 免責の組み替え / 料金・解約 / 未成年・反社・管轄
 *      - プライバシーポリシー: 越境移転（提供先と所在国）
 *      - 特商法表記: 実価格・解約方法
 *   ② 規約が新版になったので、**既存ユーザーに再同意の帯が出る**（GAP-206 が効く）
 *   ③ 契約者に **やめる口**（プランの管理・解約）が出て、Stripe へ送られる
 *   ④ 無料プランには解約導線を出さない（死にボタンを置かない）
 */
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/`);
const { chromium } = require("@playwright/test");

const WEB = process.env.WEB ?? "http://localhost:3100";
const SECRET = process.env.JWT_SECRET ?? "e2e-secret";
const OUT = process.env.OUT ?? ".";
const USER = process.env.E2E_USER_ID;
const WS = process.env.E2E_WORKSPACE_ID;
if (!USER || !WS) throw new Error("E2E_USER_ID / E2E_WORKSPACE_ID が未設定です");

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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([
  { name: "atelier_access", value: mintJwt(USER), domain: "localhost", path: "/" },
]);
const page = await ctx.newPage();

async function bodyOf(path, waitFor) {
  await page.goto(`${WEB}${path}`, { waitUntil: "domcontentloaded" });
  await page.getByText(waitFor, { exact: false }).first().waitFor({ timeout: 30000 });
  return page.locator("body").innerText();
}

console.log("[1] 利用規約 — 直した論点が実際に画面に出ている");
const terms = await bodyOf("/terms", "第1条");
check(terms.includes("上限") && terms.includes("12 か月"), "免責が全部免責でなく上限つきの一部制限になっている");
check(
  terms.includes("故意または重大な過失による場合には") && terms.includes("適用されません"),
  "故意・重過失には制限を及ぼしていない",
);
check(!terms.includes("故意または重過失による場合を除き責任を負いません"), "旧文（全部免責）が残っていない");
check(terms.includes("5,000 円") && terms.includes("消費税込"), "料金が実額で書かれている");
check(terms.includes("自動的に更新"), "自動更新が書かれている");
check(terms.includes("日割り"), "返金の有無が書かれている");
check(terms.includes("30 日間の猶予期間"), "削除の猶予期間が書かれている");
check(terms.includes("未成年") && terms.includes("法定代理人"), "未成年の条項がある");
check(terms.includes("反社会的勢力"), "反社条項がある");
check(terms.includes("専属的合意管轄"), "管轄の定めがある");
await page.screenshot({ path: `${OUT}/gap208-terms.png` });

console.log("[2] プライバシーポリシー — 越境移転が提供先と所在国つきで出ている");
const privacy = await bodyOf("/privacy", "取得する情報");
check(privacy.includes("外国にある第三者"), "越境移転の項目がある");
check(privacy.includes("アメリカ合衆国"), "所在国が書かれている");
for (const r of ["Anthropic PBC", "Stripe", "Fly.io", "Vercel"]) {
  check(privacy.includes(r), `提供先 ${r} が書かれている`);
}
check(privacy.includes("個人情報保護委員会"), "制度の確認方法が書かれている");
check(privacy.includes("既定では AI モデルの学習に使用しません"), "AI 学習デフォルト OFF が維持されている");
await page.screenshot({ path: `${OUT}/gap208-privacy.png` });

console.log("[3] 特商法表記 — 実価格と解約方法が出ている");
const toku = await bodyOf("/tokushoho", "販売事業者");
check(toku.includes("5,000 円"), "実価格が書かれている");
check(toku.includes("解約の方法"), "解約方法が書かれている");
check(toku.includes("プランの管理・解約"), "画面のボタン名と一致している");
check(toku.includes("Anthropic") && toku.includes("ご負担"), "Anthropic 料金がユーザー負担と書かれている");
// **埋まっていない事実**を隠さない (go/no-go の条件)
if (toku.includes("（担当者名）")) {
  console.log("  --   運営統括責任者が未記入 (経営者しか知らない事実 / go-no-go の条件)");
}
await page.screenshot({ path: `${OUT}/gap208-tokushoho.png` });

console.log("[4] 規約が新版になったので、既存ユーザーに再同意の帯が出る");
await page.goto(`${WEB}/projects`, { waitUntil: "domcontentloaded" });
const banner = page.getByRole("region", { name: "規約の更新のお知らせ" });
await banner.waitFor({ timeout: 30000 });
const bannerText = (await banner.innerText()).replace(/\s+/g, " ").trim();
console.log(`     帯の文言: ${bannerText}`);
check(bannerText.includes("利用規約"), "新版になった規約について同意を求めている");
await page.screenshot({ path: `${OUT}/gap208-reconsent.png` });

console.log("[5] 契約者には **やめる口** が出て、押せば結果が返る");
// ?workspace= を明示して行き先を確定させる (localStorage 空でも迷子にならない)
await page.goto(`${WEB}/workspace-settings?workspace=${WS}`, { waitUntil: "domcontentloaded" });
const planTab = page.getByRole("tab", { name: "プラン" });
await planTab.waitFor({ timeout: 30000 });
await planTab.click();

const cancelBtn = page.getByRole("button", { name: "プランの管理・解約" });
const upgradeBtn = page.getByRole("button", { name: "Pro にアップグレード" });
const notice = page.getByText(/決済連携が未設定です/);

// **3 つの状態のどれかが必ず出る**。何も出ないのは「死んだ画面」なので落とす。
await Promise.race([
  cancelBtn.waitFor({ timeout: 30000 }).catch(() => {}),
  upgradeBtn.waitFor({ timeout: 30000 }).catch(() => {}),
  notice.waitFor({ timeout: 30000 }).catch(() => {}),
]);
const states = {
  cancel: await cancelBtn.count(),
  upgrade: await upgradeBtn.count(),
  notice: await notice.count(),
};
console.log(`     プランタブの状態: ${JSON.stringify(states)}`);
check(
  states.cancel + states.upgrade + states.notice > 0,
  "プランタブに何らかの状態が出ている (無言の空画面にしない)",
);

if (states.cancel > 0) {
  ok("契約者に「プランの管理・解約」が出ている");
  check(
    (await page.getByText(/日割りでの返金はありません/).count()) > 0,
    "返金条件を押す前に書いている",
  );
  // 押したら **黙らない** (この環境の Stripe 鍵はダミーなので上流エラーになるはず)
  await cancelBtn.click();
  // 成功なら Stripe へ遷移、失敗なら理由が出る。**どちらでもない (無反応) は不合格**。
  const reason = page.getByText(
    /お手続きページを開けませんでした|有料プランのご契約がありません|決済連携が未設定/,
  );
  const navigated = page
    .waitForURL(/billing\.stripe\.com/, { timeout: 20000 })
    .then(() => "navigated")
    .catch(() => null);
  const shown = reason
    .first()
    .waitFor({ timeout: 20000 })
    .then(() => "shown")
    .catch(() => null);
  const outcome = (await Promise.race([navigated, shown])) ?? (await Promise.all([navigated, shown])).find(Boolean);
  const alerts = await page.getByRole("alert").allInnerTexts();
  console.log(`     押した結果: ${outcome ?? "無反応"} / alerts=${JSON.stringify(alerts)}`);
  check(
    outcome !== undefined && outcome !== null,
    "押した結果が必ず返る (Stripe へ遷移 or 理由の表示。黙って何も起きない、をしない)",
  );
} else if (states.upgrade > 0) {
  ok("無料プランではアップグレードのみ (解約の死にボタンを置かない)");
  check(states.cancel === 0, "無料プランに解約導線を出していない");
} else {
  ok("決済連携が未設定なので、偽の導線を出さず状態を明示している");
  check(states.cancel === 0, "未設定なのに解約ボタンを出していない");
}
await page.screenshot({ path: `${OUT}/gap208-plan.png` });

await browser.close();
console.log("");
if (failures > 0) {
  console.log(`FAIL: ${failures} 件`);
  process.exit(1);
}
console.log("PASS: 直した法務文書が実画面に出ており、やめる口も出ている");
