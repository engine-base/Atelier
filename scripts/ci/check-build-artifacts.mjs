#!/usr/bin/env node
/**
 * ビルド成果物検査 (T-F-46 / GAP-114)。
 *
 * **なぜソース検査では足りないのか**
 * 動的 import に `webpackIgnore` magic comment や変数 specifier を使うと、
 * バンドラが解決を諦めてブラウザに素の `import("<pkg>")` が残る。
 * bare specifier はブラウザが解決できないため必ず throw し、依存が入っていても
 * その経路は永久に動かない (T-F-42 で実際に踏んだ)。
 * ソース側の grep は変数 specifier 形を原理的に検出できず、vitest は bare specifier を
 * 解決できてしまうため、**判定は本番ビルド成果物でしか下せない**。
 *
 * **なぜ .next 不在を失敗にするのか**
 * 「検査対象が無い = 合格」にすると、ビルド前に走らせただけで恒久的に素通りする。
 * 実際、この検査を vitest に置いていたときは CI がビルド前に vitest を回すため
 * 常に warning 素通りだった (= 実質 skip)。対象が無いことは合格ではなく設定ミス。
 *
 * usage:
 *   node scripts/ci/check-build-artifacts.mjs [--dir apps/web/.next/static/chunks]
 * exit:
 *   0 = 違反 0 件 / 1 = 違反あり or 検査対象が無い
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import process from 'node:process';

/** 成果物に残っていてはいけない bare specifier。 */
const FORBIDDEN_SPECIFIERS = ['@sentry/nextjs'];

const DEFAULT_DIR = 'apps/web/.next/static/chunks';

function parseArgs(argv) {
  const dirIndex = argv.indexOf('--dir');
  return {
    dir: dirIndex >= 0 ? argv[dirIndex + 1] : DEFAULT_DIR,
  };
}

async function collectJsFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsFiles(full)));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const { dir } = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const target = resolve(root, dir);

  if (!existsSync(target)) {
    console.error(`::error::build artifacts not found: ${dir}`);
    console.error(
      '検査対象が無いことは合格ではありません。' +
        ' pnpm --filter @atelier/web run build を先に実行してください。',
    );
    return 1;
  }

  const files = await collectJsFiles(target);
  if (files.length === 0) {
    console.error(`::error::no .js chunks under ${dir}`);
    return 1;
  }

  const violations = [];
  for (const file of files) {
    const body = await readFile(file, 'utf-8');
    for (const specifier of FORBIDDEN_SPECIFIERS) {
      // バンドラが解決できずに残った素の動的 import。
      // 解決済みのチャンク参照 (a.e(6471) 等) や文字列リテラルには一致しない。
      for (const quote of ['"', "'"]) {
        if (body.includes(`import(${quote}${specifier}${quote})`)) {
          violations.push({ file: relative(root, file), specifier });
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error('::error::未解決の bare specifier がビルド成果物に残っています:');
    for (const { file, specifier } of violations) {
      console.error(`  ${file}  import("${specifier}")`);
    }
    console.error(
      '\n対処: 該当の動的 import から webpackIgnore magic comment を外し、' +
        '\n      specifier を変数ではなく静的な文字列リテラルで書いてください。',
    );
    return 1;
  }

  console.log(
    `check-build-artifacts: OK — ${files.length} chunk(s) 走査、未解決の bare specifier 0 件 ` +
      `(${FORBIDDEN_SPECIFIERS.join(', ')})`,
  );
  return 0;
}

process.exitCode = await main();
