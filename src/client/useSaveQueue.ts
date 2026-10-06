import {useCallback, useEffect, useRef, useState} from 'react';
import type {Locale} from '../shared/locales';
import type {StoredTranslation} from '../shared/model';
import {
  dismissConflict,
  enqueue,
  initialQueueState,
  invalidateLocale,
  resolveResponse,
  type ConflictInfo,
  type PendingSave,
  type QueueState,
  type SaveStatus,
} from '../shared/saveQueue';
import {api} from './api';

export interface SaveController {
  status: SaveStatus;
  conflict: ConflictInfo | null;
  /** Ask the driver to persist a draft; coalesces rapid typing. */
  scheduleSave: (key: string, locale: Locale, text: string, baseVersion: number) => void;
  /** Forget all saves targeting one locale (used on locale switch). */
  flushLocale: (locale: Locale) => void;
  /** Called after the translator decides how to handle a 409. */
  clearConflict: () => void;
}

type Fetcher = (save: PendingSave) => Promise<{
  ok: boolean;
  cell?: StoredTranslation;
  current?: StoredTranslation;
  status?: number;
}>;

const defaultFetcher: Fetcher = async save => {
  try {
    const response = await api.saveTranslation(save.key, save.locale, save.text, save.baseVersion);
    return {ok: true, cell: response.cell};
  } catch (error) {
    const status = (error as {status?: number}).status;
    const current = (error as {body?: {current?: StoredTranslation}}).body?.current;
    return {ok: false, status, current};
  }
};

/**
 * Owns the autosave queue for the editor surface. Responses are applied
 * only when their seq is still the active one, so an old slow response
 * cannot overwrite a newer one; switching locales invalidates every save
 * targeting the old locale and their late responses are dropped too.
 */
export function useSaveQueue(options: {
  onSaved: (key: string, locale: Locale, cell: StoredTranslation) => void;
  fetcher?: Fetcher;
}): SaveController {
  const stateRef = useRef<QueueState>(initialQueueState());
  const [, force] = useState(0);
  const onSavedRef = useRef(options.onSaved);
  onSavedRef.current = options.onSaved;
  const fetcherRef = useRef<Fetcher>(options.fetcher ?? defaultFetcher);
  fetcherRef.current = options.fetcher ?? defaultFetcher;

  const start = useCallback((request: PendingSave | null) => {
    if (!request) return;
    fetcherRef.current(request).then(response => {
      // The request may have been invalidated by a locale switch: the
      // state machine then no longer holds its seq, so the result is noise.
      const result = resolveResponse(stateRef.current, request, response);
      stateRef.current = result.state;
      force(tick => tick + 1);
      if (response.ok && response.cell) {
        onSavedRef.current(request.key, request.locale, response.cell);
      }
      start(result.started);
    });
  }, []);

  const scheduleSave = useCallback(
    (key: string, locale: Locale, text: string, baseVersion: number) => {
      const {state, started} = enqueue(stateRef.current, {key, locale, text, baseVersion});
      stateRef.current = state;
      force(tick => tick + 1);
      start(started);
    },
    [start],
  );

  const flushLocale = useCallback(
    (locale: Locale) => {
      const {state, started} = invalidateLocale(stateRef.current, locale);
      stateRef.current = state;
      force(tick => tick + 1);
      // If the invalidated in-flight request had collapsed a newer draft
      // for the SAME locale, it would already have been forgotten too.
      // `started` is only set when a different locale's queued save is
      // promoted, so it is safe to dispatch.
      start(started);
    },
    [start],
  );

  const clearConflict = useCallback(() => {
    stateRef.current = dismissConflict(stateRef.current);
    force(tick => tick + 1);
  }, []);

  useEffect(
    () => () => {
      stateRef.current = initialQueueState();
    },
    [],
  );

  return {
    status: stateRef.current.status,
    conflict: stateRef.current.conflict,
    scheduleSave,
    flushLocale,
    clearConflict,
  };
}
