/**
 * 编辑区自动保存协调器（与 React 解耦的纯逻辑，vitest 可直接测）。
 *
 * 要解决三件事：
 * 1. 打字停顿会连发几次保存，慢网下回来先后不固定 —— seq 单调递增，
 *    只认最后一次输入对应的结果（迟到的旧结果一律忽略）；
 * 2. 两个译者改同一条 —— 服务端按 expectedVersion 回 409，这里上浮成冲突状态，
 *    不覆盖编辑框，等用户决定；
 * 3. 切换语言/消息 —— bumpGeneration() 让上一条编辑流还在路上的结果全部作废，
 *    绝不落到新语言的列表里。
 */

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'conflict' | 'error';

export interface SaveRequest {
  text: string;
  expectedVersion: number | null;
  force: boolean;
}

export interface ServerResponse {
  kind: 'saved' | 'unchanged' | 'superseded';
  version?: number;
  value?: string | null;
  [key: string]: unknown;
}

export type Sender = (
  payload: SaveRequest & {seq: number},
  signal: {aborted: boolean},
) => Promise<{status: number; body: any}>;

export interface CoordinatorState {
  status: SaveStatus;
  /** 最后一次被服务端确认的文本（编辑框同步基准）。 */
  confirmedText: string | null;
  /** 已确认版本。 */
  confirmedVersion: number | null;
  conflict: {serverVersion: number; serverText: string | null; baseText: string; baseVersion: number | null} | null;
  /** 最后一次成功保存对应的 seq；用于判断晚到响应是否过期。 */
  lastAppliedSeq: number;
  /** 自上次成功保存后是否被编辑过。 */
  dirty: boolean;
  /** 已应用的最后结果（UI 列表刷新只接受它）。 */
  lastApplied: {seq: number; body: ServerResponse; text: string} | null;
}

export type CoordinatorListener = (state: CoordinatorState) => void;

export class SaveCoordinator {
  private seq = 0;
  private generation = 0;
  private inFlight: {seq: number; generation: number; aborted: boolean} | null = null;
  private queued: SaveRequest | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private state: CoordinatorState = {
    status: 'idle',
    confirmedText: null,
    confirmedVersion: null,
    conflict: null,
    lastAppliedSeq: 0,
    dirty: false,
    lastApplied: null,
  };
  private listeners = new Set<CoordinatorListener>();

  constructor(private readonly sender: Sender, private readonly debounceMs = 500) {}

  getState(): CoordinatorState {
    return this.state;
  }

  subscribe(listener: CoordinatorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<CoordinatorState>) {
    this.state = {...this.state, ...patch};
    for (const listener of this.listeners) listener(this.state);
  }

  /** 以服务端当前条目初始化（切语言/切消息时调用）。 */
  reset(initial: {text: string | null; version: number | null}) {
    this.cancel();
    this.generation += 1;
    this.seq = 0;
    this.emit({
      status: 'idle',
      confirmedText: initial.text ?? '',
      confirmedVersion: initial.version,
      conflict: null,
      lastAppliedSeq: 0,
      dirty: false,
      lastApplied: null,
    });
  }

  /** 编辑：带 debounce 排一次保存；冲突未解决期间不自动发。 */
  edit(text: string) {
    if (this.state.status === 'conflict') return;
    this.emit({dirty: true, status: 'pending'});
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const request: SaveRequest = {text, expectedVersion: this.state.confirmedVersion, force: false};
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.dispatch(request);
    }, this.debounceMs);
  }

  /** 用户在冲突弹窗里选择「用我的覆盖」。 */
  forceSave(text: string) {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    return this.dispatch({
      text,
      expectedVersion: this.state.confirmedVersion,
      force: true,
    });
  }

  /** 放弃本地改动，采用服务端版本（冲突解决）。 */
  resolveConflictWithServer(): {text: string | null; version: number | null} {
    const conflict = this.state.conflict;
    this.cancel();
    this.emit({
      conflict: null,
      dirty: false,
      status: 'idle',
      confirmedText: conflict?.serverText ?? '',
      confirmedVersion: conflict?.serverVersion ?? null,
    });
    return {text: conflict?.serverText ?? '', version: conflict?.serverVersion ?? null};
  }

  /** 作废当前编辑流（切换语言/消息），路上的响应回来后全部忽略。 */
  bumpGeneration() {
    this.cancel();
    this.generation += 1;
    this.seq = 0;
  }

  private cancel() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.queued = null;
    if (this.inFlight) this.inFlight.aborted = true;
    this.inFlight = null;
  }

  private async dispatch(request: SaveRequest) {
    if (this.inFlight) {
      // 同一时刻只保留最新一次输入，旧的排队请求被顶掉
      this.queued = request;
      this.emit({status: 'pending'});
      return;
    }
    const seq = ++this.seq;
    const generation = this.generation;
    const ticket = {seq, generation, aborted: false};
    this.inFlight = ticket;
    this.emit({status: 'saving'});
    let response: {status: number; body: any};
    try {
      response = await this.sender({...request, seq}, {get aborted() { return ticket.aborted; }});
    } catch (e) {
      if (ticket.aborted || generation !== this.generation) return;
      if (this.inFlight === ticket) this.inFlight = null;
      this.emit({status: 'error'});
      return;
    }
    if (ticket.aborted || generation !== this.generation) return;
    this.inFlight = null;

    // 迟到的旧响应：seq 已落后于已派发的最大值 → 忽略，绝不能覆盖编辑框
    if (seq < this.seq) {
      const queued = this.queued;
      this.queued = null;
      if (queued) void this.dispatch(queued);
      return;
    }

    if (response.status === 409) {
      this.emit({
        status: 'conflict',
        conflict: {
          serverVersion: response.body.currentVersion ?? null,
          serverText: response.body.serverValue ?? null,
          baseText: request.text,
          baseVersion: request.expectedVersion,
        },
      });
      return;
    }
    if (response.status >= 400) {
      this.emit({status: 'error'});
      return;
    }

    const body = response.body as ServerResponse;
    if (body.kind === 'superseded') {
      // 服务端确认这是迟到请求，保持当前已确认结果不动
      this.emit({status: 'saved', dirty: false});
    } else {
      this.emit({
        status: 'saved',
        dirty: false,
        confirmedText: body.value === undefined ? request.text : (body.value ?? ''),
        confirmedVersion: body.version ?? this.state.confirmedVersion,
        lastAppliedSeq: seq,
        lastApplied: {seq, body, text: request.text},
      });
    }
    const queued = this.queued;
    this.queued = null;
    if (queued) void this.dispatch(queued);
  }

  dispose() {
    this.cancel();
    this.listeners.clear();
  }
}
