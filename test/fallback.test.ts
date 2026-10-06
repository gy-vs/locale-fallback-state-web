import {describe, expect, it} from 'vitest';
import {defaultChains, fallbackPath, validateChain} from '../src/shared/fallback';
import {allStats, resolveCell, resolveLocale} from '../src/shared/resolve';
import {createSeedState} from '../src/server/store';
import type {Locale} from '../src/shared/locales';

function chainsWith(mutate: (chains: Record<Locale, Locale[]>) => void) {
  const chains = defaultChains();
  mutate(chains);
  return chains;
}

describe('fallback graph', () => {
  it('walks the configured chain in preorder and appends en', () => {
    const chains = defaultChains();
    expect(fallbackPath('fr-CA', chains)).toEqual(['fr-FR', 'en']);
    // pt-PT -> pt-BR -> en; en is reached through pt-BR so it is not duplicated
    expect(fallbackPath('pt-PT', chains)).toEqual(['pt-BR', 'en']);
  });

  it('accepts valid edits and rejects self loops', () => {
    const chains = defaultChains();
    expect(validateChain('fr-CA', ['en'], {...chains, 'fr-CA': ['en']})).toBeNull();
    const self = validateChain('fr-CA', ['fr-CA'], {...chains, 'fr-CA': ['fr-CA']});
    expect(self?.code).toBe('self_loop');
  });

  it('rejects direct cycles with the offending path', () => {
    // fr-CA -> fr-FR, fr-FR -> fr-CA
    const chains = chainsWith(c => {
      c['fr-CA'] = ['fr-FR'];
      c['fr-FR'] = ['fr-CA'];
    });
    const error = validateChain('fr-CA', ['fr-FR'], chains);
    expect(error?.code).toBe('cycle');
    expect(error?.path).toEqual(['fr-CA', 'fr-FR', 'fr-CA']);
  });

  it('rejects longer cycles and duplicate entries', () => {
    const chains = chainsWith(c => {
      c['pt-PT'] = ['fr-FR'];
      c['fr-FR'] = ['pt-BR'];
      c['pt-BR'] = ['pt-PT'];
    });
    expect(validateChain('pt-PT', ['fr-FR'], chains)?.code).toBe('cycle');

    const dupes = defaultChains();
    expect(
      validateChain('pt-PT', ['pt-BR', 'pt-BR', 'en'], {...dupes, 'pt-PT': ['pt-BR', 'pt-BR', 'en']})
        ?.code,
    ).toBe('duplicate');
  });

  it('rejects unknown locales and non-list input', () => {
    const chains = defaultChains();
    expect(validateChain('fr-FR', ['de-DE'], {...chains, 'fr-FR': ['de-DE' as Locale]})?.code).toBe(
      'unknown_locale',
    );
    expect(validateChain('fr-FR', 'en', chains)?.code).toBe('invalid');
  });
});

describe('resolution with provenance', () => {
  it('fr-CA checkout.title comes from fr-FR, not English', () => {
    const state = createSeedState();
    const record = state.keys.find(k => k.key === 'checkout.title')!;
    const resolved = resolveCell(record, 'fr-CA', state.fallback);
    expect(resolved.status).toBe('present');
    expect(resolved.sourceLocale).toBe('fr-FR');
    expect(resolved.sourceKind).toBe('fallback');
    expect(resolved.text).toContain('Vérifiez votre commande');
  });

  it('explicit empty in pt-PT blocks the pt-BR sentence', () => {
    const state = createSeedState();
    const record = state.keys.find(k => k.key === 'checkout.optionalTip')!;
    const resolved = resolveCell(record, 'pt-PT', state.fallback);
    expect(resolved.status).toBe('empty');
    expect(resolved.text).toBe('');
    expect(resolved.sourceLocale).toBe('pt-PT');
  });

  it('explicit empty in a fallback locale is not skipped either', () => {
    const state = createSeedState();
    // pt-PT's chain goes through pt-BR; if pt-PT cell were removed it
    // would still get real text — but with the own empty cell, nothing shows
    const record = state.keys.find(k => k.key === 'checkout.optionalTip')!;
    delete record.translations['pt-PT'];
    const viaBrazil = resolveCell(record, 'pt-PT', state.fallback);
    expect(viaBrazil.status).toBe('present');
    expect(viaBrazil.sourceLocale).toBe('pt-BR');
  });

  it('missing cells walk to the English source as last resort', () => {
    const state = createSeedState();
    const record = state.keys.find(k => k.key === 'checkout.itemsCount')!;
    const resolved = resolveCell(record, 'pt-PT', state.fallback);
    expect(resolved.sourceLocale).toBe('en');
    expect(resolved.text).toContain('item in your cart');
  });

  it('changing the chain immediately changes resolution', () => {
    const state = createSeedState();
    const record = state.keys.find(k => k.key === 'checkout.title')!;
    state.fallback['fr-CA'] = ['en']; // the bug from the bug report, reintroduced
    const viaEn = resolveCell(record, 'fr-CA', state.fallback);
    expect(viaEn.sourceLocale).toBe('en');
    state.fallback['fr-CA'] = ['fr-FR', 'en']; // fixed in the workbench
    const viaFr = resolveCell(record, 'fr-CA', state.fallback);
    expect(viaFr.sourceLocale).toBe('fr-FR');
  });

  it('stale translations keep resolving to their old text with needsReview set', () => {
    const state = createSeedState();
    const record = state.keys.find(k => k.key === 'checkout.itemsCount')!;
    const before = resolveCell(record, 'fr-CA', state.fallback);
    expect(before.text).toContain('Vous avez');
    record.source = '{count, plural, one {NEW one} many {NEW many} other {NEW other}}';
    record.version += 1;
    for (const cell of Object.values(record.translations)) cell!.needsReview = true;
    const after = resolveCell(record, 'fr-CA', state.fallback);
    expect(after.text).toBe(before.text); // old text still served
    expect(after.needsReview).toBe(true);
  });
});

describe('completion stats with fallback', () => {
  it('counts direct vs fallback coverage per locale', () => {
    const state = createSeedState();
    const stats = allStats(state);
    const byLocale = Object.fromEntries(stats.map(s => [s.locale, s]));
    // fr-CA: title via fr-FR, own empty tip, own stale count,
    // greeting has no French cell at all and comes from en
    expect(byLocale['fr-CA'].direct).toBe(1);
    expect(byLocale['fr-CA'].viaFallback).toBe(2);
    expect(byLocale['fr-CA'].empty).toBe(1);
    expect(byLocale['fr-CA'].complete).toBe(3);
    expect(byLocale['fr-CA'].completion).toBe(75);
    expect(byLocale['fr-CA'].needsReview).toBe(1);

    // pt-PT own empty is NOT fallback coverage
    expect(byLocale['pt-PT'].empty).toBeGreaterThanOrEqual(1);
    // English source is always complete
    expect(byLocale.en.completion).toBe(100);
  });

  it('updates the moment the fallback chain changes', () => {
    const state = createSeedState();
    const before = resolveLocale(state, 'fr-CA');
    const titleBefore = before.find(c => c.key === 'checkout.title')!;
    expect(titleBefore.sourceLocale).toBe('fr-FR');

    state.fallback['fr-CA'] = ['en'];
    const after = resolveLocale(state, 'fr-CA');
    const titleAfter = after.find(c => c.key === 'checkout.title')!;
    expect(titleAfter.sourceLocale).toBe('en');
  });
});
