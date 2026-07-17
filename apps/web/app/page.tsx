/**
 * ルート `/` — アプリの入口。
 *
 * 以前は "T-F-03 placeholder" の開発用スタブを表示しており、デプロイ環境で
 * トップにアクセスした利用者に未実装ページが出ていた。ここでログイン状態に応じて
 * アプリ本体へ振り分ける:
 *   - atelier_access cookie あり  → /projects (認証は middleware が最終検証)
 *   - なし                        → /signin
 * cookie の妥当性(期限切れ等)は各遷移先で middleware が検証するため、ここでは
 * 存在のみを見る。
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { COOKIE_NAMES } from "../lib/auth/cookie";

export default async function HomePage() {
  const token = (await cookies()).get(COOKIE_NAMES.access)?.value;
  redirect(token ? "/projects" : "/signin");
}
