import {useEffect, useState} from 'react';
import type {Locale} from '../shared/locales';
import {formatMessage} from '../shared/message';
import {api, type ResolveResult} from './api';

export function PreviewPane({locale, entryKey, text}: {locale: Locale; entryKey: string; text: string}) {
  const [count, setCount] = useState(0);
  const [name, setName] = useState('Ari');
  const [serverResult, setServerResult] = useState<ResolveResult | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const values = {count, name};
  const localRender = text ? formatMessage(text, locale, values) : '';

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .resolve(locale, entryKey, values)
        .then(result => {
          if (!cancelled) {
            setServerResult(result);
            setServerError(null);
          }
        })
        .catch(error => !cancelled && setServerError(error instanceof Error ? error.message : 'resolve failed'));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [locale, entryKey, count, name, text]);

  return (
    <div className="preview-pane">
      <h3>Live preview</h3>
      <div className="preview-controls">
        <label>
          count
          <input
            type="number"
            value={count}
            onChange={event => setCount(Number(event.target.value))}
          />
        </label>
        <label>
          name
          <input value={name} onChange={event => setName(event.target.value)} />
        </label>
      </div>

      <div className="rendered">
        <span className="muted">rendered</span>
        <p>{localRender || <em className="muted">(nothing)</em>}</p>
      </div>

      <h3>Resolve API</h3>
      {serverError ? (
        <p className="form-error">{serverError}</p>
      ) : serverResult ? (
        <dl className="resolve-details">
          <dt>status</dt>
          <dd>{serverResult.status}</dd>
          <dt>sourceLocale</dt>
          <dd>
            {serverResult.sourceLocale} ({serverResult.sourceKind})
          </dd>
          <dt>rendered</dt>
          <dd>{serverResult.rendered || <em className="muted">(empty)</em>}</dd>
          <dt>needsReview</dt>
          <dd>{String(serverResult.needsReview)}</dd>
        </dl>
      ) : (
        <p className="muted">resolving…</p>
      )}
    </div>
  );
}
