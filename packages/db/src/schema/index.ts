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
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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

// =============================================================================
// E-004 Project — T-D-02
// workspace 配下の案件。workspace_scoped、soft_delete。
// ai_training_optout (F-LEGAL-011): デフォルト true (学習しない、R-T08 致命級)。
// =============================================================================
export const projectTypeEnum = pgEnum('project_type_enum', [
  'client_work',
  'internal_product',
  'personal',
]);
export type ProjectType = (typeof projectTypeEnum.enumValues)[number];

export const projectStatusEnum = pgEnum('project_status_enum', [
  'draft',
  'active',
  'paused',
  'archived',
]);
export type ProjectStatus = (typeof projectStatusEnum.enumValues)[number];

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    clientName: text('client_name'),
    projectType: projectTypeEnum('project_type').notNull(),
    status: projectStatusEnum('status').notNull().default('draft'),
    aiTrainingOptout: boolean('ai_training_optout').notNull().default(true),
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
      'projects_name_length',
      sql`char_length(${table.name}) between 1 and 200`,
    ),
  }),
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

// =============================================================================
// E-005 Phase — T-D-02
// project 内の段階。"order" で表示順制御。(project_id, order) UNIQUE。
// =============================================================================
export const phaseStatusEnum = pgEnum('phase_status_enum', [
  'pending',
  'in_progress',
  'completed',
  'skipped',
]);
export type PhaseStatus = (typeof phaseStatusEnum.enumValues)[number];

export const phases = pgTable(
  'phases',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    order: integer('order').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: phaseStatusEnum('status').notNull().default('pending'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    orderPositive: check('phases_order_positive', sql`${table.order} >= 0`),
    projectOrderUnique: unique('phases_project_id_order_key').on(
      table.projectId,
      table.order,
    ),
  }),
);

export type Phase = typeof phases.$inferSelect;
export type NewPhase = typeof phases.$inferInsert;

// =============================================================================
// E-006 WorkflowOutput — T-D-02
// 各 stage の生成物 (html / json / md パス)。Supabase Storage と連携。
// version で履歴管理 (soft_delete + version で旧版保持)。
// =============================================================================
export const workflowStageEnum = pgEnum('workflow_stage_enum', [
  'proposal',
  'estimate',
  'hearing',
  'requirements',
  'architecture',
  'design',
  'breakdown',
  'tasks',
  'implementation',
  'verification',
  'delivery',
]);
export type WorkflowStage = (typeof workflowStageEnum.enumValues)[number];

export const workflowOutputs = pgTable(
  'workflow_outputs',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    phaseId: uuid('phase_id').references(() => phases.id, {
      onDelete: 'set null',
    }),
    stage: workflowStageEnum('stage').notNull(),
    htmlPath: text('html_path'),
    jsonPath: text('json_path'),
    mdPath: text('md_path'),
    summary: text('summary'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    versionPositive: check(
      'workflow_outputs_version_positive',
      sql`${table.version} >= 1`,
    ),
  }),
);

export type WorkflowOutput = typeof workflowOutputs.$inferSelect;
export type NewWorkflowOutput = typeof workflowOutputs.$inferInsert;
