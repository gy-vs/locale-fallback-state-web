import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

function app() {
  return createApp();
}

describe('resolve API', () => {
  it('tells the caller which locale the text actually came from', async () => {
    const response = await request(app()).get('/api/resolve/greeting?locale=fr-CA');
    expect(response.status).toBe(200);
    expect(response.body.text).toContain('Bienvenue');
    expect(response.body.source).toBe('fr-FR');
    expect(response.body.via).toBe('fallback');
    expect(response.body.chain).toEqual(['fr-FR', 'en']);
  });

  it('regression: partial fr-CA falls back to fr-FR instead of English', async () => {
    // greeting 没有 fr-CA 译文：旧实现直接掉英文，新链必须先找到 fr-FR
    const a = app();
    const resolved = await request(a).get('/api/resolve/greeting?locale=fr-CA');
    expect(resolved.body.text).not.toMatch(/Welcome/);
    expect(resolved.body.source).toBe('fr-FR');

    // 把链改成直接到 en：同一数据立刻解析成英文（链改即时生效）
    await request(a).put('/api/fallbacks/fr-CA').send({chain: ['en']});
    const after = await request(a).get('/api/resolve/greeting?locale=fr-CA');
    expect(after.body.source).toBe('en');
    expect(after.body.text).toMatch(/Welcome/);
  });

  it('regression: intentional blank in pt-PT is served empty, never pt-BR', async () => {
    const response = await request(app()).get('/api/resolve/emptyTip?locale=pt-PT');
    expect(response.body.text).toBe('');
    expect(response.body.source).toBe('pt-PT');
    expect(response.body.via).toBe('own');
  });

  it('missing pt-PT content resolves through pt-BR', async () => {
    const response = await request(app()).get('/api/resolve/tagline?locale=pt-PT');
    expect(response.body.source).toBe('pt-BR');
    expect(response.body.text).toMatch(/idiomas/);
    expect(response.body.stale).toBe(true);
  });
});

describe('fallback chain API', () => {
  it('rejects cycles with 422 and keeps the old chain', async () => {
    const a = app();
    const bad = await request(a).put('/api/fallbacks/fr-CA').send({chain: ['fr-FR']});
    // fr-FR -> en, fr-CA -> fr-FR 暂时无环；再把 fr-FR 指回 fr-CA 才成环
    expect(bad.status).toBe(200);
    const cyclic = await request(a).put('/api/fallbacks/fr-FR').send({chain: ['fr-CA', 'en']});
    expect(cyclic.status).toBe(422);
    expect(cyclic.body.cycle.sort()).toEqual(['fr-CA', 'fr-FR']);

    // 旧链仍然有效：greeting 在 fr-CA 下依旧来自 fr-FR
    const resolved = await request(a).get('/api/resolve/greeting?locale=fr-CA');
    expect(resolved.body.source).toBe('fr-FR');
  });

  it('rejects unknown locales and self reference', async () => {
    const a = app();
    // 未知语言在参数层就被拒
    expect((await request(a).put('/api/fallbacks/fr-CA').send({chain: ['de-DE']})).status).toBe(400);
    // 自引用是语义错误，走 422
    expect((await request(a).put('/api/fallbacks/fr-CA').send({chain: ['fr-CA']})).status).toBe(422);
    expect((await request(a).put('/api/fallbacks/en').send({chain: ['fr-FR']})).status).toBe(400);
  });

  it('stats and rows reflect the new chain immediately', async () => {
    const a = app();
    const before = await request(a).get('/api/locales/fr-CA');
    expect(before.body.stats.fallbackCount).toBeGreaterThan(0);
    await request(a).put('/api/fallbacks/fr-CA').send({chain: ['en']});
    const after = await request(a).get('/api/locales/fr-CA');
    const greeting = after.body.rows.find((r: {key: string}) => r.key === 'greeting');
    expect(greeting.source).toBe('en');
  });
});

