import type {Locale} from './locales';
import type {StoredTranslation} from './model';

/**
 * The autosave queue is a small framework-free state machine. The editor
 * feeds in drafts as the translator pauses typing; the UI layer is the
 * "driver" that performs the actual fetch and pumps responses back.
 *
 * Guarantees:
 *  - in-flight requests are single-flight: while one is travelling, newer
 *    drafts collapse onto a single pending request carrying the NEWEST text
 *    (with the newest base version), so slow/returning-out-of-order network
 *    responses cannot make older text win;
 *  - switchLocale() invalidates every request that was editing the old
 *    locale, so a late response never lands in another locale's list;
 *  - a 409 response from a request based on an obsolete version is exposed
 *    as a conflict for the UI to resolve instead of silently overwriting.
 */

export interface PendingSave {
  key: string;
  locale: Locale;
  text: string;
  baseVersion: number;
  /** Monotonic per-queue request number; newest must win. */
  seq: number;
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

export interface ConflictInfo {
  key: string;
  locale: Locale;
  serverCell: StoredTranslation;
  /** Text the losing request was trying to save. */
  attemptedText: string;
}

export interface QueueState {
  inFlight: PendingSave | null;
  queued: PendingSave | null;
  status: SaveStatus;
  conflict: ConflictInfo | null;
  lastSaved: {key: string; locale: Locale; cell: StoredTranslation} | null;
}

export function initialQueueState(): QueueState {
  return {inFlight: null, queued: null, status: 'idle', conflict: null, lastSaved: null};
}

let counter = 0;
export function resetSeq(): void {
  counter = 0;
}

/** Enqueue (or coalesce) a draft. Returns the next request to start, if any. */
export function enqueue(
  state: QueueState,
  draft: Omit<PendingSave, 'seq'>,
): {
  state: QueueState;
  started: PendingSave | null;
} {
  const pending: PendingSave = {...draft, seq: ++counter};
  if (state.inFlight) {
    // Latest keystroke wins; any older queued draft for this target is replaced.
    return {
      state: {...state, queued: pending, status: 'saving', conflict: state.conflict},
      started: null,
    };
  }
  return {state: {...state, inFlight: pending, status: 'saving'}, started: pending};
}

export interface SaveResponse {
  ok: boolean;
  cell?: StoredTranslation;
  current?: StoredTranslation;
  status?: number;
}

/**
 * Apply one network response. `request` is the save it answers; the queue
 * remembers which request it belongs to so stale responses can be dropped.
 */
export function resolveResponse(
  state: QueueState,
  request: PendingSave,
  response: SaveResponse,
): {state: QueueState; started: PendingSave | null} {
  // Response belongs to a previous locale session: ignore completely.
  if (state.inFlight?.seq !== request.seq) {
    return {state, started: null};
  }
  const queued = state.queued;
  if (response.ok && response.cell) {
    const next: QueueState = {
      ...state,
      inFlight: queued,
      queued: null,
      conflict: null,
      lastSaved: {key: request.key, locale: request.locale, cell: response.cell},
      status: queued ? 'saving' : 'saved',
    };
    return {state: next, started: queued};
  }
  if (response.status === 409 && response.current) {
    return {
      state: {
        ...state,
        inFlight: queued,
        queued: null,
        status: 'conflict',
        conflict: {
          key: request.key,
          locale: request.locale,
          serverCell: response.current,
          attemptedText: request.text,
        },
        lastSaved: null,
      },
      // A conflict must not be papered over by a queued retry of stale text.
      started: null,
    };
  }
  return {
    state: {...state, inFlight: queued, queued: null, status: 'error'},
    started: queued,
  };
}

/**
 * Forget everything that was editing `locale` (or a specific key within it).
 * A response for a forgotten request is treated as belonging to nobody. If a
 * queued save for another target survives, it is promoted and returned as
 * `started` so the driver can dispatch it immediately.
 */
export function invalidateLocale(state: QueueState, locale: Locale, key?: string): {
  state: QueueState;
  forgotten: PendingSave[];
  started: PendingSave | null;
} {
  const matches = (save: PendingSave | null) =>
    save !== null && save.locale === locale && (key === undefined || save.key === key);
  const forgotten: PendingSave[] = [];
  let inFlight = state.inFlight;
  let queued = state.queued;
  if (matches(inFlight)) {
    forgotten.push(inFlight!);
    inFlight = null;
  }
  let started: PendingSave | null = null;
  if (matches(queued)) {
    forgotten.push(queued!);
    queued = null;
  } else if (!inFlight && queued) {
    // A queued save for a different target gets promoted.
    started = queued;
    inFlight = queued;
    queued = null;
  }
  return {
    state: {
      ...state,
      inFlight,
      queued,
      status: inFlight ? 'saving' : state.status === 'saving' ? 'idle' : state.status,
    },
    forgotten,
    started,
  };
}

/** Clear a conflict after the translator chooses how to resolve it. */
export function dismissConflict(state: QueueState): QueueState {
  return {...state, conflict: null, status: state.inFlight ? 'saving' : 'idle'};
}
