import {useCallback, useEffect, useMemo, useState} from 'react';
import {Languages} from 'lucide-react';
import {api, type MessageDetail, type WorkbenchState} from './api';
import type {Locale} from '../shared/types';
import {CompletionBar} from './components/CompletionBar';
import {MessageList} from './components/MessageList';
import {ChainEditor} from './components/ChainEditor';
import {EditorPane} from './components/EditorPane';

export default function App() {
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [locale, setLocale] = useState<Locale>('fr-CA');
  const [selectedKey, setSelectedKey] = useState('greeting');
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    const next = await api.state();
    setState(next);
    return next;
  }, []);

  const refreshDetail = useCallback(async (key = selectedKey) => {
    setDetail(await api.message(key));
  }, [selectedKey]);

  useEffect(() => { void refreshState(); }, [refreshState]);
  useEffect(() => { void refreshDetail(selectedKey); }, [refreshDetail, selectedKey]);

  const currentView = state?.perLocale[locale];
  const selectedRow = currentView?.rows.find(r => r.key === selectedKey);

  // 切语言：顶部、列表、统计都随 /api/state 重新取；在路上的保存回调绑定在旧 coordinator 上，
  // 不会写入新语言（coordinator 按 locale×key 重建）。
  const switchLocale = useCallback((next: Locale) => {
    setLocale(next);
    setError(null);
  }, []);

  const entry = detail?.entries[locale];
  const isSource = locale === 'en';
  const initialValue = isSource ? (detail?.sourceText ?? '') : (entry?.value ?? '');
  const initialVersion = isSource ? (detail?.sourceVersion ?? null) : (entry?.version ?? null);
  const stale = !isSource && Boolean(entry?.stale);

  const saveTranslation = useCallback(async (payload: {
    value: string | null; expectedVersion: number | null; editor: number; seq: number; force?: boolean;
  }) => {
    const response = await api.saveTranslation(selectedKey, locale, payload);
    if (response.status === 200) {
      // 成功才刷新全局状态；superseded（迟到请求）也刷新一次拿真版本，但编辑框由 coordinator 忽略
      await refreshState();
      await refreshDetail();
    }
    return response;
  }, [selectedKey, locale, refreshState, refreshDetail]);

  const saveSource = useCallback(async (text: string) => {
    await api.saveSource(selectedKey, text);
    await refreshState();
    await refreshDetail();
  }, [selectedKey, refreshState, refreshDetail]);

  const review = useCallback(async () => {
    await api.review(selectedKey, locale);
    await refreshState();
    await refreshDetail();
  }, [selectedKey, locale, refreshState, refreshDetail]);

  const saveChain = useCallback(async (loc: Locale, chain: Locale[]) => {
    // 返回的就是全新 /api/state：列表、完成度、解析立刻全用新链，没有旧结果残留
    const next = await api.setChain(loc, chain);
    setState(next);
  }, []);

  const resolvedInfo = useMemo(() => {
    if (!state || !detail) return null;
    const row = state.perLocale[locale].rows.find(r => r.key === detail.key);
    return row ?? null;
  }, [state, detail, locale]);

  if (!state) return <main className="shell"><p className="loading">加载工作台…</p></main>;

  return (
    <main className="shell">
      <header className="topbar">
        <Languages size={20}/>
        <span className="brand">Locale Workbench</span>
        <small>翻译状态 · 回退链 · 复数（自写解析）</small>
      </header>

      <CompletionBar stats={state.stats} active={locale} onSelect={switchLocale}/>

      <section className="workspace">
        <aside className="pane">
          <div className="toolbar">
            <select value={locale} onChange={e => switchLocale(e.target.value as Locale)}>
              {state.locales.map(loc => <option key={loc} value={loc}>{loc}</option>)}
            </select>
          </div>
          <MessageList
            rows={currentView?.rows ?? []}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
          />
          <div className="chain-wrap">
            <ChainEditor
              locale={locale}
              chains={state.chains}
              allLocales={state.locales}
              onSave={saveChain}
            />
          </div>
        </aside>

        <section className="pane editor-pane">
          {detail && (
            <EditorPane
              key={`${locale}|${detail.key}`}
              locale={locale}
              messageKey={detail.key}
              sourceText={detail.sourceText}
              sourceVersion={detail.sourceVersion}
              initialValue={initialValue}
              initialVersion={initialVersion}
              stale={stale}
              isSource={isSource}
              onSave={saveTranslation}
              onSaveSource={saveSource}
              onReview={review}
              onApplied={() => undefined}
            />
          )}
          {error && <p className="form-error">{error}</p>}
        </section>

        <section className="pane">
          <h2>解析结果</h2>
          {resolvedInfo && (
            <>
              <p className="pill">{locale}</p>
              <dl className="resolve-grid">
                <dt>key</dt><dd><code>{resolvedInfo.key}</code></dd>
                <dt>最终文本</dt><dd>{resolvedInfo.text === '' ? <em>∅ 空（明确留空）</em> : (resolvedInfo.text ?? '—')}</dd>
                <dt>实际来源</dt><dd><strong>{resolvedInfo.source ?? '无'}</strong>{resolvedInfo.via === 'fallback' && <span className="from-fallback">（回退）</span>}</dd>
                <dt>回退链</dt><dd>{[locale, ...state.chains[locale]].join(' → ')}</dd>
                <dt>待复核</dt><dd>{resolvedInfo.stale ? '是（仍显示旧译文）' : '否'}</dd>
              </dl>
            </>
          )}
          {selectedRow && (
            <div className="stat-cards">
              <div className="stat-card"><span>{currentView?.stats.ownText}</span><label>自身译文</label></div>
              <div className="stat-card warn"><span>{currentView?.stats.fallbackCount}</span><label>靠回退才有</label></div>
              <div className="stat-card"><span>{currentView?.stats.intentionalBlank}</span><label>明确留空</label></div>
              <div className="stat-card danger"><span>{currentView?.stats.stale}</span><label>待复核</label></div>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
