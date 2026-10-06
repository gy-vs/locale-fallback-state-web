import type {LocaleRow} from '../api';

function StateBadge({row}: {row: LocaleRow}) {
  if (row.ownState === 'blank') return <span className="badge blank">明确留空</span>;
  if (row.ownState === 'text') return <span className="badge own">已翻译</span>;
  return <span className="badge missing">没翻</span>;
}

/** 左侧：每条消息在当前语言下的状态与实际来源。 */
export function MessageList({rows, selectedKey, onSelect}: {
  rows: LocaleRow[];
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="list">
      {rows.map(row => (
        <button key={row.key} className={`list-row ${selectedKey === row.key ? 'active' : ''}`} onClick={() => onSelect(row.key)}>
          <div className="list-row-head">
            <code>{row.key}</code>
            <StateBadge row={row}/>
          </div>
          <div className="list-row-text">{row.text === '' ? '∅（有意不显示）' : (row.text ?? '—')}</div>
          <div className="list-row-meta">
            {row.via === 'fallback' && <span className="from-fallback">来自回退：{row.source}</span>}
            {row.via === 'own' && <span className="from-own">来源：{row.source}</span>}
            {row.stale && <span className="stale-tag">待复核</span>}
          </div>
        </button>
      ))}
    </div>
  );
}
