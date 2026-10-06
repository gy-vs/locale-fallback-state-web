import {describe, expect, it, vi, afterEach} from 'vitest';
import {SaveCoordinator, type Sender} from '../src/client/saveCoordinator';

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

function setup(debounceMs = 100) {
  const calls: Array<{seq: number; text: string; force: boolean}> = [];
  const inflight = new Map<number, ReturnType<typeof deferred<{status: number; body: any}>>>();
  const sender: Sender = (payload) => {
    calls.push({seq: payload.seq, text: payload.text, force: payload.force});
    const d = deferred<{status: number; body: any}>();
    inflight.set(payload.seq, d);
    return d.promise;
  };
  const coordinator = new SaveCoordinator(sender, debounceMs);
  return {coordinator, calls, inflight};
}

describe('SaveCoordinator', () => {
  it('debounces edits and only the latest queued text gets sent', async () => {
    vi.useFakeTimers();
    const {coordinator, calls, inflight} = setup();
    coordinator.reset({text: '', version: 1});
    coordinator.edit('a');
    coordinator.edit('ab');
    coordinator.edit('abc');
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.map(c => c.text)).toEqual(['abc']);

    inflight.get(1)!.resolve({status: 200, body: {kind: 'saved', value: 'abc', version: 2}});
    await vi.runAllTimersAsync();
    expect(coordinator.getState().confirmedText).toBe('abc');
    expect(coordinator.getState().confirmedVersion).toBe(2);
  });

  it('responses arriving out of order leave the latest input as final', async () => {
    vi.useFakeTimers();
    const {coordinator, calls, inflight} = setup();
    coordinator.reset({text: '', version: 1});

    coordinator.edit('first');
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.at(-1)?.seq).toBe(1);

    // 第一次还在飞，第二次编辑排队；第一次回来后立刻发排队的
    coordinator.edit('second');
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.at(-1)?.seq).toBe(1); // 仍在飞，还没发第二个
    inflight.get(1)!.resolve({status: 200, body: {kind: 'saved', value: 'first', version: 2}});
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.at(-1)?.seq).toBe(2);

    // 乱序：seq2 的响应先给最终态，这里模拟只有一个在飞；seq1 已先回 ——
    // 关键断言：迟到响应（seq < 当前 seq）被忽略。再排第三发。
    coordinator.edit('third');
    await vi.advanceTimersByTimeAsync(200);
    inflight.get(2)!.resolve({status: 200, body: {kind: 'saved', value: 'second', version: 3}});
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.at(-1)?.seq).toBe(3);
    // 假设 seq3 的响应在传输中，此时一个迟到的旧回执（比如服务端 superseded）到达
    inflight.get(3)!.resolve({status: 200, body: {kind: 'saved', value: 'third', version: 4}});
    await Promise.resolve();
    expect(coordinator.getState().confirmedText).toBe('third');
  });

  it('a stale edit stream never lands after switching language', async () => {
    vi.useFakeTimers();
    const {coordinator, inflight} = setup();
    coordinator.reset({text: '', version: 1});
    coordinator.edit('fr-CA in flight');
    await vi.advanceTimersByTimeAsync(200);

    // 译者切语言：旧流作废
    coordinator.bumpGeneration();
    coordinator.reset({text: '', version: 9});
    let appliedAfterSwitch = 0;
    coordinator.subscribe(state => { if (state.lastApplied) appliedAfterSwitch += 1; });
    coordinator.edit('pt-PT typing');

    // 旧语言的响应这时才回来
    inflight.get(1)!.resolve({status: 200, body: {kind: 'saved', value: 'fr-CA in flight', version: 2}});
    await Promise.resolve();
    expect(coordinator.getState().confirmedVersion).toBe(9);
    expect(coordinator.getState().confirmedText).toBe('');
  });

  it('409 conflict pauses autosave and offers overwrite or server version', async () => {
    vi.useFakeTimers();
    const {coordinator, calls, inflight} = setup();
    coordinator.reset({text: 'old', version: 5});
    coordinator.edit('mine');
    await vi.advanceTimersByTimeAsync(200);
    inflight.get(1)!.resolve({
      status: 409,
      body: {kind: 'conflict', currentVersion: 6, serverValue: 'theirs'},
    });
    await Promise.resolve();
    expect(coordinator.getState().status).toBe('conflict');
    expect(coordinator.getState().conflict?.serverText).toBe('theirs');

    // 冲突期间再打字不会自动发
    coordinator.edit('mine again');
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1);

    // 覆盖：force 发送
    const forced = coordinator.forceSave('mine again');
    await Promise.resolve();
    expect(calls.at(-1)).toMatchObject({force: true, text: 'mine again'});
    inflight.get(2)!.resolve({status: 200, body: {kind: 'saved', value: 'mine again', version: 7}});
    await forced;
    expect(coordinator.getState().status).toBe('saved');
    expect(coordinator.getState().confirmedText).toBe('mine again');
  });

  it('user can take the server version to resolve a conflict', async () => {
    vi.useFakeTimers();
    const {coordinator, inflight} = setup();
    coordinator.reset({text: 'old', version: 5});
    coordinator.edit('mine');
    await vi.advanceTimersByTimeAsync(200);
    inflight.get(1)!.resolve({status: 409, body: {currentVersion: 6, serverValue: 'theirs'}});
    await Promise.resolve();
    const resolved = coordinator.resolveConflictWithServer();
    expect(resolved).toEqual({text: 'theirs', version: 6});
    expect(coordinator.getState().status).toBe('idle');
  });
});
