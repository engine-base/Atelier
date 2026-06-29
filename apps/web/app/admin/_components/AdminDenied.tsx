/**
 * AdminDenied — 運営管理者専用画面の 403 拒否状態 (T-UC-42)
 *
 * admin API が 403 を返した際、管理 UI の代わりに表示する。
 * S-T02 / S-T06 双方で共有する (admin gate / AC tier2 critical)。
 */

'use client';

import * as React from 'react';

export function AdminDenied() {
  return (
    <div
      role="alert"
      className="mx-auto mt-lg max-w-xl rounded-lg border border-error bg-surface p-lg text-center"
    >
      <h2 className="text-headline-md font-bold text-error">アクセス権限がありません</h2>
      <p className="mt-sm text-body-md text-on-surface-variant">運営管理者専用の画面です。</p>
    </div>
  );
}
