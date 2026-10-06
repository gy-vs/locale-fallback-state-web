import {LOCALES, LOCALE_LABELS, type Locale} from '../shared/locales';
import type {LocaleStats} from '../shared/resolve';

const STATUS_COLOR: Record<LocaleStats['locale'], string> = {
  en: '#173c35',
  'fr-FR': '#174a80',
  'fr-CA': '#7a1d53',
  'pt-BR': '#0b6b4c',
  'pt-PT': '#8a4a10',
};

export function LocaleTabs({
  active,
  stats,
  onSelect,
}: {
  active: Locale;
  stats: LocaleStats[];
  onSelect: (locale: Locale) => void;
}) {
  return (
    <div className="locale-tabs" role="tablist">
      {LOCALES.map(locale => {
        const stat = stats.find(entry => entry.locale === locale);
        const isActive = locale === active;
        return (
          <button
            key={locale}
            role="tab"
            aria-selected={isActive}
            className={`locale-tab${isActive ? ' active' : ''}`}
            onClick={() => onSelect(locale)}
          >
            <span className="locale-tab-name" style={{color: STATUS_COLOR[locale]}}>
              {locale}
            </span>
            <span className="locale-tab-label">{LOCALE_LABELS[locale]}</span>
            {stat && (
              <span className="locale-tab-meta">
                <strong>{stat.completion}%</strong>
                <small>
                  {stat.direct} direct
                  {stat.viaFallback > 0 && ` · ${stat.viaFallback} via fallback`}
                </small>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
