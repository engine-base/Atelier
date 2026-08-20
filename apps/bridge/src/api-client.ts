/**
 * Atelier Bridge — API クライアント (T-F-41)
 *
 * kanban 7 endpoints (T-F-28/T-A-28) を X-Bridge-Token 認証で呼ぶ唯一の経路。
 * DB 直叩きはしない (T-F-41 AC)。
 */

export interface KanbanPickResult {
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly worktreePath: string | null;
  readonly noAvailableTask: boolean;
  /** GAP-030: 子プロセスへ渡すプロンプト材料 (pick 応答のタスク内容)。 */
  readonly taskTitle: string | null;
  readonly taskDescription: string | null;
  readonly assignedEmployee: string | null;
}

export interface CompleteMetadata {
  readonly score: number;
  readonly acPassRate: number;
  readonly testPassRate: number;
  readonly verificationScore: number;
  readonly retryCount: number;
  readonly filesChanged: readonly string[];
}

export class BridgeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeAuthError';
  }
}

/** GAP-114: chat relay pick の応答 (job が無い場合は null)。 */
export interface ChatRelayPicked {
  readonly jobId: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  /** GAP-134: PC 操作モード (off/approve/auto) — 本人 PC で実行する。 */
  readonly toolsMode: 'off' | 'approve' | 'auto';
}

/** GAP-134: chunk 種別 — delta (本文) / tool (ツール実況、content はツール名)。 */
export type ChatRelayChunkKind = 'delta' | 'tool';

/** GAP-134: 承認決定 (Bridge がポーリングで読む)。 */
export type ChatRelayApprovalDecision = 'pending' | 'allow' | 'deny' | 'timeout';

/** GAP-119: claude CLI の rate_limit_event 観測値 (実値のみ complete へ転送)。 */
export interface ChatRelayRateLimitObservation {
  readonly status: 'allowed' | 'allowed_warning' | 'rejected';
  readonly rate_limit_type: string | null;
  readonly utilization: number | null;
  readonly resets_at: number | null;
}

export interface BridgeApi {
  pick(workerPid: number, projectId?: string): Promise<KanbanPickResult>;
  /** GAP-114: チャット中継 job を 1 件確保 (無ければ null)。 */
  chatRelayPick(workerId: string): Promise<ChatRelayPicked | null>;
  /** GAP-114/134: chunk を追記 (seqStart からの連番)。kinds 省略時は全て delta。 */
  chatRelayChunks(
    jobId: string,
    seqStart: number,
    texts: readonly string[],
    kinds?: readonly ChatRelayChunkKind[],
  ): Promise<void>;
  /** GAP-134: CLI の許可要求を承認キューへ積む → approval_id。 */
  chatRelayCreateApproval(jobId: string, tool: string, summary: string): Promise<string>;
  /** GAP-134: 承認決定をポーリングで読む。 */
  chatRelayApprovalDecision(jobId: string, approvalId: string): Promise<ChatRelayApprovalDecision>;
  /** GAP-189: 中断を言われていないかをポーリングで読む (true なら子プロセスを止める)。 */
  chatRelayControl(jobId: string): Promise<boolean>;
  /** GAP-137/145: 成果物 (HTML + 画像/PPTX/PDF 等バイナリ) の送信 — complete の前に呼ぶ。 */
  chatRelayUploadArtifacts(
    jobId: string,
    artifacts: readonly {
      readonly fileName: string;
      readonly html?: string;
      readonly contentB64?: string;
    }[],
  ): Promise<void>;
  /** GAP-141: 作業場シードの取得。 */
  chatRelayWorkspaceSeed(
    jobId: string,
  ): Promise<
    readonly {
      readonly fileName: string;
      readonly html?: string;
      /** GAP-161: 添付資料 (画像/PDF/Excel 等) の実体 (base64)。 */
      readonly contentB64?: string;
    }[]
  >;
  /** GAP-114: job を done / error で確定 (GAP-119: プラン枠観測値も同送可)。 */
  chatRelayComplete(
    jobId: string,
    ok: boolean,
    error?: string,
    rateLimits?: readonly ChatRelayRateLimitObservation[],
  ): Promise<void>;
  start(taskId: string, executionId: string, workerPid: number): Promise<void>;
  complete(
    taskId: string,
    executionId: string,
    summary: string,
    metadata: CompleteMetadata,
  ): Promise<void>;
  requestChange(taskId: string, executionId: string, reason: string): Promise<void>;
  heartbeat(taskId: string, workerPid: number): Promise<void>;
  /** GAP-026①: Bridge presence (S-I03 接続バッジの実体)。poll ごとに送る。 */
  ping(info: {
    workerId: string;
    hostLabel: string;
    version: string;
    workerPid?: number;
  }): Promise<void>;
  /**
   * GAP-183: 自動実行の「見張り役」。発火時刻を過ぎたスケジュールを実行させる。
   *
   * クラウドに毎分の cron を置くと Fly.io のアイドル停止が効かず運営に固定費が
   * 出るため、PC が動いている間はこちらが時計を務める (運営コスト 0 円)。
   * スリープしていた間に過ぎた分は、起動して最初の呼び出しでまとめて実行される。
   */
  runDueSchedules(): Promise<ScheduleTickResult>;
}

