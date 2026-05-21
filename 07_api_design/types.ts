/**
 * Atelier API TypeScript 型定義 v1.0
 *
 * このファイルは openapi.yaml から自動生成される正本。
 * 直接編集禁止。`pnpm run gen:api` で再生成すること。
 *
 * 生成元: openapi.yaml (frozen 2026-05-20T13:30:00+09:00)
 * 生成ツール: openapi-typescript
 *
 * Foundation phase CI gate: drift 検出時は PR ブロック
 */

// ============================================================================
// 共通レスポンス封筒
// ============================================================================

export type ApiResponse<T> = {
  data: T;
};

export type ApiPaginatedResponse<T> = {
  data: T[];
  meta: {
    next_cursor: string | null;
    limit: number;
    total_estimate?: number;
  };
};

export type ApiOffsetPaginatedResponse<T> = {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
};

export type ApiError = {
  error: {
    code: ErrorCode;
    message: string;
    details?: Array<{
      field: string;
      code: string;
      message: string;
    }>;
    request_id: string;
    trace_id?: string;
  };
};

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "INVALID_CREDENTIALS"
  | "INVALID_BRIDGE_TOKEN"
  | "INVALID_INVITATION_TOKEN"
  | "FORBIDDEN"
  | "ACCOUNT_LOCKED"
  | "ACCOUNT_DELETED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_LIFECYCLE_STAGE"
  | "DEPENDENCIES_NOT_MET"
  | "ALREADY_DECIDED"
  | "EMAIL_ALREADY_REGISTERED"
  | "EMAIL_IN_DELETION_GRACE"
  | "OWNER_OF_WORKSPACE_WITH_OTHERS"
  | "INVITATION_EXPIRED"
  | "VALIDATION_ERROR"
  | "CONSENT_REQUIRED"
  | "RATE_LIMITED"
  | "BYOK_QUOTA_EXCEEDED"
  | "INTERNAL_ERROR"
  | "BRIDGE_OFFLINE"
  | "PARALLEL_LIMIT_REACHED"
  | "F_CTX01_TIMEOUT";

// ============================================================================
// 基本型
// ============================================================================

export type UUID = string;  // UUID v7
export type ISO8601 = string;
export type Email = string;
export type JWT = string;

// ============================================================================
// 認証 (auth)
// ============================================================================

export type User = {
  id: UUID;
  email: Email;
  display_name: string;
  avatar_url: string | null;
  language: "ja" | "en";
  ai_learning_opt_out: boolean;
  deleted_at: ISO8601 | null;
  created_at: ISO8601;
  updated_at: ISO8601;
};

export type SignupRequest = {
  email: Email;
  password: string;
  display_name: string;
  consents: {
    terms: boolean;
    privacy: boolean;
    cross_border: boolean;
    marketing?: boolean;
  };
};

export type SigninRequest = {
  email: Email;
  password: string;
};

export type AuthResponse = {
  user: User;
  workspace?: Workspace;  // signup 時のみ
  access_token: JWT;
  refresh_token: string;  // opaque, httpOnly cookie
};

export type MagicLinkRequest = { email: Email };
export type ResetPasswordRequest = { email: Email };

// ============================================================================
// ワークスペース
// ============================================================================

export type Workspace = {
  id: UUID;
  name: string;
  description: string | null;
  member_count: number;
  project_count: number;
  plan: "free" | "pro" | "enterprise";
  deleted_at: ISO8601 | null;
  created_at: ISO8601;
  updated_at: ISO8601;
};

export type WorkspaceRole = "owner" | "member" | "viewer";

export type WorkspaceMembership = {
  user_id: UUID;
  workspace_id: UUID;
  role: WorkspaceRole;
  joined_at: ISO8601;
  user: User;
};

export type InviteMemberRequest = {
  email: Email;
  role: WorkspaceRole;
  message?: string;
};

// ============================================================================
// プロジェクト
// ============================================================================

export type ProjectType = "self_product" | "client_project" | "personal";
export type ProjectStatus = "in_progress" | "draft" | "paused" | "archived";

export type Project = {
  id: UUID;
  workspace_id: UUID;
  name: string;
  description: string | null;
  type: ProjectType;
  status: ProjectStatus;
  ai_learning_opt_out: boolean;
  current_phase: WorkflowPhase;
  deleted_at: ISO8601 | null;
  created_at: ISO8601;
  updated_at: ISO8601;
};

export type ProjectDashboard = {
  project: Project;
  kpis: {
    total_tasks: number;
    completed_tasks: number;
    in_progress_tasks: number;
    awaiting_tasks: number;
    average_score: number | null;
    average_completion_minutes: number | null;
  };
  current_phase: WorkflowPhase;
  phase_completion_rate: number;
  recent_activities: Activity[];
};

export type CreateProjectRequest = {
  workspace_id: UUID;
  name: string;
  type: ProjectType;
  description?: string;
};

