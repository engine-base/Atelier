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
  numeric,
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

// =============================================================================
// AI 社員系 enums — T-D-03 (E-007/008/009 で共有)
// =============================================================================
export const aiEmployeeRoleEnum = pgEnum('ai_employee_role_enum', [
  'coo',
  'lead',
  'member',
]);
export type AiEmployeeRole = (typeof aiEmployeeRoleEnum.enumValues)[number];

export const aiEmployeeDepartmentEnum = pgEnum('ai_employee_department_enum', [
  'executive',
  'sales',
  'product',
  'architecture',
  'design',
  'dev_qa',
  'cross_functional',
]);
export type AiEmployeeDepartment =
  (typeof aiEmployeeDepartmentEnum.enumValues)[number];

export const tonePresetEnum = pgEnum('tone_preset_enum', [
  'polite',
  'friendly',
  'casual',
  'concise',
  'coaching',
]);
export type TonePreset = (typeof tonePresetEnum.enumValues)[number];

// =============================================================================
// E-009 Skill — T-D-03
// global なスキル定義 (Anthropic Skills 互換 markdown ベース)。
// (name, version) UNIQUE。version は semver。
// =============================================================================
export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    description: text('description'),
    contentMd: text('content_md').notNull(),
    assetsStoragePath: text('assets_storage_path'),
    allowedEmployeeRoles: text('allowed_employee_roles')
      .array()
      .notNull()
      .default(sql`array[]::text[]`),
    allowedEmployeeIds: uuid('allowed_employee_ids')
      .array()
      .notNull()
      .default(sql`array[]::uuid[]`),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    versionSemver: check(
      'skills_version_semver',
      sql`${table.version} ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$'`,
    ),
    nameVersionUnique: unique('skills_name_version_key').on(
      table.name,
      table.version,
    ),
  }),
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;

// =============================================================================
// E-008 AiEmployeeTemplate — T-D-03
// AI 社員テンプレ (jarvis / tony 等)。global admin only。
// =============================================================================
export const aiEmployeeTemplates = pgTable(
  'ai_employee_templates',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    defaultName: text('default_name').notNull(),
    defaultDisplayName: text('default_display_name').notNull(),
    defaultIcon: text('default_icon'),
    department: aiEmployeeDepartmentEnum('department').notNull(),
    role: aiEmployeeRoleEnum('role').notNull(),
    defaultSkills: uuid('default_skills')
      .array()
      .notNull()
      .default(sql`array[]::uuid[]`),
    defaultKnowledgeCats: text('default_knowledge_cats')
      .array()
      .notNull()
      .default(sql`array[]::text[]`),
    systemPrompt: text('system_prompt').notNull(),
    specialty: text('specialty').notNull(),
    version: integer('version').notNull().default(1),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    versionPositive: check(
      'ai_employee_templates_version_positive',
      sql`${table.version} >= 1`,
    ),
    nameVersionUnique: unique('ai_employee_templates_name_version_key').on(
      table.defaultName,
      table.version,
    ),
  }),
);

export type AiEmployeeTemplate = typeof aiEmployeeTemplates.$inferSelect;
export type NewAiEmployeeTemplate = typeof aiEmployeeTemplates.$inferInsert;

// =============================================================================
// E-007 AiEmployee — T-D-03
// workspace 配下の AI 社員インスタンス。template_id は SET NULL で履歴保持。
// custom_tone_text は最大 500 文字。
// =============================================================================
export const aiEmployees = pgTable(
  'ai_employees',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id').references(() => aiEmployeeTemplates.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    displayName: text('display_name').notNull(),
    icon: text('icon'),
    role: aiEmployeeRoleEnum('role').notNull(),
    department: aiEmployeeDepartmentEnum('department').notNull(),
    tonePreset: tonePresetEnum('tone_preset').notNull().default('polite'),
    customToneText: text('custom_tone_text'),
    attachedSkills: uuid('attached_skills')
      .array()
      .notNull()
      .default(sql`array[]::uuid[]`),
    attachedKnowledgeCats: text('attached_knowledge_cats')
      .array()
      .notNull()
      .default(sql`array[]::text[]`),
    systemPromptOverride: text('system_prompt_override'),
    isDefault: boolean('is_default').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    customToneLength: check(
      'ai_employees_custom_tone_length',
      sql`${table.customToneText} is null or char_length(${table.customToneText}) <= 500`,
    ),
    workspaceNameUnique: unique('ai_employees_workspace_name_key').on(
      table.workspaceId,
      table.name,
    ),
  }),
);

