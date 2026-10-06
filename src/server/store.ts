import type {Locale} from '../shared/locales';
import type {KeyRecord, StoredTranslation, WorkbenchState} from '../shared/model';
import {defaultChains} from '../shared/fallback';

/**
 * Seed state reproduces both incidents from the spreadsheet era:
 *  - checkout.title: fr-CA untranslated; it must resolve via fr-FR, not
 *    silently drop to English.
 *  - checkout.optionalTip: the Portuguese team deliberately stored an
 *    explicit empty for pt-PT and pt-BR has text; resolving pt-PT must
 *    render nothing instead of leaking the Brazilian sentence.
 */
const now = Date.now();

function cell(text: string, version = 1, needsReview = false, ageMs = 1000): StoredTranslation {
  return {text, version, needsReview, updatedAt: now - ageMs};
}

export function createSeedState(): WorkbenchState {
  const keys: KeyRecord[] = [
    {
      key: 'checkout.title',
      source: 'Review your order before paying',
      version: 4,
      sourceUpdatedAt: now - 60_000,
      translations: {
        'fr-FR': cell('Vérifiez votre commande avant de payer', 4),
        // fr-CA intentionally missing: expect the fr-FR sentence via fallback.
        'pt-BR': cell('Confira seu pedido antes de pagar', 1),
        'pt-PT': cell('Reveja a sua encomenda antes de pagar', 1),
      },
    },
    {
      key: 'checkout.optionalTip',
      source: 'You can leave a note for the courier (optional)',
      version: 2,
      sourceUpdatedAt: now - 200_000,
      translations: {
        'fr-FR': cell('Vous pouvez laisser un mot au livreur (facultatif)', 2),
        // Explicit empty: translators want nothing shown in Canadian French.
        'fr-CA': cell('', 2),
        'pt-BR': cell('Você pode deixar um recado para o entregador (opcional)', 2),
        // Explicit empty: the reported incident — must NOT resolve to pt-BR.
        'pt-PT': cell('', 1),
      },
    },
    {
      key: 'checkout.itemsCount',
      source: '{count, plural, one {You have # item in your cart} other {You have # items in your cart}}',
      version: 1,
      sourceUpdatedAt: now - 300_000,
      translations: {
        'fr-FR': cell(
          '{count, plural, one {Vous avez # article dans votre panier} many {Vous avez # articles dans votre panier} other {Vous avez # articles dans votre panier}}',
          1,
        ),
        // Stale: predates a source change and is missing the "many" category,
        // so it is also a handy review/validation demo.
        'fr-CA': cell(
          '{count, plural, one {Vous avez # article dans votre panier} other {Vous avez # articles dans votre panier}}',
          1,
          true,
        ),
      },
    },
    {
      key: 'checkout.greeting',
      source: 'Hi {name}, welcome back',
      version: 1,
      sourceUpdatedAt: now - 400_000,
      translations: {
        'fr-FR': cell('Bonjour {name}, bon retour', 1),
        'pt-BR': cell('Olá {name}, bem-vindo de volta', 1),
      },
    },
  ];
  return {keys, fallback: defaultChains()};
}

export type SaveOutcome =
  | {ok: true; cell: StoredTranslation}
  | {ok: false; conflict: true; current: StoredTranslation};

export class TranslationStore {
  private state: WorkbenchState;

  constructor(seed?: WorkbenchState) {
    this.state = seed ?? createSeedState();
  }

  snapshot(): WorkbenchState {
    return this.state;
  }

  findKey(key: string): KeyRecord | undefined {
    return this.state.keys.find(record => record.key === key);
  }

  /** Replace one locale's fallback chain (already validated by caller). */
  setChain(locale: Locale, chain: Locale[]): void {
    this.state.fallback[locale] = chain;
  }

  /** Edit the English source; every existing translation becomes stale. */
  setSource(key: string, source: string): {record: KeyRecord; cell: StoredTranslation} | null {
    const record = this.findKey(key);
    if (!record) return null;
    if (record.source === source) return {record, cell: {...cellFromSource(record)}};
    record.source = source;
    record.version += 1;
    record.sourceUpdatedAt = Date.now();
    for (const locale of Object.keys(record.translations) as Locale[]) {
      const stored = record.translations[locale];
      if (stored) stored.needsReview = true;
    }
    return {record, cell: {...cellFromSource(record)}};
  }

  addKey(key: string, source: string): KeyRecord | null {
    if (this.findKey(key)) return null;
    const record: KeyRecord = {
      key,
      source,
      version: 1,
      sourceUpdatedAt: Date.now(),
      translations: {},
    };
    this.state.keys.push(record);
    return record;
  }

  /**
   * Save a translation with optimistic concurrency. The client sends the
   * version it edited from; a stale write loses to the newer one instead
   * of clobbering it.
   */
  saveTranslation(
    key: string,
    locale: Locale,
    text: string,
    baseVersion: number,
  ): SaveOutcome | 'no-key' {
    const record = this.findKey(key);
    if (!record) return 'no-key';
    const existing = record.translations[locale];
    if (existing && existing.version !== baseVersion) {
      return {ok: false, conflict: true, current: existing};
    }
    const cell: StoredTranslation = existing
      ? {...existing, text, version: existing.version + 1, needsReview: false, updatedAt: Date.now()}
      : {text, version: 1, needsReview: false, updatedAt: Date.now()};
    record.translations[locale] = cell;
    return {ok: true, cell};
  }

  /** Translator signed off the current text after a source change. */
  markReviewed(key: string, locale: Locale): StoredTranslation | null {
    const record = this.findKey(key);
    if (!record) return null;
    const existing = record.translations[locale];
    if (!existing) return null;
    existing.needsReview = false;
    return existing;
  }
}

function cellFromSource(record: KeyRecord): StoredTranslation {
  return {text: record.source, version: record.version, needsReview: false, updatedAt: record.sourceUpdatedAt};
}
