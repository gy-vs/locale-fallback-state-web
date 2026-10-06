/** 支持的语言。en 是源语言（source of truth）。 */
export const LOCALES = ['en', 'fr-FR', 'fr-CA', 'pt-BR', 'pt-PT'] as const;
export type Locale = (typeof LOCALES)[number];
export const SOURCE_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** ICU 风格复数块允许出现的类别（类别是否为某语言必需由 plural.ts 的 CLDR 规则决定）。 */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
export type PluralExact = string; // =value 形式的精确匹配，如 "=1"

/** 三种存储状态：缺失（没翻）/ 明确留空（显式 ""）/ 有内容 */
export type EntryState = 'missing' | 'blank' | 'text';

export interface Entry {
  /** 译文文本；空串表示「明确留空」；null/undefined 表示「没翻」。 */
  value: string | null;
  /** 该条目最后一次修改后的版本号，乐观锁用。 */
  version: number;
  /**
   * 译文所基于的源文案版本。小于源当前版本即「源已改、待复核」。
   * 注意：待复核期间文本仍然有效，解析照旧给出旧译文。
   */
  basedOnSourceVersion: number;
  /** 最后一次保存所属的编辑会话代际（服务端乱序判定用，默认 null）。 */
  lastEditor?: number | null;
  /** 该会话内最后一次保存的序号。 */
  lastSeq?: number | null;
}

export interface Message {
  key: string;
  sourceText: string;
  sourceVersion: number;
  /** locale -> Entry，en 本身不存在这里（它的译文就是 sourceText）。 */
  entries: Partial<Record<Locale, Entry>>;
}

export type Catalog = Record<string, Message>;

/** locale -> 回退链（有序，不含 locale 自身）。en 的链恒为 []。 */
export type FallbackChains = Partial<Record<Locale, Locale[]>>;
