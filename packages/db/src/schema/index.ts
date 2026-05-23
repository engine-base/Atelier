/**
 * @atelier/db — Drizzle schema 集約点 (T-D-01〜)。
 *
 * 信頼源: 04_functional_breakdown/entities.json
 * 同期: supabase/migrations/*.sql ↔ Drizzle schema (T-D-26 で drift 検証 CI)
 *
 * 本ファイルは Wave 1 で T-D-XX が追加される度に table 定義を追記する
 * 集約点。一定規模になったら別ファイルへ分割するが、T-D-01 段階では
 * files_changed_predicted (modify: index.ts のみ) に合わせて単一ファイル
 * 構成にする。
 */

import { sql } from 'drizzle-orm';
import {
  check,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// =============================================================================
// E-001 User
// SQL: supabase/migrations/t-d-01_001_002_003.sql
// Supabase auth.users.id と 1:1 リンクするため id は default を持たない。
// =============================================================================
export const users = pgTable('users', {
  id: uuid('id').primaryKey().notNull(),
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// =============================================================================
// E-002 Workspace
// テナント単位。RLS は T-D-15 で配置。name は 2-50 文字制約。
// =============================================================================
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    icon: text('icon'),
    plan: text('plan').notNull().default('free'),
    settings: jsonb('settings').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    nameLength: check(
      'workspaces_name_length',
      sql`char_length(${table.name}) between 2 and 50`,
    ),
  }),
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;

// =============================================================================
// E-003 WorkspaceMembership
// 複合 PK (workspace_id, user_id)。role は enum。
// =============================================================================
export const workspaceMemberRoleEnum = pgEnum('workspace_member_role_enum', [
  'owner',
  'member',
  'viewer',
]);

export type WorkspaceMemberRole =
  (typeof workspaceMemberRoleEnum.enumValues)[number];

export const workspaceMemberships = pgTable(
  'workspace_memberships',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceMemberRoleEnum('role').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.userId] }),
  }),
);

export type WorkspaceMembership = typeof workspaceMemberships.$inferSelect;
export type NewWorkspaceMembership = typeof workspaceMemberships.$inferInsert;
