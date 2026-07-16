/**
 * 意味的URL ↔ 実ルート(内部タスクID)のマッピング (F-VIS 段3: URLに内部IDを露出させない)。
 *
 * 実ディレクトリは Next.js App Router の都合で `s_b01` 等のタスクID命名のまま残すが、
 * ユーザーに見える URL は意味的パス(例 /projects)にする。next.config の rewrites で
 * 意味的URL→実ルートを serve、redirects で 実ルート→意味的URL に統一する。
 * アプリ内リンク・router.push は全て意味的URL(左辺)を使う。
 */
export const ROUTE_MAP: ReadonlyArray<readonly [clean: string, internal: string]> = [
  // projects
  ['/projects', '/projects/s_b01'],
  ['/projects/dashboard', '/projects/s_b02'],
  ['/projects/settings', '/projects/s_b03'],
  ['/projects/vault', '/projects/s_b04'],
  // chat
  ['/chat', '/chat/s_e01'],
  // tasks
  ['/tasks', '/tasks/s_i01'],
  ['/tasks/detail', '/tasks/s_i02'],
  ['/tasks/monitor', '/tasks/s_i03'],
  // employees
  ['/employees', '/employees/s_c01'],
  ['/employees/detail', '/employees/s_c02'],
  // workflow
  ['/workflow', '/workflow/s_f01'],
  ['/workflow/phases', '/workflow/s_f02'],
  // knowledge
  ['/knowledge', '/knowledge/s_k01'],
  ['/knowledge/review', '/knowledge/s_k02'],
  // approvals
  ['/approvals', '/approvals/s_j01'],
  // meetings (upload)
  ['/meetings', '/upload/s_m01'],
  // outputs / mocks / schedules / sales
  ['/outputs', '/outputs/s_g01'],
  ['/mocks', '/mocks/s_h01'],
  ['/schedules', '/cron/s_o01'],
  ['/sales', '/sales/s_n01'],
  // auth / workspace
  ['/signin', '/auth/s_a01'],
  ['/workspace-settings', '/auth/s_a03'],
  // admin
  ['/admin', '/admin/s_t01'],
  ['/admin/skills', '/admin/s_t02'],
  ['/admin/templates', '/admin/s_t03'],
  ['/admin/users', '/admin/s_t04'],
  ['/admin/audit', '/admin/s_t05'],
  ['/admin/platform-knowledge', '/admin/s_t06'],
  // client portal
  ['/portal/invitations', '/client/s_l01'],
  ['/portal/signin', '/client/s_l02'],
  ['/portal', '/client/s_l03'],
  // public legal
  ['/terms', '/public/s_pub01'],
  ['/privacy', '/public/s_pub02'],
  ['/tokushoho', '/public/s_pub03'],
  ['/data-deletion', '/public/s_pub04'],
] as const;
