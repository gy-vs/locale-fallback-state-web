import express from 'express';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {isLocale, LOCALES, SOURCE_LOCALE, type Locale} from '../shared/locales';
import {formatMessage, validateTranslation, type Values} from '../shared/message';
import {validateChain} from '../shared/fallback';
import {resolveCell} from '../shared/resolve';
import {TranslationStore} from './store';

export function createApp(store = new TranslationStore()) {
  const app = express();
  app.use(express.json({limit: '512kb'}));

  const delay = (ms: unknown) =>
    new Promise<void>(resolve =>
      setTimeout(resolve, typeof ms === 'number' && ms >= 0 ? Math.min(ms, 5000) : 0),
    );

  // Full snapshot: keys, cells and the current fallback graph. The client
  // derives lists/stats/preview from this single source of truth.
  app.get('/api/state', (_req, res) => {
    res.json(store.snapshot());
  });

  app.post('/api/resolve', async (req, res) => {
    const {locale, key, values, _delay: waitMs} = req.body ?? {};
    await delay(waitMs);
    if (!isLocale(locale)) {
      res.status(400).json({error: 'unknown locale'});
      return;
    }
    if (typeof key !== 'string' || !key) {
      res.status(400).json({error: 'key is required'});
      return;
    }
    const record = store.findKey(key);
    if (!record) {
      res.status(404).json({error: 'unknown key'});
      return;
    }
    const resolved = resolveCell(record, locale, store.snapshot().fallback);
    const result = {
      ...resolved,
      // Empty/missing render as an empty string by definition; present
      // cells go through the hand-written message formatter.
      rendered:
        resolved.status === 'present'
          ? formatMessage(resolved.text, locale, values as Values)
          : '',
    };
    res.json(result);
  });

  // Replace one locale's ordered fallback chain. Cycles (including
  // multi-locale rings), self loops and unknown locales are refused.
  app.put('/api/fallback/:locale', (req, res) => {
    const locale = req.params.locale as Locale;
    if (!isLocale(locale) || locale === SOURCE_LOCALE) {
      res.status(400).json({error: 'locale cannot be reconfigured'});
      return;
    }
    const candidate = store.snapshot().fallback as Record<Locale, Locale[]>;
    const next = {...candidate, [locale]: req.body?.chain};
    const problem = validateChain(locale, req.body?.chain, next);
    if (problem) {
      res.status(400).json({error: problem.message, code: problem.code, path: problem.path ?? null});
      return;
    }
    store.setChain(locale, req.body.chain as Locale[]);
    res.json({locale, chain: store.snapshot().fallback[locale]});
  });

  // Edit English source. Every stored translation is flagged needsReview
  // server-side; resolution keeps serving the old text meanwhile.
  app.put('/api/keys/:key/source', (req, res) => {
    const {key} = req.params;
    const source = req.body?.source;
    const baseVersion = Number(req.body?.baseVersion);
    if (typeof source !== 'string') {
      res.status(400).json({error: 'source must be a string'});
      return;
    }
    const record = store.findKey(key);
    if (!record) {
      res.status(404).json({error: 'unknown key'});
      return;
    }
    if (record.version !== baseVersion) {
      res
        .status(409)
        .json({error: 'source was changed by someone else', currentVersion: record.version, currentSource: record.source});
      return;
    }
    const parseProblems = source === '' ? [] : validateTranslation(SOURCE_LOCALE, source, source);
    if (parseProblems.length) {
      res.status(400).json({error: 'English source is not a valid message', details: parseProblems});
      return;
    }
    const result = store.setSource(key, source);
    res.json(result);
  });

  app.post('/api/keys', (req, res) => {
    const {key, source} = req.body ?? {};
    if (typeof key !== 'string' || !/^[\w.@-]+$/.test(key)) {
      res.status(400).json({error: 'a dotted key is required'});
      return;
    }
    if (typeof source !== 'string' || !source) {
      res.status(400).json({error: 'English source is required'});
      return;
    }
    const record = store.addKey(key, source);
    if (!record) {
      res.status(409).json({error: 'key already exists'});
      return;
    }
    res.status(201).json(record);
  });

  // Autosave endpoint. Out-of-order writes are harmless because every
  // request carries the version it was based on: a stale trailing request
  // gets a 409 instead of overwriting the newest text.
  app.put('/api/keys/:key/translations/:locale', async (req, res) => {
    const {key} = req.params;
    const locale = req.params.locale as Locale;
    if (!isLocale(locale) || locale === SOURCE_LOCALE) {
      res.status(400).json({error: 'edit English via the source endpoint'});
      return;
    }
    const text = req.body?.text;
    const baseVersion = Number(req.body?.baseVersion ?? 0);
    if (typeof text !== 'string') {
      res.status(400).json({error: 'text must be a string'});
      return;
    }
    const record = store.findKey(key);
    if (!record) {
      res.status(404).json({error: 'unknown key'});
      return;
    }
    // Non-empty saves must keep the source's placeholders and provide the
    // plural categories the locale's CLDR rules require.
    if (text !== '') {
      const problems = validateTranslation(locale, record.source, text);
      if (problems.length) {
        res.status(400).json({error: 'translation does not match the English source', details: problems});
        return;
      }
    }
    await delay(req.body?._delay);
    const outcome = store.saveTranslation(key, locale, text, baseVersion);
    if (outcome === 'no-key') {
      res.status(404).json({error: 'unknown key'});
      return;
    }
    if (!outcome.ok) {
      res.status(409).json({error: 'version conflict', current: outcome.current});
      return;
    }
    res.json({key, locale, cell: outcome.cell});
  });

  app.post('/api/keys/:key/translations/:locale/review', (req, res) => {
    const locale = req.params.locale as Locale;
    if (!isLocale(locale)) {
      res.status(400).json({error: 'unknown locale'});
      return;
    }
    const cell = store.markReviewed(req.params.key, locale);
    if (!cell) {
      res.status(404).json({error: 'no stored translation to review'});
      return;
    }
    res.json({key: req.params.key, locale, cell});
  });

  app.get('/api/locales', (_req, res) => {
    res.json(LOCALES);
  });

  // Production static assets (vite dev server proxies /api in development).
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/client');
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'), error => {
      if (error) res.status(404).end();
    });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4174);
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`locale workbench server http://127.0.0.1:${port}`);
  });
}