/** GAP-183: 見張り 1 回分の結果。 */
export interface ScheduleTickResult {
  readonly due: number;
  readonly ran: number;
  readonly deferred: number;
  readonly failed: number;
  readonly scheduled: number;
}

export interface ApiClientConfig {
  readonly baseUrl: string; // e.g. http://127.0.0.1:8000
  readonly token: string; // ATELIER_BRIDGE_TOKEN
}

export class ApiClient implements BridgeApi {
  constructor(private readonly config: ApiClientConfig) {}

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Token': this.config.token,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 500) {
      // 401 = token 不一致 / 500 = ATELIER_BRIDGE_TOKEN 未設定 (API 側)
      throw new BridgeAuthError(`bridge auth failed: ${res.status} ${await res.text()}`);
    }
    if (!res.ok) {
      throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      headers: { 'X-Bridge-Token': this.config.token },
    });
    if (res.status === 401 || res.status === 500) {
      throw new BridgeAuthError(`bridge auth failed: ${res.status} ${await res.text()}`);
    }
    if (!res.ok) {
      throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  async pick(workerPid: number, projectId?: string): Promise<KanbanPickResult> {
    const json = (await this.post('/kanban/pick', {
      worker_pid: workerPid,
      ...(projectId ? { project_id: projectId } : {}),
    })) as {
      data: {
        task_id: string | null;
        execution_id: string | null;
        worktree_path: string | null;
        no_available_task: boolean;
        task_title?: string | null;
        task_description?: string | null;
        assigned_employee?: string | null;
      };
    };
    const d = json.data;
    return {
      taskId: d.task_id,
      executionId: d.execution_id,
      worktreePath: d.worktree_path,
      noAvailableTask: d.no_available_task,
      taskTitle: d.task_title ?? null,
      taskDescription: d.task_description ?? null,
      assignedEmployee: d.assigned_employee ?? null,
    };
  }

  async start(taskId: string, executionId: string, workerPid: number): Promise<void> {
    await this.post('/kanban/start', {
      task_id: taskId,
      execution_id: executionId,
      worker_pid: workerPid,
    });
  }

  async complete(
    taskId: string,
    executionId: string,
    summary: string,
    metadata: CompleteMetadata,
  ): Promise<void> {
    await this.post('/kanban/complete', {
      task_id: taskId,
      execution_id: executionId,
      summary,
      metadata: {
        score: metadata.score,
        ac_pass_rate: metadata.acPassRate,
        test_pass_rate: metadata.testPassRate,
        verification_score: metadata.verificationScore,
        retry_count: metadata.retryCount,
        files_changed: [...metadata.filesChanged],
      },
      auto_approve: false, // 人レビュー待ち (awaiting) が既定 — 勝手に done にしない
    });
  }

  async requestChange(taskId: string, executionId: string, reason: string): Promise<void> {
    await this.post('/kanban/request-change', {
      task_id: taskId,
      execution_id: executionId,
      reason,
    });
  }

  async heartbeat(taskId: string, workerPid: number): Promise<void> {
    await this.post('/kanban/heartbeat', {
      task_id: taskId,
      worker_pid: workerPid,
    });
  }

  async ping(info: {
    workerId: string;
    hostLabel: string;
    version: string;
    workerPid?: number;
  }): Promise<void> {
    await this.post('/bridge/ping', {
      worker_id: info.workerId,
      host_label: info.hostLabel,
      version: info.version,
      worker_pid: info.workerPid ?? null,
    });
  }

  async runDueSchedules(): Promise<ScheduleTickResult> {
    const json = (await this.post('/bridge/run-due-schedules', {})) as {
      data?: Partial<ScheduleTickResult>;
    };
    const d = json.data ?? {};
    return {
      due: d.due ?? 0,
      ran: d.ran ?? 0,
      deferred: d.deferred ?? 0,
      failed: d.failed ?? 0,
      scheduled: d.scheduled ?? 0,
    };
  }

  async chatRelayPick(workerId: string): Promise<ChatRelayPicked | null> {
    const json = (await this.post('/chat-relay/pick', { worker_id: workerId })) as {
      data: {
        job_id: string | null;
        system_prompt: string | null;
        prompt: string | null;
        tools_mode?: string | null;
        no_available_job: boolean;
      };
    };
    const d = json.data;
    if (d.no_available_job || d.job_id === null) return null;
    const toolsMode =
      d.tools_mode === 'approve' || d.tools_mode === 'auto' ? d.tools_mode : 'off';
    return {
      jobId: d.job_id,
      systemPrompt: d.system_prompt ?? '',
      prompt: d.prompt ?? '',
      toolsMode,
    };
  }

  async chatRelayChunks(
    jobId: string,
    seqStart: number,
    texts: readonly string[],
    kinds?: readonly ChatRelayChunkKind[],
  ): Promise<void> {
    await this.post(`/chat-relay/${jobId}/chunks`, {
      seq_start: seqStart,
      texts: [...texts],
      // GAP-134: 全部 delta なら省略 (後方互換 + ペイロード節約)
      ...(kinds && kinds.some((k) => k !== 'delta') ? { kinds: [...kinds] } : {}),
    });
  }

  async chatRelayCreateApproval(jobId: string, tool: string, summary: string): Promise<string> {
    const json = (await this.post(`/chat-relay/${jobId}/approvals`, {
      tool,
      summary,
    })) as { data: { approval_id: string } };
    return json.data.approval_id;
  }

  async chatRelayApprovalDecision(
    jobId: string,
    approvalId: string,
  ): Promise<ChatRelayApprovalDecision> {
    const json = (await this.get(`/chat-relay/${jobId}/approvals/${approvalId}`)) as {
      data: { decision: ChatRelayApprovalDecision };
    };
    return json.data.decision;
  }

  async chatRelayControl(jobId: string): Promise<boolean> {
    // GAP-189: サーバーが「止めろ」と言っているか。通信できないときは false
    // (通信不良を勝手に中断と解釈して、走っている仕事を殺さない)。
    const json = (await this.get(`/chat-relay/${jobId}/control`)) as {
      data: { cancel?: boolean };
    };
    return json.data.cancel === true;
  }

  async chatRelayUploadArtifacts(
    jobId: string,
    artifacts: readonly {
      readonly fileName: string;
      readonly html?: string;
      readonly contentB64?: string;
    }[],
  ): Promise<void> {
    // GAP-137/145: PC 操作の成果物をツール内へ取り込む (complete 前)。
    // HTML は html、バイナリ (画像/PPTX/PDF/Excel/動画 等) は content_b64。
    await this.post(`/chat-relay/${jobId}/artifacts`, {
      artifacts: artifacts.map((a) => ({
        file_name: a.fileName,
        ...(a.html !== undefined ? { html: a.html } : {}),
        ...(a.contentB64 !== undefined ? { content_b64: a.contentB64 } : {}),
      })),
    });
  }

  async chatRelayWorkspaceSeed(
    jobId: string,
  ): Promise<
    readonly {
      readonly fileName: string;
      readonly html?: string;
      readonly contentB64?: string;
    }[]
  > {
    // GAP-141: プロジェクト最新版をローカル作業場へ展開するための seed
    // GAP-161: 併せてこのスレッドの添付資料 (base64) も配られる
    const json = (await this.get(`/chat-relay/${jobId}/workspace`)) as {
      data: readonly {
        file_name: string;
        html?: string | null;
        content_b64?: string | null;
      }[];
    };
    // GAP-169: null (未設定) は undefined に正規化してから返す
    return json.data.map((f) => ({
      fileName: f.file_name,
      html: f.html ?? undefined,
      contentB64: f.content_b64 ?? undefined,
    }));
  }

  async chatRelayComplete(
    jobId: string,
    ok: boolean,
    error?: string,
    rateLimits?: readonly ChatRelayRateLimitObservation[],
  ): Promise<void> {
    await this.post(`/chat-relay/${jobId}/complete`, {
      ok,
      error: error ?? null,
      // GAP-119: 観測が無いときは送らない (無いものを送らない誠実設計)
      ...(rateLimits && rateLimits.length > 0 ? { rate_limits: rateLimits } : {}),
    });
  }
}