export type AiEmployee = typeof aiEmployees.$inferSelect;
export type NewAiEmployee = typeof aiEmployees.$inferInsert;

// =============================================================================
// Task 系 enums — T-D-05 (E-012, Hermes v3.1 互換)
// =============================================================================
export const taskTypeEnum = pgEnum('task_type_enum', [
  'foundation',
  'screen',
  'feature',
  'verification',
  'infrastructure',
]);
export type TaskType = (typeof taskTypeEnum.enumValues)[number];

export const taskStatusEnum = pgEnum('task_status_enum', [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);
export type TaskStatusValue = (typeof taskStatusEnum.enumValues)[number];

export const taskPriorityEnum = pgEnum('task_priority_enum', [
  'low',
  'medium',
  'high',
  'urgent',
]);
export type TaskPriority = (typeof taskPriorityEnum.enumValues)[number];

export const taskLifecycleEnum = pgEnum('task_lifecycle_enum', [
  'triage',
  'ready',
  'in_progress',
  'blocked',
  'awaiting',
  'done',
]);
export type TaskLifecycle = (typeof taskLifecycleEnum.enumValues)[number];

export const taskDispatchEnum = pgEnum('task_dispatch_enum', [
  'queued',
  'spawning',
  'running',
  'completing',
  'dead',
  'reclaimed',
]);
export type TaskDispatch = (typeof taskDispatchEnum.enumValues)[number];

// =============================================================================
// E-012 Task — T-D-05 (Hermes v3.1 互換 31 フィールド)
// workspace_scoped via project_id、soft_delete、kanban 6 列モデル。
// acceptance_criteria_id / mock_id は forward ref (T-D-06 / T-D-07 で ALTER FK 追加予定)。
// =============================================================================
export const tasks = pgTable(
  'tasks',
  {
    // 識別 & 階層
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    phaseId: uuid('phase_id').references(() => phases.id, {
      onDelete: 'set null',
    }),
    // parent_task_id は self-reference (FK は SQL で配置済、Drizzle は型のみ)
    parentTaskId: uuid('parent_task_id'),

    // 表示
    category: text('category').notNull(),
    title: text('title').notNull(),
    description: text('description'),

    // 分類
    type: taskTypeEnum('type').notNull(),
    estimatedHours: integer('estimated_hours').notNull(),

    // 依存関係 (アプリ層で整合性)
    dependencies: uuid('dependencies')
      .array()
      .notNull()
      .default(sql`array[]::uuid[]`),
    prerequisites: uuid('prerequisites')
      .array()
      .notNull()
      .default(sql`array[]::uuid[]`),
    blocks: uuid('blocks').array().notNull().default(sql`array[]::uuid[]`),

    // 関連 entity (forward ref: FK は T-D-06 / T-D-07 で ALTER 追加)
    acceptanceCriteriaId: uuid('acceptance_criteria_id'),
    mockId: uuid('mock_id'),
    specHtmlPath: text('spec_html_path'),
    assignedEmployeeId: uuid('assigned_employee_id').references(
      () => aiEmployees.id,
      { onDelete: 'set null' },
    ),

    // 状態 (coarse / fine 2 軸)
    status: taskStatusEnum('status').notNull().default('pending'),
    priority: taskPriorityEnum('priority').notNull().default('medium'),
    lifecycleStage: taskLifecycleEnum('lifecycle_stage')
      .notNull()
      .default('triage'),
    autoAdvanceAllowed: boolean('auto_advance_allowed').notNull().default(true),

    // ファイル mutex
    filesChanged: text('files_changed')
      .array()
      .notNull()
      .default(sql`array[]::text[]`),

    // 履歴
    originType: text('origin_type').notNull().default('initial_decomposition'),

    // Hermes 互換 (kanban_complete / kanban_block で記録)
    summary: text('summary'),
    metadata: jsonb('metadata').notNull().default({}),
    blockedReason: text('blocked_reason'),
    retryCount: integer('retry_count').notNull().default(0),

    // Bridge worker 状態
    worktreePath: text('worktree_path'),
    dispatchStatus: taskDispatchEnum('dispatch_status'),
    workerPid: integer('worker_pid'),
    workerStartedAt: timestamp('worker_started_at', { withTimezone: true }),
    workerLastHeartbeatAt: timestamp('worker_last_heartbeat_at', {
      withTimezone: true,
    }),

    // timestamps + soft delete
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    estimatedHoursRange: check(
      'tasks_estimated_hours_range',
      sql`${table.estimatedHours} between 1 and 24`,
    ),
    retryCountRange: check(
      'tasks_retry_count_range',
      sql`${table.retryCount} between 0 and 3`,
    ),
    originTypeValid: check(
      'tasks_origin_type_valid',
      sql`${table.originType} in ('initial_decomposition', 'refactor', 'scope_change_auto', 'manual_added')`,
    ),
    noSelfDependency: check(
      'tasks_no_self_dependency',
      sql`${table.parentTaskId} is null or ${table.parentTaskId} <> ${table.id}`,
    ),
    titleLength: check(
      'tasks_title_length',
      sql`char_length(${table.title}) between 1 and 200`,
    ),
  }),
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

// =============================================================================
// Task execution enum — T-D-06
// =============================================================================
export const taskExecutionStatusEnum = pgEnum('task_execution_status_enum', [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
]);
export type TaskExecutionStatus =
  (typeof taskExecutionStatusEnum.enumValues)[number];

// =============================================================================
// E-014 AcceptanceCriteria — T-D-06
// task ごとの 3-tier AC (structural/functional/regression)。
// task_id UNIQUE で 1:1 関係。items は jsonb array。
// =============================================================================
export const acceptanceCriteria = pgTable(
  'acceptance_criteria',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .unique()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    htmlPath: text('html_path').notNull(),
    items: jsonb('items').notNull().default([]),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    versionPositive: check(
      'acceptance_criteria_version_positive',
      sql`${table.version} >= 1`,
    ),
    itemsArray: check(
      'acceptance_criteria_items_array',
      sql`jsonb_typeof(${table.items}) = 'array'`,
    ),
  }),
);

