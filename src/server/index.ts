import express from 'express';
import {fileURLToPath} from 'node:url';
import {Store} from './store';
import {computeAllStats, effectiveChain, resolveMessage, type LocaleStats} from '../shared/fallback';
import {render, tryParse, validateTranslation} from '../shared/message';
import {isLocale, LOCALES, SOURCE_LOCALE, type Locale} from '../shared/types';

export function createApp(store = new Store()) {
  const app = express();
  app.use(express.json({limit: '512kb'}));

  /** 工作台整体状态：语言、回退链、按语言的列表行 + 完成度（一次取齐，链改后整体刷新）。 */
  function overview() {
    const stats = computeAllStats(store.catalog, store.chains, LOCALES);
    const perLocale: Record<string, LocaleView> = {};
    for (const locale of LOCALES) {
      perLocale[locale] = localeView(locale);
    }
    return {
      sourceLocale: SOURCE_LOCALE,
      locales: LOCALES,
      chains: Object.fromEntries(LOCALES.map(loc => [loc, effectiveChain(store.chains, loc)])),
      stats,
      perLocale,
    };
  }

  function localeView(locale: Locale): LocaleView {
    const rows = Object.values(store.catalog).map(message => {
      const resolved = resolveMessage(message, locale, store.chains);
      const sourceVersion = locale === SOURCE_LOCALE ? message.sourceVersion : message.entries[locale]?.basedOnSourceVersion ?? null;
      return {
        key: message.key,
        sourceVersion: message.sourceVersion,
        text: resolved.text,
        source: resolved.source,
        via: resolved.via,
        ownState: resolved.ownState,
        version: locale === SOURCE_LOCALE ? message.sourceVersion : (message.entries[locale]?.version ?? null),
        stale: sourceVersion != null && sourceVersion < message.sourceVersion,
      };
    });
    const stats = computeAllStats(store.catalog, store.chains, LOCALES).find(s => s.locale === locale)!;
    return {locale, chain: effectiveChain(store.chains, locale), stats, rows};
  }

  function messageDetail(key: string) {
    const message = store.getMessage(key);
    if (!message) return null;
    return {
      key: message.key,
      sourceText: message.sourceText,
      sourceVersion: message.sourceVersion,
      entries: Object.fromEntries(
        LOCALES.filter(loc => loc !== SOURCE_LOCALE).map(loc => [
          loc,
          message.entries[loc]
            ? {
                value: message.entries[loc]!.value,
                version: message.entries[loc]!.version,
                basedOnSourceVersion: message.entries[loc]!.basedOnSourceVersion,
                stale: message.entries[loc]!.basedOnSourceVersion < message.sourceVersion,
              }
            : null,
        ]),
      ),
    };
  }

  app.get('/api/state', (_req, res) => {
    res.json(overview());
  });

  app.get('/api/locales/:locale', (req, res) => {
    if (!isLocale(req.params.locale)) return res.status(400).json({error: `未知语言 ${req.params.locale}`});
    res.json(localeView(req.params.locale));
  });

  app.get('/api/messages/:key', (req, res) => {
    const detail = messageDetail(req.params.key);
    if (!detail) return res.status(404).json({error: '消息不存在'});
    res.json(detail);
  });

  /** 解析接口：给出最终文本与实际来源语言。 */
  app.get('/api/resolve/:key', (req, res) => {
    const locale = (req.query.locale as string) ?? SOURCE_LOCALE;
    if (!isLocale(locale)) return res.status(400).json({error: `未知语言 ${locale}`});
    const message = store.getMessage(req.params.key);
    if (!message) return res.status(404).json({error: '消息不存在'});
    const resolved = resolveMessage(message, locale, store.chains);
    res.json({
      key: message.key,
      requestedLocale: locale,
      chain: effectiveChain(store.chains, locale),
      text: resolved.text,
      source: resolved.source,
      via: resolved.via,
      ownState: resolved.ownState,
      stale: resolved.entry ? resolved.entry.basedOnSourceVersion < message.sourceVersion : false,
    });
  });

  /** 改回退链（单条），成环/非法语言直接拒绝。 */
  app.put('/api/fallbacks/:locale', (req, res) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return res.status(400).json({error: `未知语言 ${locale}`});
    if (!Array.isArray(req.body.chain) || req.body.chain.some((item: unknown) => !isLocale(item))) {
      return res.status(400).json({error: 'chain 必须是语言数组'});
    }
    if (locale === SOURCE_LOCALE) return res.status(400).json({error: '源语言没有回退链'});
    const result = store.setChain(locale, req.body.chain as Locale[]);
    if (!result.ok) {
      return res.status(422).json({error: result.error, cycle: result.cycle});
    }
    res.json(overview());
  });

  /** 改英文原文；成功后其他语言该条全部待复核。 */
  app.put('/api/messages/:key/source', (req, res) => {
    const text = String(req.body.text ?? '');
    const result = store.updateSource(req.params.key, text);
    if (result.kind === 'invalid') return res.status(400).json({...result});
    res.json({...result, detail: messageDetail(req.params.key), stats: overview().stats});
  });

  /**
   * 保存译文。乱序语义：
   * - seq：同一编辑会话（editor）内递增；迟到的旧 seq 得 superseded，不入库；
   * - expectedVersion：与服务端版本不符且非 force → 409 冲突（不覆盖）。
   */
  app.put('/api/messages/:key/translations/:locale', (req, res) => {
    const {key, locale} = req.params;
    if (!isLocale(locale)) return res.status(400).json({error: `未知语言 ${locale}`});
    const rawValue = req.body.value;
    if (rawValue !== null && typeof rawValue !== 'string') {
      return res.status(400).json({error: 'value 必须是字符串或 null'});
    }
    const value: string | null = rawValue;
    const expectedVersion = req.body.expectedVersion === undefined ? null : Number(req.body.expectedVersion);
    const editor = req.body.editor === undefined || req.body.editor === null ? null : Number(req.body.editor);
    const seq = req.body.seq === undefined ? undefined : Number(req.body.seq);
    const force = Boolean(req.body.force);
    const result = store.saveTranslation(key, locale, value, expectedVersion, {editor, seq, force});
    if (result.kind === 'invalid') return res.status(400).json({...result});
    if (result.kind === 'conflict') return res.status(409).json({...result});
    res.json({
      ...result,
      key,
      locale,
      seq,
      value: result.entry ? result.entry.value : undefined,
      version: result.entry ? result.entry.version : undefined,
      detail: messageDetail(key),
      stats: overview().stats,
    });
  });

  /** 复核通过：译文不动，仅把基于版本对齐到当前英文。 */
  app.post('/api/messages/:key/review/:locale', (req, res) => {
    const {key, locale} = req.params;
    if (!isLocale(locale)) return res.status(400).json({error: `未知语言 ${locale}`});
    const result = store.review(key, locale);
    if (result.kind === 'invalid') return res.status(400).json({...result});
    res.json({...result, key, locale, detail: messageDetail(key), stats: overview().stats});
  });

  /** 渲染预览（与解析接口同源的解析器；只渲染不落库）。 */
  app.post('/api/preview', (req, res) => {
    const text = String(req.body.text ?? '');
    const locale: Locale = isLocale(req.body.locale) ? req.body.locale : SOURCE_LOCALE;
    const values = (req.body.values ?? {}) as Record<string, number | string>;
    const parsed = tryParse(text);
    if (parsed.error) return res.status(400).json({error: parsed.error.message});
    const result = render(parsed.ast!, values, locale);
    res.json({rendered: result.text, missingArgs: result.missingArgs});
  });

  /** 保存前预检（占位符/复数类别是否与英文一致），编辑区实时诊断用。 */
  app.get('/api/validate/:key/:locale', (req, res) => {
    const {key, locale} = req.params;
    if (!isLocale(locale)) return res.status(400).json({error: `未知语言 ${locale}`});
    const message = store.getMessage(key);
    if (!message) return res.status(404).json({error: '消息不存在'});
    const text = String(req.query.text ?? '');
    const diagnostics = validateTranslation(message.sourceText, text, locale);
    res.json({diagnostics});
  });

  return app;
}

interface LocaleRow {
  key: string;
  sourceVersion: number;
  text: string | null;
  source: Locale | null;
  via: 'own' | 'fallback' | 'missing';
  ownState: 'missing' | 'blank' | 'text';
  version: number | null;
  stale: boolean;
}

interface LocaleView {
  locale: Locale;
  chain: Locale[];
  stats: LocaleStats;
  rows: LocaleRow[];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
