import {useEffect, useMemo, useRef, useState} from 'react';
import {validateTranslation} from '../shared/message';
import type {Locale} from '../shared/locales';
import type {KeyRecord, ResolvedCell} from '../shared/model';
import type {SaveStatus} from '../shared/saveQueue';

type Mode = 'present' | 'empty';

export function Editor({
  locale,
  record,
  cell,
  saveStatus,
  onSaveDraft,
  onSaveSource,
  onMarkReviewed,
}: {
  locale: Locale;
  record: KeyRecord;
  cell: ResolvedCell;
  saveStatus: SaveStatus;
  onSaveDraft: (text: string, baseVersion: number) => void;
  onSaveSource: (source: string, baseVersion: number) => Promise<void>;
  onMarkReviewed: () => Promise<void> | void;
}) {
  const stored = record.translations[locale];
  const isSource = locale === 'en';
  const initialText = isSource ? record.source : stored?.text ?? '';
  const [draft, setDraft] = useState(initialText);
  const [mode, setMode] = useState<Mode>(stored && stored.text === '' ? 'empty' : 'present');
  const [reviewing, setReviewing] = useState(false);
  const [savingSource, setSavingSource] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const debounce = useRef<number | null>(null);
  const lastBase = useRef(stored?.version ?? 0);
  const lastSent = useRef<string | null>(null);

  // Re-initialise whenever the cell identity changes (key/locale switch)
  // or a server-confirmed save lands.
  useEffect(() => {
    setDraft(initialText);
    setMode(stored && stored.text === '' ? 'empty' : 'present');
    lastBase.current = stored?.version ?? 0;
    lastSent.current = null;
  }, [record.key, locale, stored?.version, stored?.text, record.source, isSource]);

  const validation = useMemo(() => {
    if (isSource) {
      if (draft.trim() === '') return [];
      return validateTranslation('en', draft, draft);
    }
    if (mode === 'empty') return [];
    return validateTranslation(locale, record.source, draft);
  }, [draft, mode, locale, record.source, isSource]);

  const dirty = isSource
    ? draft !== record.source
    : mode === 'empty'
      ? stored
        ? stored.text !== ''
        : true
      : draft !== (stored?.text ?? '');

  useEffect(() => {
    if (isSource || !dirty || validation.length > 0) return;
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      const text = mode === 'empty' ? '' : draft;
      if (lastSent.current === text) return;
      lastSent.current = text;
      onSaveDraft(text, lastBase.current);
    }, 450);
    return () => {
      if (debounce.current) window.clearTimeout(debounce.current);
    };
  }, [draft, mode, dirty, validation.length, isSource]);

  const setEmpty = (empty: boolean) => {
    const nextMode: Mode = empty ? 'empty' : 'present';
    setMode(nextMode);
    if (empty) {
      const base = stored?.version ?? 0;
      if (!stored || stored.text !== '') onSaveDraft('', base);
    }
  };

  return (
    <div className="editor">
      <div className="editor-head">
        <h2>{record.key}</h2>
        {!isSource && <span className={`save-status status-${saveStatus}`}>{saveStatus}</span>}
      </div>

      {isSource ? (
        <>
          <p className="muted">
            English is the source language. Saving a changed message marks every translation
            “needs review”; pages keep showing the old translations until reviewers confirm them.
          </p>
          <textarea
            aria-label="english source text"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            spellCheck={false}
          />
          {validation.length > 0 && (
            <ul className="validation-errors">
              {validation.map((problem, index) => (
                <li key={index}>⛔ {problem.message}</li>
              ))}
            </ul>
          )}
          {sourceError && <p className="form-error" role="alert">⛔ {sourceError}</p>}
          <div className="fallback-actions">
            <button
              type="button"
              className="primary"
              disabled={!dirty || validation.length > 0 || savingSource}
              onClick={async () => {
                setSavingSource(true);
                setSourceError(null);
                try {
                  await onSaveSource(draft, record.version);
                } catch (caught) {
                  setSourceError(caught instanceof Error ? caught.message : 'save failed');
                } finally {
                  setSavingSource(false);
                }
              }}
            >
              {savingSource ? 'Saving…' : 'Save English source'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            English source:
            <code className="source-text">{record.source}</code>
          </p>

          {cell.needsReview && (
            <div className="review-banner" role="alert">
              <div>
                <strong>Source changed — this translation needs re-review.</strong>
                <p>The page still shows the old translation until you confirm it.</p>
              </div>
              <button
                type="button"
                className="primary"
                disabled={reviewing || validation.length > 0}
                onClick={async () => {
                  setReviewing(true);
                  await onMarkReviewed();
                  setReviewing(false);
                }}
              >
                {reviewing ? 'Confirming…' : 'Translation is still correct'}
              </button>
            </div>
          )}

          <label className="empty-toggle">
            <input type="checkbox" checked={mode === 'empty'} onChange={event => setEmpty(event.target.checked)} />
            Leave this message explicitly empty (show nothing; do not fall back)
          </label>

          {mode === 'present' ? (
            <textarea
              aria-label="translation text"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              spellCheck={false}
            />
          ) : (
            <div className="empty-preview">∅ Nothing is rendered for this locale.</div>
          )}

          {validation.length > 0 && (
            <ul className="validation-errors" aria-label="validation problems">
              {validation.map((problem, index) => (
                <li key={index}>⛔ {problem.message}</li>
              ))}
            </ul>
          )}

          <p className="muted small">
            {dirty && validation.length === 0
              ? 'Autosaves when typing pauses…'
              : 'Placeholders and plural categories must match the English source.'}
          </p>
        </>
      )}
    </div>
  );
}
