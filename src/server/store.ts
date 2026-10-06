import type {Catalog, Entry, FallbackChains, Locale, Message} from '../shared/types';
import {LOCALES, SOURCE_LOCALE} from '../shared/types';
import {validateChains} from '../shared/fallback';
import {validateSource, validateTranslation} from '../shared/message';

/**
 * 内存数据层。所有写操作都是 Store 上的原子方法，
 * 服务端路由只做参数解析与 HTTP 映射，便于直接单测。
 */

export interface SaveResult {
  kind: 'saved' | 'unchanged' | 'conflict' | 'invalid' | 'superseded';
  entry?: Entry;
  diagnostics?: {level: 'error' | 'warning'; message: string}[];
  /** 服务端当前版本（冲突时让调用方据此合并）。 */
  currentVersion?: number;
  /** 冲突时服务端当前文本。 */
  serverValue?: string | null;
  /** 服务端保存者代际（冲突时判断是不是同一译者自己的旧请求）。 */
  currentEditor?: number | null;
  message?: string;
}

let entrySeq = 1;
export function nextVersion(): number {
  return entrySeq++;
}

function entry(value: string | null, basedOnSourceVersion: number, version?: number): Entry {
  return {value, version: version ?? nextVersion(), basedOnSourceVersion};
}

/**
 * 种子数据刻意覆盖两类历史问题：
 * - greeting：fr-CA 没翻 → 新链 fr-CA → fr-FR → en 下应显示法语（法国）；
 * - emptyTip：pt-PT 明确留空 → 解析必须停在 pt-PT，不能掉去 pt-BR；
 * - itemsCount：含 plural，给齐各语言 CLDR 类别；
 * - tagline：shipping 旧版英文，演示「源改动后待复核、解析照旧给旧译文」。
 */
export function seedCatalog(): Catalog {
  return {
    greeting: {
      key: 'greeting',
      sourceText: 'Welcome, {name}!',
      sourceVersion: 1,
      entries: {
        'fr-FR': entry('Bienvenue, {name} !', 1, 101),
        // fr-CA 故意缺：靠回退链
        'pt-BR': entry('Bem-vindo, {name}!', 1, 102),
        'pt-PT': entry('Bem-vindo, {name}!', 1, 103),
      },
    },
    emptyTip: {
      key: 'emptyTip',
      sourceText: 'This step is optional.',
      sourceVersion: 1,
      entries: {
        'fr-FR': entry('Cette étape est facultative.', 1, 111),
        'fr-CA': entry('', 1, 112), // 加拿大法语也选择不显示
        'pt-BR': entry('Esta etapa é opcional.', 1, 113),
        'pt-PT': entry('', 1, 114), // 葡葡有意留空：不应再回退到 pt-BR
      },
    },
    itemsCount: {
      key: 'itemsCount',
      sourceText: '{count, plural, one {You have # item} other {You have # items}}',
      sourceVersion: 1,
      entries: {
        'fr-FR': entry(
          '{count, plural, one {Vous avez # article} many {Vous avez # millions d’articles} other {Vous avez # articles}}',
          1, 121,
        ),
        // fr-CA 只翻了一半？这里给出合格复数，用于渲染验证；greeting 那条才是缺失演示
        'fr-CA': entry(
          '{count, plural, one {Vous avez # article} many {Vous avez # millions d’articles} other {Vous avez # articles}}',
          1, 122,
        ),
        'pt-BR': entry(
          '{count, plural, one {Você tem # item} many {Você tem # milhão de itens} other {Você tem # itens}}',
          1, 123,
        ),
        'pt-PT': entry(
          '{count, plural, one {Tem # item} many {Tem # milhões de itens} other {Tem # itens}}',
          1, 124,
        ),
      },
    },
    tagline: {
      key: 'tagline',
      sourceText: 'Ship confidently in every language.', // 新版英文
      sourceVersion: 3,
      entries: {
        // 旧译文基于 sourceVersion=2，全部待复核；解析仍应给出旧译文
        'fr-FR': entry('Lancez sereinement, dans toutes les langues (v2).', 2, 131),
        'fr-CA': entry('Lancez en confiance dans toutes les langues (v2).', 2, 132),
        'pt-BR': entry('Publique com confiança em todos os idiomas (v2).', 2, 133),
      },
      // pt-PT 缺：回退到 pt-BR（旧译文），同时也标记为待复核来源
    },
  };
}

export function seedChains(): FallbackChains {
  return {
    en: [],
    'fr-FR': ['en'],
    'fr-CA': ['fr-FR', 'en'], // 加拿大法语先找法国法语
    'pt-PT': ['pt-BR', 'en'],
    'pt-BR': ['en'],
  };
}

export class Store {
  catalog: Catalog;
  chains: FallbackChains;
  readonly locales = LOCALES;
  readonly sourceLocale = SOURCE_LOCALE;