describe('translation save API', () => {
  it('saves valid text and rejects placeholder/category mismatches', async () => {
    const a = app();
    const bad = await request(a)
      .put('/api/messages/greeting/translations/fr-CA')
      .send({value: 'Bienvenue!', expectedVersion: null, editor: 1, seq: 1});
    expect(bad.status).toBe(400);
    expect(bad.body.diagnostics.some((d: {message: string}) => d.message.includes('{name}'))).toBe(true);

    // 法语 plural 缺 many 也要拒
    const missingMany = await request(a)
      .put('/api/messages/itemsCount/translations/fr-CA')
      .send({
        value: '{count, plural, one {# article} other {# articles}}',
        expectedVersion: 122, editor: 1, seq: 2,
      });
    expect(missingMany.status).toBe(400);
    expect(missingMany.body.diagnostics.some((d: {message: string}) => d.message.includes('many'))).toBe(true);
  });

  it('allows explicit blank and clearing to missing', async () => {
    const a = app();
    const blank = await request(a)
      .put('/api/messages/greeting/translations/fr-FR')
      .send({value: '', expectedVersion: 101, editor: 1, seq: 1});
    expect(blank.status).toBe(200);
    const resolved = await request(a).get('/api/resolve/greeting?locale=fr-FR');
    expect(resolved.body.text).toBe('');
    expect(resolved.body.source).toBe('fr-FR');

    const cleared = await request(a)
      .put('/api/messages/emptyTip/translations/pt-PT')
      .send({value: null, expectedVersion: 114, editor: 1, seq: 2});
    expect(cleared.status).toBe(200);
    const after = await request(a).get('/api/resolve/emptyTip?locale=pt-PT');
    expect(after.body.source).toBe('pt-BR'); // 清除后才允许回退到巴西葡语
  });

  it('out-of-order saves: a late older seq is superseded and the final text wins', async () => {
    const a = app();
    // 先建立 v1
    const first = await request(a)
      .put('/api/messages/greeting/translations/fr-CA')
      .send({value: 'Bonjour {name} (v1)', expectedVersion: null, editor: 7, seq: 1});
    expect(first.status).toBe(200);
    const v1 = first.body.version;

    // seq 3 先到
    const lateFast = request(a)
      .put('/api/messages/greeting/translations/fr-CA')
      .send({value: 'Bonjour {name} (v3)', expectedVersion: v1, editor: 7, seq: 3});
    // seq 2 后到（模拟慢响应）：先发后完成
    let v2Body: request.Response | undefined;
    const slowSlow = request(a)
      .put('/api/messages/greeting/translations/fr-CA')
      .send({value: 'Bonjour {name} (v2)', expectedVersion: v1, editor: 7, seq: 2})
      .then(r => { v2Body = r; });
    const v3 = await lateFast;
    await slowSlow;
    expect(v3.body.kind).toBe('saved');
    expect(v2Body!.body.kind).toBe('superseded');

    const detail = await request(a).get('/api/messages/greeting');
    expect(detail.body.entries['fr-CA'].value).toBe('Bonjour {name} (v3)');
  });

  it('two translators: a save based on an old version conflicts and does not overwrite', async () => {
    const a = app();
    const alice = await request(a)
      .put('/api/messages/greeting/translations/fr-CA')
      .send({value: 'Version d’Alice {name}', expectedVersion: null, editor: 1, seq: 1});
    const currentVersion = alice.body.version;

    // Bob 基于 null（没条目）打开，但 Alice 已经存了 —— 冲突
    const bob = await request(a)
      .put('/api/messages/greeting/translations/fr-CA')
      .send({value: 'Versão do Bob {name}', expectedVersion: null, editor: 2, seq: 1});
    expect(bob.status).toBe(409);
    expect(bob.body.currentVersion).toBe(currentVersion);
    expect(bob.body.serverValue).toBe('Version d’Alice {name}');

    // 服务端内容没有被 Bob 覆盖
    const detail = await request(a).get('/api/messages/greeting');
    expect(detail.body.entries['fr-CA'].value).toBe('Version d’Alice {name}');

    // Bob 显式选择覆盖（force + 当前版本）
    const forced = await request(a)
      .put('/api/messages/greeting/translations/fr-CA')
      .send({value: 'Versão do Bob {name}', expectedVersion: currentVersion, editor: 2, seq: 2, force: true});
    expect(forced.status).toBe(200);
  });
});

describe('source change and review', () => {
  it('changing English marks translations stale; resolve still serves old text until review', async () => {
    const a = app();
    const update = await request(a).put('/api/messages/greeting/source').send({text: 'Hi there, {name}!'});
    expect(update.status).toBe(200);

    const frView = await request(a).get('/api/locales/fr-FR');
    const row = frView.body.rows.find((r: {key: string}) => r.key === 'greeting');
    expect(row.stale).toBe(true);
    // 旧译文照常给出
    const resolved = await request(a).get('/api/resolve/greeting?locale=fr-FR');
    expect(resolved.body.text).toBe('Bienvenue, {name} !');
    expect(resolved.body.stale).toBe(true);

    // 复核通过后待复核清除
    const review = await request(a).post('/api/messages/greeting/review/fr-FR');
    expect(review.status).toBe(200);
    const after = await request(a).get('/api/locales/fr-FR');
    expect(after.body.rows.find((r: {key: string}) => r.key === 'greeting').stale).toBe(false);
  });

  it('saving a new translation clears its stale flag (it is based on current English)', async () => {
    const a = app();
    await request(a).put('/api/messages/tagline/source').send({text: 'Ship in every language, now.'});
    const saved = await request(a)
      .put('/api/messages/tagline/translations/pt-PT')
      .send({value: 'Publique em todas as línguas, agora.', expectedVersion: null, editor: 1, seq: 1});
    expect(saved.status).toBe(200);
    const detail = await request(a).get('/api/messages/tagline');
    expect(detail.body.entries['pt-PT'].stale).toBe(false);
  });

  it('invalid English source (broken syntax) is rejected', async () => {
    const a = app();
    const bad = await request(a).put('/api/messages/greeting/source').send({text: 'Hi {name'});
    expect(bad.status).toBe(400);
  });
});

describe('state aggregation', () => {
  afterEach(() => undefined);
  it('returns per-locale rows, stats and effective chains from one endpoint', async () => {
    const response = await request(app()).get('/api/state');
    expect(response.status).toBe(200);
    expect(response.body.locales).toEqual(['en', 'fr-FR', 'fr-CA', 'pt-BR', 'pt-PT']);
    const frCA = response.body.perLocale['fr-CA'];
    const greeting = frCA.rows.find((r: {key: string}) => r.key === 'greeting');
    expect(greeting.source).toBe('fr-FR');
    expect(response.body.chains['fr-CA']).toEqual(['fr-FR', 'en']);
    const stats = response.body.stats.find((s: {locale: string}) => s.locale === 'pt-PT');
    expect(stats.fallbackCount).toBeGreaterThan(0);
  });

  it('preview renders via the same parser as resolution', async () => {
    const response = await request(app())
      .post('/api/preview')
      .send({text: '{count, plural, one {# article} many {# millions} other {# articles}}', locale: 'fr-FR', values: {count: 2}});
    expect(response.body.rendered).toBe('2 articles');
  });
});
