import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {TranslationStore} from '../src/server/store';

function server() {
  // Fresh store per test so seeded state is stable.
  return request(createApp(new TranslationStore()));
}

describe('GET /api/state', () => {
  it('returns keys and the fallback graph', async () => {
    const response = await server().get('/api/state');
    expect(response.status).toBe(200);
    expect(response.body.fallback['fr-CA']).toEqual(['fr-FR', 'en']);
    expect(response.body.keys.map((k: {key: string}) => k.key)).toContain('checkout.title');
  });
});

describe('POST /api/resolve', () => {
  it('resolves fr-CA via fr-FR with provenance', async () => {
    const response = await server()
      .post('/api/resolve')
      .send({locale: 'fr-CA', key: 'checkout.title', values: {}});
    expect(response.status).toBe(200);
    expect(response.body.sourceLocale).toBe('fr-FR');
    expect(response.body.sourceKind).toBe('fallback');
    expect(response.body.status).toBe('present');
    expect(response.body.rendered).toContain('Vérifiez');
  });

  it('renders plurals with the locale CLDR category', async () => {
    const app = server();
    const zero = await app
      .post('/api/resolve')
      .send({locale: 'fr-FR', key: 'checkout.itemsCount', values: {count: 0}});
    expect(zero.body.rendered).toContain('0 article');
    const many = await app
      .post('/api/resolve')
      .send({locale: 'fr-FR', key: 'checkout.itemsCount', values: {count: 1000000}});
    expect(many.body.rendered).toContain('1\u202f000\u202f000 articles');
    const ptZero = await server()
      .post('/api/resolve')
      .send({locale: 'pt-PT', key: 'checkout.itemsCount', values: {count: 0}});
    // pt-PT has no translation: English fallback, English plural categories
    expect(ptZero.body.sourceLocale).toBe('en');
  });

  it('renders an explicit empty pt-PT tip as an empty string, never pt-BR', async () => {
    const response = await server()
      .post('/api/resolve')
      .send({locale: 'pt-PT', key: 'checkout.optionalTip', values: {}});
    expect(response.body.status).toBe('empty');
    expect(response.body.text).toBe('');
    expect(response.body.rendered).toBe('');
    expect(response.body.sourceLocale).toBe('pt-PT');
  });

  it('validates inputs', async () => {
    const app = server();
    expect((await app.post('/api/resolve').send({locale: 'de-DE', key: 'x'})).status).toBe(400);
    expect((await app.post('/api/resolve').send({locale: 'en'})).status).toBe(400);
    expect((await app.post('/api/resolve').send({locale: 'en', key: 'nope'})).status).toBe(404);
  });
});

describe('PUT /api/fallback/:locale', () => {
  it('persists a valid chain and resolution follows it immediately', async () => {
    const app = server();
    const update = await app.put('/api/fallback/fr-CA').send({chain: ['fr-FR', 'en']});
    expect(update.status).toBe(200);
    const resolved = await app
      .post('/api/resolve')
      .send({locale: 'fr-CA', key: 'checkout.title'});
    expect(resolved.body.sourceLocale).toBe('fr-FR');
  });

  it('rejects a self loop', async () => {
    const response = await server().put('/api/fallback/fr-CA').send({chain: ['fr-CA']});
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('self_loop');
  });

  it('rejects a multi-locale cycle and reports the path', async () => {
    const app = server();
    // 1) fr-CA no longer reaches fr-FR, so fr-FR can safely point at it
    await app.put('/api/fallback/fr-CA').send({chain: ['en']});
    // 2) fr-FR -> fr-CA -> en (still acyclic)
    await app.put('/api/fallback/fr-FR').send({chain: ['fr-CA', 'en']});
    // 3) closing fr-CA -> fr-FR creates the ring
    const response = await app.put('/api/fallback/fr-CA').send({chain: ['fr-FR']});
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('cycle');
    expect(response.body.path).toEqual(['fr-CA', 'fr-FR', 'fr-CA']);
  });

  it('rejects unknown locales', async () => {
    const response = await server()
      .put('/api/fallback/fr-FR')
      .send({chain: ['es-ES']});
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('unknown_locale');
  });

  it('does not allow reconfiguring English', async () => {
    const response = await server().put('/api/fallback/en').send({chain: ['fr-FR']});
    expect(response.status).toBe(400);
  });
});

