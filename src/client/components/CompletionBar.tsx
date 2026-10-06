import type {LocaleStats} from '../../shared/fallback';
import type {Locale} from '../../shared/types';

const LABELS: Record<Locale, string> = {
  en: 'English（源）',
  'fr-FR': 'Français (FR)',
  'fr-CA': 'Français (CA)',
  'pt-BR': 'Português (BR)',
  'pt-PT': 'Português (PT)',
};

/** 顶部：每个语言的完成度；靠回退才有文本的条数单独数出。 */
export function CompletionBar({stats, active, onSelect}: {
  stats: LocaleStats[];
  active: Locale;
  onSelect: (locale: Locale) => void;
}) {
  return (
    <div className="completion-bar">
      {stats.map(stat => (
        <button
          key={stat.locale}
          className={`completion-chip ${stat.locale === active ? 'active' : ''}`}
          onClick={() => onSelect(stat.locale)}
          title={`自身译文 ${stat.ownText} 条；留空 ${stat.intentionalBlank} 条；靠回退 ${stat.fallbackCount} 条；待复核 ${stat.stale} 条`}
        >
          <span className="chip-label">{LABELS[stat.locale]}</span>
          <span className="chip-percent">{Math.round(stat.coverage * 100)}%</span>
          <span className="chip-detail">
            {stat.fallbackCount > 0 ? `含 ${stat.fallbackCount} 条回退` : '无回退'}
            {stat.stale > 0 ? ` · ${stat.stale} 待复核` : ''}
          </span>
        </button>
      ))}
    </div>
  );
}
