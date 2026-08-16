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
}

export interface BridgeApi {
  pick(workerPid: number, projectId?: string): Promise<KanbanPickResult>;
  /** GAP-114: チャット中継 job を 1 件確保 (無ければ null)。 */
  chatRelayPick(workerId: string): Promise<ChatRelayPicked | null>;
  /** GAP-114: text delta を追記 (seqStart からの連番)。 */
  chatRelayChunks(jobId: string, seqStart: number, texts: readonly string[]): Promise<void>;
  /** GAP-114: job を done / error で確定。 */
  chatRelayComplete(jobId: string, ok: boolean, error?: string): Promise<void>;
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

  async chatRelayPick(workerId: string): Promise<ChatRelayPicked | null> {
    const json = (await this.post('/chat-relay/pick', { worker_id: workerId })) as {
      data: {
        job_id: string | null;
        system_prompt: string | null;
        prompt: string | null;
        no_available_job: boolean;
      };
    };
    const d = json.data;
    if (d.no_available_job || d.job_id === null) return null;
    return {
      jobId: d.job_id,
      systemPrompt: d.system_prompt ?? '',
      prompt: d.prompt ?? '',
    };
  }

  async chatRelayChunks(
    jobId: string,
    seqStart: number,
    texts: readonly string[],
  ): Promise<void> {
    await this.post(`/chat-relay/${jobId}/chunks`, {
      seq_start: seqStart,
      texts: [...texts],
    });
  }

  async chatRelayComplete(jobId: string, ok: boolean, error?: string): Promise<void> {
    await this.post(`/chat-relay/${jobId}/complete`, {
      ok,
      error: error ?? null,
    });
  }
}
