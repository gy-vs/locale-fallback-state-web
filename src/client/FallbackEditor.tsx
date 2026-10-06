import {useState} from 'react';
import {LOCALES, LOCALE_LABELS, SOURCE_LOCALE, type Locale} from '../shared/locales';

export function FallbackEditor({
  locale,
  chain,
  onSave,
}: {
  locale: Locale;
  chain: Locale[];
  onSave: (chain: Locale[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Locale[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = draft ?? chain;
  const readOnly = locale === SOURCE_LOCALE;

  const candidates = LOCALES.filter(candidate => candidate !== locale && !editing.includes(candidate));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(editing);
      setDraft(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'rejected');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fallback-editor">
      <h3>Fallback chain · {locale}</h3>
      {readOnly ? (
        <p className="muted">English is the source language and has no fallback.</p>
      ) : (
        <>
          <ol className="chain">
            <li className="chain-self">{LOCALE_LABELS[locale]} (own cell)</li>
            {editing.map((entry, index) => (
              <li key={entry} className="chain-entry">
                <span title={LOCALE_LABELS[entry]}>{entry}</span>
                <button
                  type="button"
                  aria-label={`remove ${entry}`}
                  onClick={() => setDraft(editing.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
          {candidates.length > 0 && (
            <select
              value=""
              onChange={event => {
                if (!event.target.value) return;
                setDraft([...editing, event.target.value as Locale]);
              }}
            >
              <option value="">+ add locale to try next…</option>
              {candidates.map(candidate => (
                <option key={candidate} value={candidate}>
                  {candidate} — {LOCALE_LABELS[candidate]}
                </option>
              ))}
            </select>
          )}
          <div className="fallback-actions">
            <button className="primary" type="button" disabled={saving || draft === null} onClick={save}>
              {saving ? 'Saving…' : 'Apply chain'}
            </button>
            {draft !== null && (
              <button type="button" onClick={() => {setDraft(null); setError(null);}}>
                Revert
              </button>
            )}
          </div>
          {error && <p className="form-error" role="alert">⛔ {error}</p>}
          <p className="muted">
            Cycles and self-loops are rejected. An explicit empty translation stops the search;
            only a missing cell continues down the chain.
          </p>
        </>
      )}
    </div>
  );
}
