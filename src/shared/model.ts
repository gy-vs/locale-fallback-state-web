import type {Locale} from './locales';

/**
 * The three states every (key, locale) cell can be in, exactly as the
 * workbench needs them:
 *  - missing:        no translation has ever been written
 *  - explicit-empty: the translator deliberately chose to show nothing;
 *                    fallback must NOT skip past it
 *  - present:        actual message text
 */
export type TranslationStatus = 'missing' | 'empty' | 'present';

export interface StoredTranslation {
  /** '' represents an explicit empty; missing means the cell is absent. */
  text: string;
  /** Bumped whenever the text is replaced; optimistic concurrency token. */
  version: number;
  /** True between an English source change and translator re-approval. */
  needsReview: boolean;
  updatedAt: number;
}

export type Translations = Partial<Record<Locale, StoredTranslation>>;

export interface KeyRecord {
  key: string;
  /** English source text; the reference for placeholders/plural shapes. */
  source: string;
  version: number;
  sourceUpdatedAt: number;
  translations: Translations;
}

/**
 * Edges point from a locale to the locales it falls back to, in priority
 * order. "en" normally has an empty list.
 */
export type FallbackChains = Partial<Record<Locale, Locale[]>>;

export interface WorkbenchState {
  keys: KeyRecord[];
  fallback: FallbackChains;
}

/** One resolved cell, carrying the provenance the UI/API must expose. */
export interface ResolvedCell {
  key: string;
  locale: Locale;
  status: TranslationStatus;
  /** Text in the cell that won, or '' for missing/empty. */
  text: string;
  /** Where the text came from: locale itself, a fallback locale, or en. */
  sourceLocale: Locale;
  /** "direct" = translated in this locale; "fallback" = found via the chain. */
  sourceKind: 'direct' | 'fallback' | 'none';
  needsReview: boolean;
  /** Own cell version, used as the optimistic-lock base when saving. */
  version: number;
}
