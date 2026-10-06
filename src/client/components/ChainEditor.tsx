import {useEffect, useState} from 'react';
import {validateChains} from '../../shared/fallback';
import type {FallbackChains, Locale} from '../../shared/types';

/** 回退链编辑：改出环/引用非法语言立刻在本地拒绝。 */
export function ChainEditor({locale, chains, allLocales, onSave}: {
  locale: Locale;
  chains: Record<Locale, Locale[]>;
  allLocales: Locale[];
  onSave: (locale: Locale, chain: Locale[]) => Promise<void>;
}) {
  const current = chains[locale] ?? [];
  const [draft, setDraft] = useState<Locale[]>(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 语言或当前链变了（比如保存成功、切语言），同步草稿
  const signature = locale + '|' + current.join('>');
  useEffect(() => {
    setDraft(current);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  if (locale === 'en') {
    return <p className="hint">en 是源语言，没有回退链。</p>;
  }

  const candidateChain: FallbackChains = {...chains, [locale]: draft};
  const check = validateChains(candidateChain, allLocales);
  const effectiveTail = draft.includes('en') || draft.includes(locale as Locale) ? draft : [...draft, 'en'];
  const dirty = draft.join(',') !== current.join(',');

  const move = (index: number, delta: number) => {
    const next = [...draft];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setDraft(next);
    setError(null);
  };

  return (
    <div className="chain-editor">
      <h3>回退链</h3>
      <p className="hint">
        解析顺序：<strong>{locale}</strong>{effectiveTail.map(loc => <span key={loc}> → {loc}</span>)}
        <br/>链上遇到「明确留空」会立即停止，不会继续回退。
      </p>
      <ol className="chain-list">
        {draft.map((loc, index) => (
          <li key={loc}>
            <span className="chain-order">{index + 1}</span>
            <select
              value={loc}
              onChange={event => {
                const next = [...draft];
                next[index] = event.target.value as Locale;
                setDraft(next);
              }}
            >
              {allLocales.filter(l => l !== locale).map(l => (
                <option key={l} value={l} disabled={draft.includes(l)}>{l}</option>
              ))}
            </select>
            <button type="button" onClick={() => move(index, -1)} disabled={index === 0}>↑</button>
            <button type="button" onClick={() => move(index, 1)} disabled={index === draft.length - 1}>↓</button>
            <button type="button" className="link-danger" onClick={() => setDraft(draft.filter((_, i) => i !== index))}>移除</button>
          </li>
        ))}
      </ol>
      <div className="chain-actions">
        <button
          type="button"
          onClick={() => {
            const next = allLocales.find(l => l !== locale && !draft.includes(l));
            if (next) setDraft([...draft, next]);
          }}
          disabled={draft.length >= allLocales.length - 1}
        >+ 一环</button>
        <button
          type="button"
          className="primary"
          disabled={!dirty || !check.ok || saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await onSave(locale, draft.filter(loc => loc !== locale));
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setSaving(false);
            }
          }}
        >{saving ? '保存中…' : '保存回退链'}</button>
        {dirty && <button type="button" onClick={() => { setDraft(current); setError(null); }}>撤销</button>}
      </div>
      {!check.ok && dirty && <p className="form-error">⛔ {check.error}</p>}
      {error && <p className="form-error">⛔ {error}</p>}
    </div>
  );
}
