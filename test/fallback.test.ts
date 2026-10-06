import {describe, expect, it} from 'vitest';
import {computeStats, resolveMessage, validateChains} from '../src/shared/fallback';
import type {FallbackChains, Locale} from '../src/shared/types';

const chains: FallbackChains = {
  en: [],
  'fr-FR': ['en'],
  'fr-CA': ['fr-FR', 'en'],
  'pt-BR': ['en'],
  'pt-PT': ['pt-BR', 'en'],
};

function makeMsg(partial: {
  sourceText: string;
  entries?: Partial<Record<Locale, {value: string | null; version: number; basedOnSourceVersion: number}>>;
  sourceVersion?: number;
}) {
  return {
    key: 'k',
    sourceText: partial.sourceText,
    sourceVersion: partial.sourceVersion ?? 1,
    entries: partial.entries ?? {},
  };
}

describe('fallback resolution', () => {
  it('fr-CA with no translation falls back to fr-FR before en', () => {
    const msg = makeMsg({
      sourceText: 'English',
      entries: {'fr-FR': {value: 'Français FR', version: 1, basedOnSourceVersion: 1}},
    });
    const resolved = resolveMessage(msg, 'fr-CA', chains);
    expect(resolved.text).toBe('Français FR');
    expect(resolved.source).toBe('fr-FR');
    expect(resolved.via).toBe('fallback');
  });

  it('half-translated fr-CA keeps own text and does not fall back', () => {
    const msg = makeMsg({
      sourceText: 'English',
      entries: {
        'fr-CA': {value: 'Québec', version: 1, basedOnSourceVersion: 1},
        'fr-FR': {value: 'France', version: 1, basedOnSourceVersion: 1},
      },
    });
    const resolved = resolveMessage(msg, 'fr-CA', chains);
    expect(resolved.text).toBe('Québec');
    expect(resolved.source).toBe('fr-CA');
    expect(resolved.via).toBe('own');
  });

  it('explicit blank in pt-PT stops fallback: Brazilian text must NOT appear', () => {
    const msg = makeMsg({
      sourceText: 'Optional',
      entries: {
        'pt-PT': {value: '', version: 1, basedOnSourceVersion: 1},
        'pt-BR': {value: 'Opcional BR', version: 1, basedOnSourceVersion: 1},
      },
    });
    const resolved = resolveMessage(msg, 'pt-PT', chains);
    expect(resolved.text).toBe('');
    expect(resolved.source).toBe('pt-PT');
    expect(resolved.via).toBe('own');
  });

  it('missing pt-PT continues to pt-BR, then en', () => {
    const msg = makeMsg({
      sourceText: 'English only',
      entries: {'pt-BR': {value: 'Texto BR', version: 1, basedOnSourceVersion: 1}},
    });
    expect(resolveMessage(msg, 'pt-PT', chains).source).toBe('pt-BR');
    const msg2 = makeMsg({sourceText: 'English only'});
    const resolved = resolveMessage(msg2, 'pt-PT', chains);
    expect(resolved.source).toBe('en');
    expect(resolved.text).toBe('English only');
  });

  it('a blank encountered mid-chain also stops (blank is a deliberate decision)', () => {
    const customChains: FallbackChains = {'fr-CA': ['fr-FR', 'en'], 'fr-FR': ['en'], en: []};
    const msg = makeMsg({
      sourceText: 'EN',
      entries: {'fr-FR': {value: '', version: 1, basedOnSourceVersion: 1}},
    });
    const resolved = resolveMessage(msg, 'fr-CA', customChains);
    expect(resolved.text).toBe('');
    expect(resolved.source).toBe('fr-FR');
  });
});

describe('chain validation', () => {
  it('rejects cycles and reports the cycle members', () => {
    const cyclic: FallbackChains = {
      'fr-CA': ['fr-FR'],
      'fr-FR': ['fr-CA', 'en'],
    };
    const result = validateChains(cyclic);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cycle?.sort()).toEqual(['fr-CA', 'fr-FR']);
  });

  it('rejects self reference and unknown locales', () => {
    expect(validateChains({'fr-CA': ['fr-CA', 'en']}).ok).toBe(false);
    expect(validateChains({'fr-CA': ['de-DE' as Locale]}).ok).toBe(false);
    expect(validateChains({'fr-CA': ['fr-FR', 'fr-FR']}).ok).toBe(false);
  });

  it('accepts the default DAG and reordered chains', () => {
    expect(validateChains(chains).ok).toBe(true);
    expect(validateChains({...chains, 'pt-PT': ['en']}).ok).toBe(true);
  });
});

describe('completion stats', () => {
  it('counts fallback-sourced messages separately and includes blanks as decided', () => {
    const catalog = {
      a: makeMsg({sourceText: 'A', entries: {'fr-FR': {value: 'A-fr', version: 1, basedOnSourceVersion: 1}}}),
      b: makeMsg({sourceText: 'B'}),
      c: makeMsg({
        sourceText: 'C',
        entries: {
          'fr-FR': {value: '', version: 1, basedOnSourceVersion: 1},
        },
      }),
    };
    const stats = computeStats(catalog, chains, 'fr-CA');
    expect(stats.total).toBe(3);
    expect(stats.ownText).toBe(0);
    expect(stats.fallbackCount).toBe(2); // a -> fr-FR text, b -> en
    expect(stats.fallbackBlank).toBe(1); // c -> fr-FR blank
    expect(stats.coverage).toBe(1);
  });

  it('counts stale entries when source moved on while still serving old text', () => {
    const catalog = {
      a: makeMsg({
        sourceText: 'New EN',
        sourceVersion: 4,
        entries: {'fr-FR': {value: 'Vieux FR', version: 1, basedOnSourceVersion: 2}},
      }),
    };
    const stats = computeStats(catalog, chains, 'fr-FR');
    expect(stats.stale).toBe(1);
    expect(resolveMessage(catalog.a, 'fr-FR', chains).text).toBe('Vieux FR');
  });
});
