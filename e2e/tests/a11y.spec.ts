/**
 * T-I-10 a11y axe-core 検査 (全 33 画面 + 横断 6 画面 WCAG 2.2 AA)。
 *
 * @axe-core/playwright で violation 数を 0 にする。screens.json の 33 画面 +
 * 横断機能 6 画面 (T-UC-35..40) の計 39 route を全網羅する。
 *
 * 違反 0 件を必達 (W3 T-US-13 + Bundle B/C/D で a11y 配線済)。
 * .github/workflows/a11y.yml で main push 時に実行 (CI 時間は許容)。
 */

import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';

/** screens.json の 33 画面 + 横断 6 画面 = 全 39 route。 */
const TARGETS: ReadonlyArray<{ name: string; path: string }> = [
  // A: 認証/WS
  { name: 'S-A01 サインイン/サインアップ', path: '/auth/s_a01' },
  { name: 'S-A03 ワークスペース設定', path: '/auth/s_a03' },
  // B: プロジェクト
  { name: 'S-B01 プロジェクト一覧', path: '/projects/s_b01' },
  { name: 'S-B02 ダッシュボード', path: '/projects/s_b02' },
  { name: 'S-B03 プロジェクト設定', path: '/projects/s_b03' },
  // C: AI 社員
  { name: 'S-C01 AI 社員組織図', path: '/employees/s_c01' },
  { name: 'S-C02 AI 社員詳細・編集', path: '/employees/s_c02' },
  // E: チャット
  { name: 'S-E01 チャット', path: '/chat/s_e01' },
  // F: ワークフロー
  { name: 'S-F01 工程ワークフロー', path: '/workflow/s_f01' },
  { name: 'S-F02 フェーズ管理', path: '/workflow/s_f02' },
  // G: 成果物
  { name: 'S-G01 成果物ビューア', path: '/outputs/s_g01' },
  // H: モック
  { name: 'S-H01 モックビューア', path: '/mocks/s_h01' },
  // I: タスク
  { name: 'S-I01 タスクボード', path: '/tasks/s_i01' },
  { name: 'S-I02 タスク詳細', path: '/tasks/s_i02' },
  { name: 'S-I03 実行モニター', path: '/tasks/s_i03' },
  // J: 承認
  { name: 'S-J01 承認待ち', path: '/approvals/s_j01' },
  // K: ナレッジ
  { name: 'S-K01 ナレッジエクスプローラ', path: '/knowledge/s_k01' },
  { name: 'S-K02 ナレッジ昇格レビュー', path: '/knowledge/s_k02' },
  // L: クライアント
  { name: 'S-L01 クライアント招待管理', path: '/client/s_l01' },
  { name: 'S-L02 クライアントサインイン', path: '/client/s_l02' },
  { name: 'S-L03 クライアントプロジェクトビュー', path: '/client/s_l03' },
  // M: 議事録
  { name: 'S-M01 議事録アップロード', path: '/upload/s_m01' },
  // N: 商談
  { name: 'S-N01 商談ドラフト', path: '/sales/s_n01' },
  // O: スケジュール
  { name: 'S-O01 自動スケジュール', path: '/cron/s_o01' },
  // PUB: 公開ページ
  { name: 'S-PUB01 利用規約', path: '/public/s_pub01' },
  { name: 'S-PUB02 プライバシーポリシー', path: '/public/s_pub02' },
  { name: 'S-PUB03 特商法表記', path: '/public/s_pub03' },
  { name: 'S-PUB04 データ削除請求', path: '/public/s_pub04' },
  // T: 運営 admin
  { name: 'S-T01 運営ダッシュボード', path: '/admin/s_t01' },
  { name: 'S-T02 スキル管理', path: '/admin/s_t02' },
  { name: 'S-T03 AI 社員テンプレ', path: '/admin/s_t03' },
  { name: 'S-T04 ユーザー管理', path: '/admin/s_t04' },
  { name: 'S-T05 監査ログ', path: '/admin/s_t05' },
  // 横断機能 (T-UC-35..40)
  { name: 'UC-35 オンボーディング', path: '/t-uc-35' },
  { name: 'UC-36 通知センター', path: '/t-uc-36' },
  { name: 'UC-37 ユーザープロフィール', path: '/t-uc-37' },
  { name: 'UC-38 WS 切替', path: '/t-uc-38' },
  { name: 'UC-39 プロジェクト切替', path: '/t-uc-39' },
  { name: 'UC-40 グローバル検索', path: '/t-uc-40' },
];

for (const t of TARGETS) {
  test(`T-I-10 a11y: ${t.name} は WCAG 2.2 AA 違反 0 件`, async ({ page }) => {
    await page.goto(t.path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
