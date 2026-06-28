// Atelier 共通 サイドパネル開閉ユーティリティ。
// 使い方:
//   <button data-pane-toggle="left"  data-pane-target=".knowledge-layout">…</button>
//   <button data-pane-toggle="right" data-pane-target=".knowledge-layout">…</button>
//   対象コンテナの CSS に .pane-left-collapsed / .pane-right-collapsed を定義しておく。
//
// クリックで対象コンテナに pane-<side>-collapsed クラスを付け外しし、
// グリッド列とパネル表示を CSS 側で切り替える。ボタンの aria-pressed も同期。

(function () {
  function toggle(btn) {
    const side = btn.getAttribute('data-pane-toggle'); // left | right
    const sel = btn.getAttribute('data-pane-target');
    const target = sel ? document.querySelector(sel) : null;
    if (!target || (side !== 'left' && side !== 'right')) return;
    const cls = 'pane-' + side + '-collapsed';
    const collapsed = target.classList.toggle(cls);
    // 同じ side を制御する全ボタンの状態を同期（開閉どちらのボタンも）
    document
      .querySelectorAll('[data-pane-toggle="' + side + '"][data-pane-target="' + sel + '"]')
      .forEach((b) => b.setAttribute('aria-pressed', String(collapsed)));
  }

  function boot() {
    document.querySelectorAll('[data-pane-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => toggle(btn));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
