// Atelier 共通 AppShell ナビ — 全モックで単一の正準サイドバーを生成する。
// 使い方: <aside class="sidebar" data-appshell data-context="project" data-active="S-B04"
//            data-ws="ENGINE BASE" data-project="Atelier 自社開発"></aside>
//          <script src="../_shared/appshell.js"></script>
//
// context: "workspace"(WS全体画面) / "project"(プロジェクト配下) / "admin"(運営) 。
// data-active に現在画面の screen-id を入れると active ハイライトされる。
// これにより「画面ごとにサイドバーが変わる」UX崩れを構造的に防ぐ。

(function () {
  // 正準ナビ定義（ここが唯一の真実）
  const GLOBAL = [
    { id: 'S-B01', label: 'プロジェクト', icon: 'folder', href: '../project/S-B01-list.html' },
    { id: 'S-C01', label: 'AI社員', icon: 'users', href: '../employee/S-C01-org.html' },
    { id: 'S-K01', label: 'ナレッジ', icon: 'brain', href: '../knowledge/S-K01-explorer.html' },
    { id: 'S-J01', label: '承認待ち', icon: 'inbox', href: '../inbox/S-J01-list.html' },
    { id: 'S-A03', label: 'WS設定', icon: 'settings', href: '../workspace/S-A03-settings.html' },
  ];
  const PROJECT = [
    { id: 'S-B02', label: 'ダッシュボード', icon: 'layout-dashboard', href: '../project/S-B02-dashboard.html' },
    { id: 'S-F01', label: '工程', icon: 'workflow', href: '../workflow/S-F01-flow.html' },
    { id: 'S-I01', label: 'タスク', icon: 'kanban', href: '../task/S-I01-kanban.html' },
    { id: 'S-E01', label: 'チャット', icon: 'message-square', href: '../chat/S-E01-thread.html' },
    { id: 'S-M01', label: '議事録', icon: 'file-text', href: '../upload/S-M01-meeting.html' },
    { id: 'S-B04', label: 'シークレット', icon: 'key', href: '../project/S-B04-vault.html' },
    { id: 'S-B03', label: '設定', icon: 'settings', href: '../project/S-B03-settings.html' },
  ];
  const ADMIN = [
    { id: 'S-T01', label: 'ダッシュボード', icon: 'layout-dashboard', href: '../admin/S-T01-dashboard.html' },
    { id: 'S-T04', label: 'ユーザー', icon: 'users', href: '../admin/S-T04-users.html' },
    { id: 'S-T02', label: 'スキル', icon: 'sparkles', href: '../admin/S-T02-skills.html' },
    { id: 'S-T03', label: 'テンプレート', icon: 'bot', href: '../admin/S-T03-templates.html' },
    { id: 'S-T05', label: '監査ログ', icon: 'file-text', href: '../admin/S-T05-audit.html' },
  ];

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function navItem(item, active) {
    const cls = 'nav-item' + (item.id === active ? ' active' : '');
    const href = item.id === active ? '#' : item.href;
    return (
      '<a class="' + cls + '" href="' + href + '">' +
      '<i data-icon="' + item.icon + '"></i>' + esc(item.label) + '</a>'
    );
  }

  function section(label, items, active) {
    return (
      '<div class="nav-section">' +
      '<div class="nav-section-label">' + esc(label) + '</div>' +
      items.map((it) => navItem(it, active)).join('') +
      '</div>'
    );
  }

  function render(el) {
    const ctx = el.getAttribute('data-context') || 'workspace';
    const active = el.getAttribute('data-active') || '';
    const ws = el.getAttribute('data-ws') || 'ENGINE BASE';
    const project = el.getAttribute('data-project') || 'Atelier 自社開発';

    let html =
      '<div class="sidebar-brand"><div class="brand-mark">A</div><span class="brand-name">Atelier</span></div>';

    if (ctx === 'admin') {
      html += section('運営コンソール', ADMIN, active);
    } else {
      html += section('ワークスペース · ' + ws, GLOBAL, active);
      if (ctx === 'project') {
        html += section('プロジェクト · ' + project, PROJECT, active);
      }
    }
    el.innerHTML = html;
  }

  function boot() {
    document.querySelectorAll('aside.sidebar[data-appshell]').forEach(render);
    // icons.js が後で走るよう、appshell 描画後に再走を促す（icons.js は data-icon を SVG 化）。
    if (window.renderIcons) window.renderIcons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