// ============================================================================
// AI 社員
// ============================================================================

export type AIEmployeeRole =
  | "jarvis" | "tony" | "natasha" | "steve" | "peter"
  | "strange" | "wanda" | "thor" | "vision" | "tchalla";

export type AIEmployee = {
  id: UUID;
  project_id: UUID;
  role: AIEmployeeRole;
  display_name: string;
  icon: string;
  tone_preset: "friendly" | "professional" | "concise" | "custom";
  custom_tone_text: string | null;
  abilities: string[];  // 「できること」list
  is_fixed: true;  // 運営側固定
};

// ============================================================================
// チャット
// ============================================================================

export type ChatThread = {
  id: UUID;
  project_id: UUID;
  ai_employee_id: UUID;
  title: string;
  phase: WorkflowPhase;
  message_count: number;
  last_message_at: ISO8601;
  created_at: ISO8601;
};

export type ChatMessage = {
  id: UUID;
  thread_id: UUID;
  role: "user" | "assistant";
  content: string;
  tool_calls?: ToolCall[];
  attachments?: Attachment[];
  model?: string;
  response_time_sec?: number;
  created_at: ISO8601;
};

export type ToolCall = {
  tool_name: string;
  args: Record<string, unknown>;
  result?: unknown;
};

export type Attachment = {
  type: "image" | "pdf" | "audio";
  url: string;
  filename: string;
  size_bytes: number;
};

export type SendMessageRequest = {
  content: string;
  attachments?: Attachment[];
};

// SSE Event types
export type SSEEvent =
  | { event: "start"; data: { message_id: UUID; thread_id: UUID } }
  | { event: "tool_call"; data: ToolCall }
  | { event: "tool_result"; data: { tool_name: string; result: unknown } }
  | { event: "token"; data: { text: string } }
  | { event: "end"; data: { message_id: UUID; model: string; response_time_sec: number } };

// ============================================================================
// 工程ワークフロー
// ============================================================================

export type WorkflowPhase =
  | "hearing" | "requirements" | "architecture" | "design"
  | "breakdown" | "tasks" | "implementation" | "verification" | "delivery";

export type Phase = {
  id: UUID;
  project_id: UUID;
  phase: WorkflowPhase;
  status: "not_started" | "in_progress" | "awaiting_approval" | "completed";
  completion_rate: number;
  started_at: ISO8601 | null;
  completed_at: ISO8601 | null;
};

export type WorkflowOutput = {
  id: UUID;
  project_id: UUID;
  phase: WorkflowPhase;
  title: string;
  format: "html" | "json" | "md";
  content_url: string;
  version: number;
  created_at: ISO8601;
};

// ============================================================================
// タスク (6 列ライフサイクル)
// ============================================================================

export type TaskLifecycleStage =
  | "triage" | "ready" | "in_progress" | "blocked" | "awaiting" | "done";

export type TaskDispatchStatus =
  | "queued" | "spawning" | "running" | "completing" | "dead" | "reclaimed";

export type Task = {
  id: UUID;
  project_id: UUID;
  phase: WorkflowPhase;
  category: string;
  title: string;
  description: string | null;
  type: "foundation" | "screen" | "feature" | "verification" | "infrastructure" | "migration";
  estimated_hours: number;
  priority: "critical" | "high" | "medium" | "low";
  lifecycle_stage: TaskLifecycleStage;
  dispatch_status: TaskDispatchStatus | null;
  assigned_employee_id: AIEmployeeRole;
  // Hermes 互換フィールド
  summary: string | null;
  metadata: Record<string, unknown>;
  blocked_reason: string | null;
  retry_count: number;
  worktree_path: string | null;
  worker_pid: number | null;
  // 依存関係
  dependencies: UUID[];
  prerequisites: UUID[];
  blocks: UUID[];
  // 紐付け
  acceptance_criteria_id: UUID | null;
  mock_id: UUID | null;
  spec_html_path: string | null;
  // 系譜
  parent_task_id: UUID | null;
  origin_type: "initial_decomposition" | "refactor" | "scope_change_auto" | "manual_added";
  // タイムスタンプ
  created_at: ISO8601;
  updated_at: ISO8601;
};

export type CreateTaskRequest = {
  category: string;
  title: string;
  description?: string;
  type: Task["type"];
  estimated_hours: number;
  priority: Task["priority"];
  dependencies?: UUID[];
  assigned_employee_id: AIEmployeeRole;
};

export type PlayTaskRequest = {
  force?: boolean;
};

export type PlayTaskResponse = {
  task_id: UUID;
  lifecycle_stage: TaskLifecycleStage;
  dispatch_status: TaskDispatchStatus;
  execution_id: UUID;
  worktree_path: string;
  bridge_command: string;
  queue_position?: number;  // 並列上限超過時
};