  constructor(catalog: Catalog = seedCatalog(), chains: FallbackChains = seedChains()) {
    this.catalog = catalog;
    this.chains = chains;
  }

  getMessage(key: string): Message | null {
    return this.catalog[key] ?? null;
  }

  /* ----------------------------- 回退链 ----------------------------- */

  setChain(locale: Locale, chain: Locale[]): {ok: true} | {ok: false; error: string; cycle?: Locale[]} {
    const nextChains: FallbackChains = {...this.chains, [locale]: chain, en: []};
    const check = validateChains(nextChains, this.locales);
    if (!check.ok) return check;
    this.chains = nextChains;
    return {ok: true};
  }

  /* ----------------------------- 源（英文） ----------------------------- */

  updateSource(key: string, text: string): SaveResult {
    const message = this.getMessage(key);
    if (!message) return {kind: 'invalid', message: `未知消息 ${key}`, diagnostics: []};
    const diagnostics = validateSource(text);
    if (diagnostics.some(d => d.level === 'error')) return {kind: 'invalid', diagnostics};
    if (text === message.sourceText) return {kind: 'unchanged'};
    message.sourceText = text;
    message.sourceVersion = nextVersion();
    // 其他语言的 basedOnSourceVersion 不动 → 全部自然变成待复核；
    // 它们的旧译文保留，复核前解析照旧。
    return {kind: 'saved'};
  }

  /* ----------------------------- 译文 ----------------------------- */

  /**
   * 保存译文。
   * @param value 文本；'' 为明确留空；null 为清除（回到没翻）
   * @param expectedVersion 译者编辑时基于的版本；与服务端不符 → 冲突
   * @param editor 同一编辑会话的代际；乱序回来的旧请求由 seq 识别
   * @param seq 该编辑会话内单调递增的序号；若服务端已见过更大序号 → superseded
   */
  saveTranslation(
    key: string,
    locale: Locale,
    value: string | null,
    expectedVersion: number | null,
    opts: { editor?: number | null; seq?: number; force?: boolean } = {},
  ): SaveResult {
    const message = this.getMessage(key);
    if (!message) return {kind: 'invalid', message: `未知消息 ${key}`, diagnostics: []};
    if (locale === SOURCE_LOCALE) {
      return this.updateSource(key, value ?? '');
    }

    const existing = message.entries[locale] ?? null;

    // 同一译者、迟到的旧请求：内容早已被他自己更新的请求覆盖，直接丢弃。
    if (
      existing &&
      opts.editor != null &&
      existing.lastEditor === opts.editor &&
      opts.seq != null &&
      existing.lastSeq != null &&
      opts.seq < existing.lastSeq
    ) {
      return {
        kind: 'superseded',
        entry: existing,
        message: '该保存请求已被同一会话中更新的保存覆盖',
      };
    }

    // 乐观锁：基于旧版本且不是强制覆盖 → 冲突，绝不直接盖掉别人的修改。
    if (
      !opts.force &&
      existing &&
      expectedVersion != null &&
      existing.version !== expectedVersion
    ) {
      return {
        kind: 'conflict',
        currentVersion: existing.version,
        currentEditor: existing.lastEditor ?? null,
        serverValue: existing.value,
        diagnostics: [
          {
            level: 'warning',
            message:
              existing.lastEditor != null && existing.lastEditor === opts.editor
                ? '版本已更新'
                : '另一位译者已经保存了这条消息，请对比后决定是否覆盖',
          },
        ],
      };
    }

    if (value !== null && value !== '') {
      const diagnostics = validateTranslation(message.sourceText, value, locale);
      if (diagnostics.some(d => d.level === 'error')) return {kind: 'invalid', diagnostics};
    }

    // 无变化（同值且版本相同）直接幂等返回
    if (existing && existing.value === value && existing.version === expectedVersion) {
      return {kind: 'unchanged', entry: existing};
    }

    const saved: Entry = {
      value,
      version: nextVersion(),
      // 保存即基于当前英文 → 待复核清除（含明确留空/清除两条路径的语义保持简单）
      basedOnSourceVersion: message.sourceVersion,
      lastEditor: opts.editor ?? null,
      lastSeq: opts.seq ?? null,
    };
    message.entries[locale] = saved;
    return {kind: 'saved', entry: saved};
  }

  /** 标记复核通过：只是把译文对齐到当前英文版本，不动文本。 */
  review(key: string, locale: Locale): SaveResult {
    const message = this.getMessage(key);
    if (!message) return {kind: 'invalid', message: `未知消息 ${key}`};
    if (locale === SOURCE_LOCALE) return {kind: 'unchanged'};
    const existing = message.entries[locale];
    if (!existing) return {kind: 'invalid', message: '该语言还没有译文，无法复核'};
    if (existing.basedOnSourceVersion >= message.sourceVersion) return {kind: 'unchanged', entry: existing};
    existing.basedOnSourceVersion = message.sourceVersion;
    existing.version = nextVersion();
    return {kind: 'saved', entry: existing};
  }
}
