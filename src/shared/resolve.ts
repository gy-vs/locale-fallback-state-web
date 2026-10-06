import {LOCALES, SOURCE_LOCALE, type Locale} from './locales';
import {fallbackPath} from './fallback';
import type {
  FallbackChains,
  KeyRecord,
  ResolvedCell,
  StoredTranslation,
  TranslationStatus,
  WorkbenchState,
} from './model';

function statusOf(cell: StoredTranslation | undefined): TranslationStatus {
  if (!cell) return 'missing';
  return cell.text === '' ? 'empty' : 'present';
}

/**
 * Resolve one key for one locale against the *current* fallback graph.
 * Pure: every caller (API, list, completion stats) goes through this, so
 * changing a chain changes all three views at once.
 *
 * Own cell is always consulted first. A present cell wins immediately; an
 * explicit empty cell also wins (and renders as nothing); only a missing
 * cell continues along the chain.
 */
export function resolveCell(
  record: KeyRecord,
  locale: Locale,
  fallback: FallbackChains,
): ResolvedCell {
  // English source lives on the record itself, not in the translations map.
  if (locale === SOURCE_LOCALE) {
    return {
      key: record.key,
      locale,
      status: 'present',
      text: record.source,
      sourceLocale: SOURCE_LOCALE,
      sourceKind: 'direct',
      needsReview: false,
      version: record.version,
    };
  }
  const own = record.translations[locale];
  if (own) {
    return {
      key: record.key,
      locale,
      status: statusOf(own),
      text: own.text,
      sourceLocale: locale,
      sourceKind: 'direct',
      needsReview: own.needsReview,
      version: own.version,
    };
  }
  for (const candidate of fallbackPath(locale, fallback)) {
    const cell = record.translations[candidate];
    if (!cell) continue; // missing -> keep walking
    return {
      key: record.key,
      locale,
      status: statusOf(cell),
      text: cell.text,
      sourceLocale: candidate,
      sourceKind: 'fallback',
      needsReview: cell.needsReview,
      version: cell.version,
    };
  }
  // Nothing anywhere — last resort is the English source record.
  return {
    key: record.key,
    locale,
    status: 'missing',
    text: record.source,
    sourceLocale: 'en',
    sourceKind: 'none',
    needsReview: false,
    version: 0,
  };
}

/** Resolve every key for a locale in key order. */
export function resolveLocale(state: WorkbenchState, locale: Locale): ResolvedCell[] {
  return state.keys.map(record => resolveCell(record, locale, state.fallback));
}

export interface LocaleStats {
  locale: Locale;
  total: number;
  /** Has text directly in this locale. */
  direct: number;
  /** No text of its own, but the fallback chain supplies text. */
  viaFallback: number;
  /** Resolves to visible text by any means. */
  complete: number;
  /** Explicit empty (own cell or a fallback cell). */
  empty: number;
  /** Nothing at all — even the chain is dry. */
  missing: number;
  /** Cells whose stored text predates the current English source. */
  needsReview: number;
  /** complete / total, as a percentage 0..100. */
  completion: number;
}

/**
 * Per-locale completion. Empty is "done on purpose" but is NOT counted as
 * translated text, and "via fallback" is counted separately so the UI can
 * show how much coverage is borrowed.
 */
export function localeStats(state: WorkbenchState, locale: Locale): LocaleStats {
  const cells = resolveLocale(state, locale);
  let direct = 0;
  let viaFallback = 0;
  let empty = 0;
  let missing = 0;
  let needsReview = 0;
  for (const cell of cells) {
    if (cell.needsReview) needsReview += 1;
    if (cell.sourceKind === 'direct' && cell.status === 'present') direct += 1;
    else if (cell.sourceKind === 'fallback' && cell.status === 'present') viaFallback += 1;
    else if (cell.status === 'empty') empty += 1;
    else missing += 1;
  }
  const complete = direct + viaFallback;
  return {
    locale,
    total: cells.length,
    direct,
    viaFallback,
    complete,
    empty,
    missing,
    needsReview,
    completion: cells.length ? Math.round((complete / cells.length) * 100) : 100,
  };
}

export function allStats(state: WorkbenchState): LocaleStats[] {
  return LOCALES.map(locale => localeStats(state, locale));
}
