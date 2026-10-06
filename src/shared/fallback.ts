import type {Catalog, Entry, EntryState, FallbackChains, Locale, Message} from './types';
import {SOURCE_LOCALE} from './types';

/**
 * 回退链解析：所有语言最终都以 en 兜底，因此即使配置里没写 en，
 * 也保证链尾包含 en（en 自身除外）。
 */
export function effectiveChain(chains: FallbackChains, locale: Locale): Locale[] {
  if (locale === SOURCE_LOCALE) return [];
  const configured = (chains[locale] ?? []).filter(loc => loc !== locale);
  return configured.includes(SOURCE_LOCALE) ? configured : [...configured, SOURCE_LOCALE];
}

export class CycleError extends Error {
  constructor(public readonly cycle: Locale[]) {
    super(`回退链存在环：${cycle.join(' → ')} → ${cycle[0]}`);
  }
}

/**
 * 校验回退链整体是否合法：
 * - 未知语言 / 自引用 / 重复链环拒绝；
 * - 存在环拒绝，并给出环上的语言。
 * 用「沿链遍历」逐点检查（链是线性结构，整体等于一张出度 ≤ 1 的图）。
 */
export function validateChains(chains: FallbackChains, knownLocales: readonly Locale[] = [
  'en', 'fr-FR', 'fr-CA', 'pt-BR', 'pt-PT',
]): { ok: true } | { ok: false; error: string; cycle?: Locale[] } {
  for (const [locale, chain] of Object.entries(chains) as [Locale, Locale[] | undefined][]) {
    if (!knownLocales.includes(locale)) return {ok: false, error: `未知语言 ${locale}`};
    if (!chain) continue;
    if (chain.includes(locale)) return {ok: false, error: `${locale} 的回退链不能包含自身`};
    if (new Set(chain).size !== chain.length) return {ok: false, error: `${locale} 的回退链存在重复语言`};
    for (const next of chain) {
      if (!knownLocales.includes(next)) return {ok: false, error: `${locale} 的回退链含未知语言 ${next}`};
    }
  }
  // 成环检测
  for (const start of Object.keys(chains) as Locale[]) {
    const seen: Locale[] = [];
    let cur: Locale | undefined = start;
    while (cur !== undefined) {
      if (seen.includes(cur)) {
        const cycleStart = seen.indexOf(cur);
        const cycle = seen.slice(cycleStart);
        return {ok: false, error: new CycleError(cycle).message, cycle};
      }
      seen.push(cur);
      const nextChain: Locale[] | undefined = chains[cur];
      cur = nextChain && nextChain.length > 0 ? nextChain[0] : undefined;
    }
  }
  return {ok: true};
}

export interface ResolvedMessage {
  /** 最终文本：'' 表示「明确留空」；null 表示链上全都没有（理论上不会发生，en 总有原文）。 */
  text: string | null;
  /** 文本实际来自哪个语言；缺失时为 null。 */
  source: Locale | null;
  /** own：本语言自身有值；fallback：沿链找到；missing：链上没有。 */
  via: 'own' | 'fallback' | 'missing';
  /** 取到的条目（用于版本号、待复核标记等）。 */
  entry: Entry | null;
  /** 本语言自身条目处于什么存储状态。 */
  ownState: EntryState;
}

export function entryState(entry: Entry | null | undefined): EntryState {
  if (!entry || entry.value === null) return 'missing';
  return entry.value === '' ? 'blank' : 'text';
}

/**
 * 解析一条消息在某语言下的最终文本与来源。
 * 关键语义：明确留空（''）是一个**有意的决定**，会终止回退 ——
 * pt-PT 把可选提示留空，就显示空，而不会再掉到 pt-BR。
 */
export function resolveMessage(message: Message, locale: Locale, chains: FallbackChains): ResolvedMessage {
  if (locale === SOURCE_LOCALE) {
    return {
      text: message.sourceText,
      source: SOURCE_LOCALE,
      via: 'own',
      entry: null,
      ownState: 'text',
    };
  }
  const own = message.entries[locale] ?? null;
  const ownState = entryState(own);
  if (ownState !== 'missing') {
    return {text: own!.value, source: locale, via: 'own', entry: own, ownState};
  }
  for (const candidate of effectiveChain(chains, locale)) {
    if (candidate === SOURCE_LOCALE) {
      return {text: message.sourceText, source: SOURCE_LOCALE, via: 'fallback', entry: null, ownState};
    }
    const entry = message.entries[candidate] ?? null;
    const state = entryState(entry);
    if (state !== 'missing') {
      return {text: entry!.value, source: candidate, via: 'fallback', entry, ownState};
    }
  }
  return {text: null, source: null, via: 'missing', entry: null, ownState};
}

export interface LocaleStats {
  locale: Locale;
  total: number;
  /** 本语言自身有非空译文。 */
  ownText: number;
  /** 靠回退链才拿到文本（含回退到 en）。 */
  fallbackText: number;
  /** 本语言明确留空（有意不显示）。 */
  intentionalBlank: number;
  /** 回退链上拿到的也是「明确留空」——同样视为有决定，但不计文本。 */
  fallbackBlank: number;
  /** 链上完全没文本（en 总在链尾，实际应为 0）。 */
  missing: number;
  /** 有结论的条数比例（自身文本/留空/回退留空，以及靠回退拿到文本）。 */
  coverage: number;
  /** 靠回退才有文本的条数 —— 单独数出来。 */
  fallbackCount: number;
  /** 待复核：自身译文基于旧版英文（含旧译文，解析照旧）。 */
  stale: number;
}

export function computeStats(catalog: Catalog, chains: FallbackChains, locale: Locale): LocaleStats {
  const keys = Object.keys(catalog);
  const stats: LocaleStats = {
    locale,
    total: keys.length,
    ownText: 0,
    fallbackText: 0,
    intentionalBlank: 0,
    fallbackBlank: 0,
    missing: 0,
    coverage: 0,
    fallbackCount: 0,
    stale: 0,
  };
  for (const key of keys) {
    const message = catalog[key];
    const resolved = resolveMessage(message, locale, chains);
    if (locale !== SOURCE_LOCALE) {
      const own = message.entries[locale];
      if (own && own.value !== null && own.basedOnSourceVersion < message.sourceVersion) stats.stale += 1;
    }
    if (resolved.via === 'own') {
      if (resolved.ownState === 'blank') stats.intentionalBlank += 1;
      else stats.ownText += 1;
    } else if (resolved.via === 'fallback') {
      if (resolved.text === '') stats.fallbackBlank += 1;
      else {
        stats.fallbackText += 1;
        stats.fallbackCount += 1;
      }
    } else {
      stats.missing += 1;
    }
  }
  const decided = keys.length - stats.missing;
  stats.coverage = keys.length === 0 ? 1 : decided / keys.length;
  return stats;
}

/** 一次算出所有语言的统计；回退链一改，所有调用方都从这里重新取，杜绝旧结果。 */
export function computeAllStats(catalog: Catalog, chains: FallbackChains, locales: readonly Locale[]): LocaleStats[] {
  return locales.map(locale => computeStats(catalog, chains, locale));
}
