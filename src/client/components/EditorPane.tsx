import {useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {SaveCoordinator, type SaveStatus} from '../saveCoordinator';
import type {Locale} from '../../shared/types';
import {tryParse, validateTranslation} from '../../shared/message';
import {render} from '../../shared/message';

/** 从消息结构里推断预览用的示例变量。 */
function sampleValues(text: string, locale: Locale): Record<string, number | string> {
  const parsed = tryParse(text);
  if (!parsed.ast) return {name: 'Ari', count: 1};
  const values: Record<string, number | string> = {};
  const walk = (nodes: typeof parsed.ast) => {
    for (const node of nodes) {
      if (node.kind === 'arg' && node.name !== '#') values[node.name] = node.name === 'name' ? 'Ari' : 1;
      if (node.kind === 'plural') {
        values[node.arg] = 1;
        for (const option of node.options) walk(option.body);
      }
    }
  };
  walk(parsed.ast);
  void locale;
  return values;
}

export function EditorPane({
  locale, messageKey, sourceText, sourceVersion, initialValue, initialVersion, stale, isSource,
  onSave, onSaveSource, onReview, onApplied,
}: {
  locale: Locale;
  messageKey: string;
  sourceText: string;
  sourceVersion: number;
  initialValue: string;
  initialVersion: number | null;
  stale: boolean;
  isSource: boolean;
  onSave: (payload: {
    value: string | null; expectedVersion: number | null; editor: number; seq: number; force?: boolean;
  }) => Promise<{status: number; body: any}>;
  onSaveSource: (text: string) => Promise<unknown>;
  onReview: () => Promise<void>;
  onApplied: () => void;
}) {
  const editorId = useRef(Math.floor(Math.random() * 1_000_000)).current;
  const coordinator = useMemo(
    () => new SaveCoordinator((req, signal) => {
      void signal;
      return onSave({value: req.text, expectedVersion: req.expectedVersion, editor: editorId, seq: req.seq, force: req.force});
    }, 600),
    // coordinator 只随「语言 × 消息」重建：切语言时旧流的回调自然全部走不到新实例
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, messageKey],
  );
  const [state, forceState] = useReducer((s: ReturnType<SaveCoordinator['getState']>) => coordinator.getState(), coordinator.getState());
  const [draft, setDraft] = useState(initialValue);
  const [blank, setBlank] = useState(initialValue === '' && initialVersion !== null);
  const [sourceDraft, setSourceDraft] = useState(sourceText);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceSaving, setSourceSaving] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);

  // 只在切换语言/消息时同步基准（组件本身也由 App 的 key 强制重挂）。
  // 不能依赖 initialVersion：保存落地会改版本，若此时译者还在继续打字，reset 会冲掉新输入。
  useEffect(() => {
    coordinator.reset({text: initialValue, version: initialVersion});
    setDraft(initialValue);
    setBlank(initialValue === '' && initialVersion !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, messageKey]);

  useEffect(() => coordinator.subscribe(() => forceState()), [coordinator]);
  useEffect(() => () => coordinator.dispose(), [coordinator]);

  useEffect(() => {
    if (state.lastApplied) onApplied();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lastAppliedSeq]);

  useEffect(() => {
    setSourceDraft(sourceText);
  }, [messageKey, sourceText]);

  const diagnostics = useMemo(
    () => (isSource || blank ? [] : validateTranslation(sourceText, draft, locale)),
    [sourceText, draft, locale, isSource, blank],
  );

  const samples = useMemo(() => sampleValues(isSource ? sourceDraft : (blank ? sourceText : draft), locale),
    [isSource, sourceDraft, draft, blank, sourceText, locale]);
  const [values, setValues] = useState<Record<string, number | string>>(samples);
  useEffect(() => setValues(samples), [JSON.stringify(samples)]);

  const statusLabel: Record<SaveStatus, string> = {
    idle: '—', pending: '等待输入停顿…', saving: '保存中…', saved: '已保存',
    conflict: '⚠ 冲突', error: '保存失败',
  };

  if (isSource) {
    return (
      <div className="editor">
        <div className="toolbar">
          <span className="pill">en · 源文案</span>
          <button className="primary" disabled={sourceDraft === sourceText || sourceSaving} onClick={async () => {
            setSourceSaving(true);
            setSourceError(null);
            try {
              await onSaveSource(sourceDraft);
            } catch (e) {
              setSourceError(e instanceof Error ? e.message : String(e));
            } finally {
              setSourceSaving(false);
            }
          }}>{sourceSaving ? '保存中…' : '保存英文原文'}</button>
          <span className="status">{sourceDraft !== sourceText ? '有未保存修改' : `已发布 v${sourceVersion}`}</span>
        </div>
        <textarea value={sourceDraft} onChange={e => setSourceDraft(e.target.value)} />
        {sourceError && <p className="form-error">⛔ {sourceError}</p>}
        <p className="hint">保存后，其他语言这条译文会全部变成「待复核」；复核之前解析仍给出旧译文。</p>
        <Preview text={sourceDraft} locale="en" values={values} onValues={setValues} />
      </div>
    );
  }

  return (
    <div className="editor">
      <div className="toolbar">
        <span className="pill">{locale}</span>
        <label className="check"><input type="checkbox" checked={blank} onChange={e => {
          const nextBlank = e.target.checked;
          setBlank(nextBlank);
          if (nextBlank) coordinator.edit('');
          else coordinator.edit(draft);
        }}/> 明确留空（不显示，且阻断回退）</label>
        {stale && !blank && (
          <button disabled={reviewBusy} onClick={async () => { setReviewBusy(true); try { await onReview(); } finally { setReviewBusy(false); } }}>
            {reviewBusy ? '…' : '✓ 标记复核通过'}
          </button>
        )}
        <span className={`status save-status ${state.status}`}>{statusLabel[state.status]}</span>
      </div>

      {stale && <p className="stale-banner">英文原文已更新（v{sourceVersion}），这条译文待复核。复核前线上仍显示下方旧译文。</p>}

      <textarea
        value={blank ? '' : draft}
        disabled={blank}
        placeholder={blank ? '该语言选择不显示这条消息（明确留空，回退到此为止）' : '输入译文…'}
        onChange={e => { setDraft(e.target.value); coordinator.edit(e.target.value); }}
      />

      {diagnostics.length > 0 && (
        <ul className="diagnostics">
          {diagnostics.map((d, i) => (
            <li key={i} className={d.level === 'error' ? 'diag-error' : 'diag-warning'}>
              {d.level === 'error' ? '⛔' : '⚠'} {d.message}
            </li>
          ))}
        </ul>
      )}

      <Preview text={blank ? '' : draft} locale={locale} values={values} onValues={setValues} />

      {state.conflict && (
        <div className="conflict-modal" role="dialog" aria-label="保存冲突">
          <h3>保存冲突</h3>
          <p>你基于 v{state.conflict.baseVersion ?? '?'} 的译文还没保存，另一位译者已经保存了新版本。</p>
          <div className="conflict-cols">
            <div><h4>你的内容</h4><pre>{state.conflict.baseText}</pre></div>
            <div><h4>服务端最新</h4><pre>{state.conflict.serverText ?? ''}</pre></div>
          </div>
          <div className="conflict-actions">
            <button className="primary" onClick={() => { void coordinator.forceSave(draft); }}>用我的覆盖</button>
            <button onClick={() => {
              const resolved = coordinator.resolveConflictWithServer();
              setDraft(resolved.text ?? '');
            }}>采用服务端版本</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Preview({text, locale, values, onValues}: {
  text: string;
  locale: Locale;
  values: Record<string, number | string>;
  onValues: (next: Record<string, number | string>) => void;
}) {
  const parsed = tryParse(text);
  const rendered = parsed.ast && text !== '' ? render(parsed.ast, values, locale) : null;
  return (
    <div className="preview">
      <h3>复数 / 占位符预览</h3>
      {parsed.error
        ? <p className="form-error">⛔ {parsed.error.message}</p>
        : text === ''
          ? <p className="hint">∅ 空文案：渲染结果为空，且不会再向回退链继续找。</p>
          : (
            <>
              <div className="preview-inputs">
                {Object.keys(values).map(name => (
                  <label key={name}>{name}
                    <input
                      value={String(values[name])}
                      onChange={e => onValues({...values, [name]: /^-?\d+(\.\d+)?$/.test(e.target.value) ? Number(e.target.value) : e.target.value})}
                    />
                  </label>
                ))}
              </div>
              <p className="preview-output">{rendered!.text || <em>（空）</em>}</p>
              {rendered!.missingArgs.length > 0 && <p className="diag-warning">缺少变量：{rendered!.missingArgs.join(', ')}</p>}
            </>
          )}
    </div>
  );
}
