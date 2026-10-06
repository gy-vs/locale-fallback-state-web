import {describe, expect, it} from 'vitest';
import {
  dismissConflict,
  enqueue,
  initialQueueState,
  invalidateLocale,
  resetSeq,
  resolveResponse,
  type PendingSave,
} from '../src/shared/saveQueue';
import type {StoredTranslation} from '../src/shared/model';

const cell = (version: number, text: string): StoredTranslation => ({
  text,
  version,
  needsReview: false,
  updatedAt: 0,
});

describe('autosave queue', () => {
  it('coalesces rapid edits into one in-flight + one pending newest save', () => {
    resetSeq();
    let queue = initialQueueState();
    const first = enqueue(queue, {key: 'k', locale: 'fr-CA', text: 'a', baseVersion: 0});
    queue = first.state;
    expect(first.started?.text).toBe('a');

    // typing pauses fire two more saves while "a" is still on the wire
    const second = enqueue(queue, {key: 'k', locale: 'fr-CA', text: 'ab', baseVersion: 0});
    queue = second.state;
    expect(second.started).toBeNull();
    const third = enqueue(queue, {key: 'k', locale: 'fr-CA', text: 'abc', baseVersion: 0});
    queue = third.state;
    // only the newest draft survives as the queued follow-up
    expect(queue.queued?.text).toBe('abc');
  });

  it('a slow response to an older request cannot overwrite a newer save', () => {
    resetSeq();
    let queue = initialQueueState();
    const r1 = enqueue(queue, {key: 'k', locale: 'fr-CA', text: 'old', baseVersion: 0});
    queue = r1.state;
    queue = enqueue(queue, {key: 'k', locale: 'fr-CA', text: 'new', baseVersion: 0}).state;
    // simulate the queue after first completes and second is dispatched
    const ack1 = resolveResponse(queue, r1.started!, {ok: true, cell: cell(1, 'old')});
    queue = ack1.state;
    expect(ack1.started?.text).toBe('new');
    expect(queue.lastSaved?.cell.text).toBe('old');

    // now a hypothetical *duplicate* late response to r1 arrives again;
    // its seq no longer matches in-flight so it must be ignored
    const stale = resolveResponse(queue, r1.started!, {ok: true, cell: cell(9, 'STALE')});
    expect(stale.state).toBe(queue); // state untouched
    expect(stale.state.lastSaved?.cell.text).toBe('old');
  });

  it('409 from an obsolete base version is surfaced as a conflict, not an overwrite', () => {
    resetSeq();
    let queue = initialQueueState();
    const r1 = enqueue(queue, {key: 'k', locale: 'fr-CA', text: 'mine', baseVersion: 0});
    queue = r1.state;
    const ack = resolveResponse(queue, r1.started!, {
      ok: false,
      status: 409,
      current: cell(3, 'their newer text'),
    });
    queue = ack.state;
    expect(queue.status).toBe('conflict');
    expect(queue.conflict?.serverCell.text).toBe('their newer text');
    expect(queue.conflict?.attemptedText).toBe('mine');
    // conflict must not auto-start a queued retry of the stale text
    expect(ack.started).toBeNull();
    expect(dismissConflict(queue).status).toBe('idle');
  });

  it('switching locales invalidates in-flight and queued saves for the old locale', () => {
    resetSeq();
    let queue = initialQueueState();
    const fr = enqueue(queue, {key: 'k', locale: 'fr-CA', text: 'fr-a', baseVersion: 0});
    queue = fr.state;
    queue = enqueue(queue, {key: 'k', locale: 'fr-CA', text: 'fr-b', baseVersion: 0}).state;

    const flushed = invalidateLocale(queue, 'fr-CA');
    queue = flushed.state;
    expect(flushed.forgotten.map(s => s.text)).toEqual(['fr-a', 'fr-b']);
    expect(queue.inFlight).toBeNull();

    // The old request comes back late from the network: dropped entirely.
    const late = resolveResponse(queue, fr.started as PendingSave, {
      ok: true,
      cell: cell(1, 'fr-a should not land'),
    });
    expect(late.state).toBe(queue);
    expect(late.state.lastSaved).toBeNull();
  });

  it('a queued save for a different target is promoted after invalidation', () => {
    resetSeq();
    let queue = initialQueueState();
    const a = enqueue(queue, {key: 'k1', locale: 'fr-CA', text: 'a', baseVersion: 0});
    queue = a.state;
    // different key coalesces into the single queued slot (UI serialises one editor anyway)
    const b = enqueue(queue, {key: 'k2', locale: 'pt-PT', text: 'b', baseVersion: 0});
    queue = b.state;
    const flushed = invalidateLocale(queue, 'fr-CA');
    expect(flushed.started?.key).toBe('k2');
    expect(flushed.started?.locale).toBe('pt-PT');
  });
});