describe('PUT translations with validation', () => {
  it('rejects a translation missing the locale plural categories', async () => {
    const response = await server()
      .put('/api/keys/checkout.greeting/translations/fr-CA')
      .send({text: 'Bonjour {name}', baseVersion: 0});
    expect(response.status).toBe(200);
    // now try a plural key with missing "many"
    const bad = await server()
      .put('/api/keys/checkout.itemsCount/translations/pt-PT')
      .send({
        text: '{count, plural, one {# artigo} other {# artigos}}',
        baseVersion: 0,
      });
    expect(bad.status).toBe(400);
    expect(bad.body.details[0].message).toContain('many');
  });

  it('rejects mismatched placeholders', async () => {
    const response = await server()
      .put('/api/keys/checkout.greeting/translations/fr-FR')
      .send({text: 'Bonjour {wrong}', baseVersion: 1});
    expect(response.status).toBe(400);
    const messages = response.body.details.map((d: {message: string}) => d.message);
    expect(messages).toContain('unknown placeholder {wrong} (not in English source)');
    expect(messages).toContain('missing placeholder {name}');
  });

  it('accepts explicit empty without placeholder requirements', async () => {
    const response = await server()
      .put('/api/keys/checkout.itemsCount/translations/pt-PT')
      .send({text: '', baseVersion: 0});
    expect(response.status).toBe(200);
    expect(response.body.cell.text).toBe('');
  });

  it('accepts a well-formed plural translation', async () => {
    const response = await server()
      .put('/api/keys/checkout.itemsCount/translations/pt-PT')
      .send({
        text:
          '{count, plural, one {# artigo} many {# artigos} other {# artigos}}',
        baseVersion: 0,
      });
    expect(response.status).toBe(200);
    expect(response.body.cell.version).toBe(1);
  });
});

describe('optimistic concurrency', () => {
  it('out-of-order saves: stale base version gets 409 and newest text wins', async () => {
    const app = server();
    const first = await app
      .put('/api/keys/checkout.greeting/translations/fr-CA')
      .send({text: 'Bonjour {name}, un', baseVersion: 0, _delay: 120});
    expect(first.status).toBe(200);
    const versionAfterFirst = first.body.cell.version;

    // Two requests fired "simultaneously" from two translators; the stale
    // one must not overwrite even though it may arrive later.
    const [older, newer] = await Promise.all([
      app
        .put('/api/keys/checkout.greeting/translations/fr-CA')
        .send({text: 'Bonjour {name}, OLD', baseVersion: 0, _delay: 100}),
      app
        .put('/api/keys/checkout.greeting/translations/fr-CA')
        .send({text: 'Bonjour {name}, NEW', baseVersion: versionAfterFirst, _delay: 10}),
    ]);
    expect(newer.status).toBe(200);
    expect(older.status).toBe(409);
    expect(older.body.current.text).toBe('Bonjour {name}, NEW');
  });
});

describe('source change and review lifecycle', () => {
  it('flags every translation needs review while resolution keeps old text', async () => {
    const app = server();
    const before = await app
      .post('/api/resolve')
      .send({locale: 'fr-FR', key: 'checkout.greeting'});
    expect(before.body.rendered).toContain('Bonjour');

    const record = (await app.get('/api/state')).body.keys.find(
      (k: {key: string}) => k.key === 'checkout.greeting',
    );
    const update = await app
      .put('/api/keys/checkout.greeting/source')
      .send({source: 'Welcome back, {name}!', baseVersion: record.version});
    expect(update.status).toBe(200);

    const after = await app
      .post('/api/resolve')
      .send({locale: 'fr-FR', key: 'checkout.greeting'});
    expect(after.body.text).toContain('Bonjour'); // old translation still served
    expect(after.body.needsReview).toBe(true);

    const reviewed = await app
      .post('/api/keys/checkout.greeting/translations/fr-FR/review')
      .send({});
    expect(reviewed.status).toBe(200);
    const finalResolve = await app
      .post('/api/resolve')
      .send({locale: 'fr-FR', key: 'checkout.greeting'});
    expect(finalResolve.body.needsReview).toBe(false);
  });

  it('rejects a stale source edit with 409', async () => {
    const response = await server()
      .put('/api/keys/checkout.greeting/source')
      .send({source: 'x {name}', baseVersion: 999});
    expect(response.status).toBe(409);
  });
});
