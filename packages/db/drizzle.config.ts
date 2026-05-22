import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config — TS 型生成 + drizzle-kit studio 用。
 *
 * Migration は **Supabase CLI 一本化** (selected-stack.json#orm_ts.review)。
 * drizzle-kit generate は確認用で、本番 migration は supabase migration new で生成する。
 *
 * DATABASE_URL は環境変数から読む。.env で定義:
 *   DATABASE_URL=postgresql://postgres:password@localhost:54322/postgres
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/*.ts',
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:54322/postgres',
  },
  strict: true,
  verbose: true,
  casing: 'snake_case',
});
