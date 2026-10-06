import {LOCALES, SOURCE_LOCALE, type Locale, isLocale} from './locales';

/**
 * Fallback-graph handling. The graph has one edge per ordered fallback
 * preference: fr-CA -> [fr-FR, en] means "try my own cell first, then
 * fr-FR, then en".  An explicit empty translation terminates the search —
 * it never leaks a fallback sentence onto the page.
 */

export interface FallbackError {
  code: 'unknown_locale' | 'self_loop' | 'cycle' | 'duplicate' | 'invalid';
  message: string;
  path?: string[];
}

const DEFAULT_CHAINS: Record<Locale, Locale[]> = {
  en: [],
  'fr-FR': ['en'],
  'fr-CA': ['fr-FR', 'en'],
  'pt-BR': ['en'],
  'pt-PT': ['pt-BR', 'en'],
};

export function defaultChains(): Record<Locale, Locale[]> {
  return structuredClone(DEFAULT_CHAINS);
}

/**
 * Validate one locale's new chain. `allChains` is the graph with that
 * locale's chain already replaced, so cycles spanning several locales are
 * caught as well as local ones.
 */
export function validateChain(
  locale: Locale,
  chain: unknown,
  allChains: Record<Locale, Locale[]>,
): FallbackError | null {
  if (!Array.isArray(chain)) {
    return {code: 'invalid', message: 'fallback chain must be a list of locales'};
  }
  const seen = new Set<Locale>();
  const normalized: Locale[] = [];
  for (const raw of chain) {
    if (!isLocale(raw)) {
      return {code: 'unknown_locale', message: `"${String(raw)}" is not a known locale`};
    }
    if (raw === locale) {
      return {code: 'self_loop', message: `${locale} cannot fall back to itself`, path: [locale, locale]};
    }
    if (seen.has(raw)) {
      return {code: 'duplicate', message: `${raw} appears more than once in ${locale}'s chain`};
    }
    seen.add(raw);
    normalized.push(raw);
  }

  // DFS preorder over the graph-as-replaced, starting at `locale`,
  // tracking the path so a rejection can say exactly where the ring is.
  const color = new Map<Locale, 0 | 1 | 2>();
  const path: Locale[] = [];
  const dfs = (current: Locale): FallbackError | null => {
    color.set(current, 1);
    path.push(current);
    const edges = current === locale ? normalized : allChains[current] ?? [];
    for (const next of edges) {
      const nextColor = color.get(next) ?? 0;
      if (nextColor === 1) {
        const start = path.indexOf(next);
        return {code: 'cycle', message: 'fallback chain forms a cycle', path: [...path.slice(start), next]};
      }
      if (nextColor === 0) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    path.pop();
    color.set(current, 2);
    return null;
  };
  return dfs(locale);
}

/** Full validation used before replacing the whole map. */
export function validateChains(
  partial: Record<Locale, Locale[]>,
): FallbackError | null {
  for (const locale of LOCALES) {
    if (locale === SOURCE_LOCALE) continue;
    const error = validateChain(locale, partial[locale] ?? [], partial);
    if (error) return error;
  }
  return null;
}

/**
 * Locales visited when resolving a key for `locale`, in priority order,
 * NOT including the locale itself. Cycles are impossible post-validation;
 * the visited-set is defence in depth.
 */
export function fallbackPath(
  locale: Locale,
  chains: Partial<Record<Locale, Locale[]>>,
): Locale[] {
  const order: Locale[] = [];
  const seen = new Set<Locale>([locale]);
  const visit = (current: Locale): void => {
    for (const next of chains[current] ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      order.push(next);
      visit(next);
    }
  };
  visit(locale);
  if (!seen.has(SOURCE_LOCALE)) order.push(SOURCE_LOCALE);
  return order;
}