export type AcceptanceCriteria = typeof acceptanceCriteria.$inferSelect;
export type NewAcceptanceCriteria = typeof acceptanceCriteria.$inferInsert;

// =============================================================================
// E-013 TaskExecution — T-D-06
// task の各実行履歴。1 task : N executions (retry / re-run 含む)。
// score / pass_rate は numeric(4,3) (0.000-1.000)。
// Drizzle pg-core では numeric(p,s) は `numeric(...)` で表現。
// =============================================================================
export const taskExecutions = pgTable(
  'task_executions',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    score: numeric('score', { precision: 4, scale: 3 }),
    acPassRate: numeric('ac_pass_rate', { precision: 4, scale: 3 }),
    testPassRate: numeric('test_pass_rate', { precision: 4, scale: 3 }),
    verificationScore: numeric('verification_score', {
      precision: 4,
      scale: 3,
    }),
    retryCount: integer('retry_count').notNull().default(0),
    claudeCodeSessionId: text('claude_code_session_id'),
    status: taskExecutionStatusEnum('status').notNull(),
    logsStoragePath: text('logs_storage_path'),
    errorSummary: text('error_summary'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    retryCountRange: check(
      'task_executions_retry_count_range',
      sql`${table.retryCount} between 0 and 3`,
    ),
    scoreRange: check(
      'task_executions_score_range',
      sql`${table.score} is null or (${table.score} >= 0 and ${table.score} <= 1)`,
    ),
    acPassRateRange: check(
      'task_executions_ac_pass_rate_range',
      sql`${table.acPassRate} is null or (${table.acPassRate} >= 0 and ${table.acPassRate} <= 1)`,
    ),
    testPassRateRange: check(
      'task_executions_test_pass_rate_range',
      sql`${table.testPassRate} is null or (${table.testPassRate} >= 0 and ${table.testPassRate} <= 1)`,
    ),
    verificationScoreRange: check(
      'task_executions_verification_score_range',
      sql`${table.verificationScore} is null or (${table.verificationScore} >= 0 and ${table.verificationScore} <= 1)`,
    ),
    completedAfterStarted: check(
      'task_executions_completed_after_started',
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.startedAt}`,
    ),
  }),
);

export type TaskExecution = typeof taskExecutions.$inferSelect;
export type NewTaskExecution = typeof taskExecutions.$inferInsert;

// =============================================================================
// Comment polymorphic target enum — T-D-07
// =============================================================================
export const commentTargetTypeEnum = pgEnum('comment_target_type_enum', [
  'workflow_output',
  'mock',
  'task',
  'acceptance_criteria',
]);
export type CommentTargetType =
  (typeof commentTargetTypeEnum.enumValues)[number];

// =============================================================================
// E-015 Mock — T-D-07
// HTML モック (Supabase Storage 連携)。version chain で履歴管理。
// =============================================================================
export const mocks = pgTable(
  'mocks',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    screenName: text('screen_name').notNull(),
    htmlStoragePath: text('html_storage_path').notNull(),
    version: integer('version').notNull().default(1),
    // self-reference は Drizzle 型のみ宣言 (FK は SQL で配置済)
    parentMockId: uuid('parent_mock_id'),
    metaTags: jsonb('meta_tags'),
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
      'mocks_version_positive',
      sql`${table.version} >= 1`,
    ),
    noSelfParent: check(
      'mocks_no_self_parent',
      sql`${table.parentMockId} is null or ${table.parentMockId} <> ${table.id}`,
    ),
    metaTagsObject: check(
      'mocks_meta_tags_object',
      sql`${table.metaTags} is null or jsonb_typeof(${table.metaTags}) = 'object'`,
    ),
  }),
);

export type Mock = typeof mocks.$inferSelect;
export type NewMock = typeof mocks.$inferInsert;

// =============================================================================
// E-016 Comment — T-D-07
// polymorphic target (workflow_output/mock/task/acceptance_criteria)。
// author は user か client_invitation のどちらか (T-D-08 で invitation FK 後付け)。
// =============================================================================
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    targetType: commentTargetTypeEnum('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    targetElementId: text('target_element_id'),
    authorUserId: uuid('author_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // author_invitation_id: T-D-08 で FK 後付け (client_invitations 未作成)
    authorInvitationId: uuid('author_invitation_id'),
    content: text('content').notNull(),
    status: text('status').notNull().default('open'),
    // self-reference: FK は SQL で配置済
    parentCommentId: uuid('parent_comment_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    statusValid: check(
      'comments_status_valid',
      sql`${table.status} in ('open', 'resolved', 'deleted')`,
    ),
    contentLength: check(
      'comments_content_length',
      sql`char_length(${table.content}) between 1 and 10000`,
    ),
    noSelfParent: check(
      'comments_no_self_parent',
      sql`${table.parentCommentId} is null or ${table.parentCommentId} <> ${table.id}`,
    ),
    authorExclusive: check(
      'comments_author_exclusive',
      sql`${table.authorUserId} is null or ${table.authorInvitationId} is null`,
    ),
  }),
);

export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;

// =============================================================================
// E-017 ClientInvitation — T-D-08
// クライアント外部レビュー用招待 (token-based, TTL)。F-L01。
//
// セキュリティ:
//   - token_hash は SHA-256 hex (アプリ層で生成、生 token は DB に保存しない)
//   - expires_at は最大 30 日 (アプリ層は default 7 日)
//   - scopes は jsonb array (デフォルト ["view","comment"])
// =============================================================================
export const clientInvitations = pgTable(
  'client_invitations',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: jsonb('scopes').notNull().default(['view', 'comment']),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    clientDisplayName: text('client_display_name'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    emailFormat: check(
      'client_invitations_email_format',
      sql`${table.email} ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'`,
    ),
    tokenHashSha256: check(
      'client_invitations_token_hash_sha256',
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    scopesArray: check(
      'client_invitations_scopes_array',
      sql`jsonb_typeof(${table.scopes}) = 'array'`,
    ),
    usedAfterCreation: check(
      'client_invitations_used_after_creation',
      sql`${table.usedAt} is null or ${table.usedAt} >= ${table.createdAt}`,
    ),
    revokedAfterCreation: check(
      'client_invitations_revoked_after_creation',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
    expiryReasonable: check(
      'client_invitations_expiry_reasonable',
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '30 days'`,
    ),
  }),
);

export type ClientInvitation = typeof clientInvitations.$inferSelect;
export type NewClientInvitation = typeof clientInvitations.$inferInsert;
