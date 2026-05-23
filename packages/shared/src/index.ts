// @atelier/shared — 共有型・Zod スキーマ・定数の集約点
// T-F-25 (OpenAPI → TS 型生成パイプライン) で types.ts が再 export される

export const ATELIER_VERSION = '0.1.0' as const;

// moduleResolution: "bundler" 環境では拡張子なしが正準。
// `.js` 拡張子は Node ESM (NodeNext) 経由でのみ有効だが、Next.js webpack の
// bundler resolver は raw `.ts` を解決できず "Module not found: ./schema.js"
// で fail する。packages/shared は workspace で raw TS を直接 import される
// (package.json の `main: ./src/index.ts`) ため、bundler convention に揃える。
export * from './schema';