// ============================================================================
// Hermes 互換 kanban tools (Bridge worker 専用)
// ============================================================================

export type KanbanCompleteRequest = {
  task_id: UUID;
  summary: string;
  metadata: {
    score: number;  // 0-1
    ac_pass_rate: number;
    test_pass_rate: number;
    verification_score: number;
    files_changed: string[];
    retry_count: number;
  };
};

export type KanbanBlockRequest = {
  task_id: UUID;
  reason: string;
};

// ============================================================================
// 実行 / Bridge
// ============================================================================

export type Execution = {
  id: UUID;
  task_id: UUID;
  started_at: ISO8601;
  completed_at: ISO8601 | null;
  score: number | null;
  ac_pass_rate: number | null;
  test_pass_rate: number | null;
  verification_score: number | null;
  retry_count: number;
  claude_code_session_id: string | null;
  status: "running" | "succeeded" | "failed" | "cancelled" | "timeout";
  logs_storage_path: string | null;
  error_summary: string | null;
};

export type BridgeStatus = {
  connected: boolean;
  bridge_version: string;
  client_hostname: string;
  active_workers: number;
  parallel_capacity: number;
  queued_tasks: number;
  last_heartbeat_at: ISO8601;
};

// ============================================================================
// 承認待ちインボックス
// ============================================================================

export type ApprovalCategory =
  | "task_approval" | "phase_approval" | "scope_change"
  | "knowledge_promotion" | "comment_response";

export type ApprovalInboxEntry = {
  id: UUID;
  category: ApprovalCategory;
  urgent: boolean;
  title: string;
  preview: string;
  source_ref: {
    type: "task" | "phase" | "workflow_output" | "knowledge" | "comment";
    id: UUID;
  };
  detected_by: {
    employee_id: AIEmployeeRole;
    at: ISO8601;
  };
  impact_analysis?: {
    tasks: number;
    completed: number;
    in_progress: number;
    todo: number;
  };
  score?: number;
  created_at: ISO8601;
  decided_at: ISO8601 | null;
};

export type ApprovalDecideRequest = {
  decision: "approve" | "reject" | "defer";
  reason?: string;
  scope_change_options?: {
    rerun_phases: WorkflowPhase[];
  };
};

// ============================================================================
// クライアント招待 (R-T08 致命級リスク対応・別 JWT 系統)
// ============================================================================

export type ClientInvitation = {
  id: UUID;
  project_id: UUID;
  client_display_name: string;
  email: Email;
  scope: "view" | "view_comment";
  status: "active" | "expired" | "revoked";
  expires_at: ISO8601;
  use_count: number;
  created_at: ISO8601;
};

export type ClientSigninRequest = {
  invitation_token: string;
  display_name?: string;
};

export type ClientSigninResponse = {
  client_access_token: JWT;
  project: { id: UUID; name: string };
  expires_at: ISO8601;
};

// ============================================================================
// ナレッジ
// ============================================================================

export type KnowledgeScope = "project" | "ai_employee" | "account";

export type KnowledgeNode = {
  id: UUID;
  scope: KnowledgeScope;
  project_id: UUID | null;
  ai_employee_id: AIEmployeeRole | null;
  title: string;
  body: string;
  tags: string[];
  embedding: number[] | null;  // Voyage AI
  promotion_status: "none" | "pending_promotion" | "promoted";
  created_at: ISO8601;
  updated_at: ISO8601;
};

// ============================================================================
// 承認待ち / コメント
// ============================================================================

export type Comment = {
  id: UUID;
  target_type: "workflow_output" | "mock" | "task";
  target_id: UUID;
  target_anchor: string | null;
  author_type: "user" | "client_portal" | "ai_employee";
  author_id: UUID;
  body: string;
  resolved: boolean;
  parent_comment_id: UUID | null;
  created_at: ISO8601;
};

// ============================================================================
// その他
// ============================================================================

export type Activity = {
  id: UUID;
  type: string;
  actor: { type: "user" | "ai_employee"; id: UUID };
  target_type: string;
  target_id: UUID;
  description: string;
  created_at: ISO8601;
};

export type AuditLog = {
  id: UUID;
  actor_type: "user" | "ai_employee" | "system" | "client_portal";
  actor_id: UUID;
  action: string;
  target_type: string;
  target_id: UUID;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: UUID;
  created_at: ISO8601;
};

export type Consent = {
  id: UUID;
  user_id: UUID;
  type: "terms" | "privacy" | "cross_border" | "marketing";
  version: string;
  agreed_at: ISO8601;
  revoked_at: ISO8601 | null;
};

// ============================================================================
// 注意：完全な型定義は openapi.yaml から自動生成される
// このファイルは主要型のスケルトン。実装時は openapi-typescript で全 119
// endpoint の型を生成し、このファイルを上書き。
// ============================================================================
