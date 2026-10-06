import type {ResolvedCell} from '../shared/model';
import type {LocaleStats} from '../shared/resolve';

const STATUS_BADGE: Record<ResolvedCell['status'], {label: string; className: string}> = {
  present: {label: 'translated', className: 'badge-present'},
  empty: {label: 'explicit empty', className: 'badge-empty'},
  missing: {label: 'not translated', className: 'badge-missing'},
};

export function KeyList({
  cells,
  selectedKey,
  stats,
  onSelect,
}: {
  cells: ResolvedCell[];
  selectedKey: string;
  stats: LocaleStats;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="key-list-col">
      <div className="completion-card">
        <div className="completion-row">
          <span>Completion (fallback included)</span>
          <strong>{stats.completion}%</strong>
        </div>
        <div className="progress">
          <div className="progress-direct" style={{width: `${(stats.direct / stats.total) * 100}%`}} />
          <div
            className="progress-fallback"
            style={{
              width: `${(stats.viaFallback / stats.total) * 100}%`,
              left: `${(stats.direct / stats.total) * 100}%`,
            }}
          />
        </div>
        <ul className="completion-legend">
          <li>
            <i className="dot dot-direct" /> {stats.direct} own text
          </li>
          <li>
            <i className="dot dot-fallback" /> {stats.viaFallback} only have text thanks to fallback
          </li>
          <li>
            <i className="dot dot-empty" /> {stats.empty} deliberately empty
          </li>
          <li>
            <i className="dot dot-missing" /> {stats.missing} missing everywhere
          </li>
        </ul>
        {stats.needsReview > 0 && <p className="review-count">⚠ {stats.needsReview} awaiting re-review</p>}
      </div>

      <ul className="key-list">
        {cells.map(cell => {
          const badge = STATUS_BADGE[cell.status];
          return (
            <li key={cell.key}>
              <button
                className={`key-item${cell.key === selectedKey ? ' active' : ''}`}
                onClick={() => onSelect(cell.key)}
              >
                <span className="key-name">{cell.key}</span>
                <span className={`badge ${badge.className}`}>{badge.label}</span>
                <span className="key-provenance">
                  from <strong>{cell.sourceLocale}</strong>
                  {cell.sourceKind === 'fallback' && ' (fallback)'}
                </span>
                {cell.needsReview && <span className="review-flag">needs review</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
