/**
 * 出力デザインテンプレート — GAP-158
 *
 * クライアントに見せる最終 HTML/PDF の「見た目の型」をワークスペース単位で作る。
 * 内容 (md/json の構成) はスキルが整える — ここは視覚デザインのみ。
 * Open Design 方式: ワンダに指示 → HTML → 大きいプレビュー → 指示で改訂 = 新版。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../providers/query-provider";
import { DesignTemplateStudio } from "./_components/DesignTemplateStudio";

export default function TemplatesPage() {
  return (
    <QueryProvider>
      <DesignTemplateStudio />
    </QueryProvider>
  );
}
