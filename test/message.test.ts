import {describe, expect, it} from 'vitest';
import {
  describeMessage,
  formatMessage,
  parseMessage,
  validateTranslation,
  type MessageError,
} from '../src/shared/message';
import {
  evalCondition,
  requiredCategories,
  selectPlural,
} from '../src/shared/plural';

function errorsOf(src: string): MessageError[] {
  const parsed = parseMessage(src);
  return 'errors' in parsed ? parsed.errors : [];
}

describe('message parser', () => {
  it('parses plain text and simple placeholders', () => {
    const parsed = parseMessage('Hi {name}, welcome back');
    expect(parsed).toMatchObject({ast: {}});
    expect(formatMessage('Hi {name}, welcome back', 'en', {name: 'Ari'})).toBe(
      'Hi Ari, welcome back',
    );
  });

  it('leaves missing placeholders visible instead of crashing', () => {
    expect(formatMessage('Hi {name}', 'en', {})).toBe('Hi {name}');
  });

  it('handles apostrophe escaping', () => {
    expect(formatMessage("It''s here", 'en', {})).toBe("It's here");
    expect(formatMessage("'{not a placeholder}'", 'en', {})).toBe('{not a placeholder}');
  });

  it('parses and formats plural blocks, including # substitution', () => {
    const src =
      '{count, plural, one {You have # item} other {You have # items}}';
    expect(formatMessage(src, 'en', {count: 1})).toBe('You have 1 item');
    expect(formatMessage(src, 'en', {count: 3})).toBe('You have 3 items');
    expect(formatMessage(src, 'en', {count: 0})).toBe('You have 0 items');
  });

  it('supports exact variants and nested placeholders', () => {
    const src =
      '{count, plural, =0 {Cart is empty} one {One item for {name}} other {# items for {name}}}';
    expect(formatMessage(src, 'en', {count: 0, name: 'Ari'})).toBe('Cart is empty');
    expect(formatMessage(src, 'en', {count: 1, name: 'Ari'})).toBe('One item for Ari');
    expect(formatMessage(src, 'en', {count: 5, name: 'Ari'})).toBe('5 items for Ari');
  });

  it('lists the shape (args and plural categories)', () => {
    const {shape, errors} = describeMessage(
      '{count, plural, one {# {name}} other {# {name}}}',
    );
    expect(errors).toEqual([]);
    expect(shape?.args.sort()).toEqual(['count', 'name']);
    expect(shape?.plurals[0]).toMatchObject({arg: 'count', categories: ['one', 'other']});
  });

  it('reports syntax errors rather than throwing', () => {
    expect(errorsOf('{count, plural, one {x}').length).toBeGreaterThan(0);
    expect(errorsOf('{count, plural, one {x}}')[0]?.message).toContain('other');
    expect(errorsOf('{').length).toBeGreaterThan(0);
  });
});

describe('translation validation against English source', () => {
  const source = '{count, plural, one {# item for {name}} other {# items for {name}}}';

  it('accepts matching placeholders and category sets', () => {
    const fr =
      '{count, plural, one {# article pour {name}} many {# articles pour {name}} other {# articles pour {name}}}';
    expect(validateTranslation('fr-FR', source, fr)).toEqual([]);
  });

  it('rejects missing/extra placeholders', () => {
    const missingName = '{count, plural, one {# article} many {x} other {# articles}}';
    const messages = validateTranslation('fr-FR', source, missingName).map(e => e.message);
    expect(messages).toContain('missing placeholder {name}');
    const extra =
      '{count, plural, one {# article {name} {extra}} many {# {name} {extra}} other {# {name} {extra}}}';
    expect(validateTranslation('fr-FR', source, extra)[0]?.message).toContain('unknown placeholder');
  });

  it('requires one/many/other for French and both Portuguese variants', () => {
    for (const locale of ['fr-FR', 'fr-CA', 'pt-BR', 'pt-PT'] as const) {
      expect(requiredCategories(locale)).toEqual(['one', 'many', 'other']);
      const onlyOneOther = '{count, plural, one {# x} other {# x}}';
      const messages = validateTranslation(locale, source, onlyOneOther).map(e => e.message);
      expect(messages).toContain(`${locale} requires the "many" plural category`);
    }
  });

  it('only needs one/other for English', () => {
    expect(requiredCategories('en')).toEqual(['one', 'other']);
    expect(
      validateTranslation(
        'en',
        '{count, plural, one {#} other {#}}',
        '{count, plural, one {#} other {#}}',
      ),
    ).toEqual([]);
  });

  it('rejects syntactically invalid translations', () => {
    expect(validateTranslation('fr-FR', source, '{count, plural, one {x}').length).toBeGreaterThan(0);
  });
});

describe('CLDR v46 cardinal plural rules (hand-written)', () => {
  it('French treats 0 and 1 as one', () => {
    for (const locale of ['fr-FR', 'fr-CA'] as const) {
      expect(selectPlural(locale, 0)).toBe('one');
      expect(selectPlural(locale, 1)).toBe('one');
      expect(selectPlural(locale, 2)).toBe('other');
      expect(selectPlural(locale, 1000000)).toBe('many');
      expect(selectPlural(locale, 1234567)).toBe('other');
      // exact decimal evaluation: 10^21 is an exact multiple of 1e6 under
      // CLDR decimal operands, hence "many" (not the float-remainder result)
      expect(evalCondition('e != 0..5', 1e21)).toBe(true);
    }
  });

  it('Brazilian Portuguese treats 0 and 1 as one, European Portuguese only 1', () => {
    expect(selectPlural('pt-BR', 0)).toBe('one');
    expect(selectPlural('pt-BR', 1)).toBe('one');
    expect(selectPlural('pt-BR', 2)).toBe('other');
    expect(selectPlural('pt-PT', 0)).toBe('other');
    expect(selectPlural('pt-PT', 1)).toBe('one');
  });

  it('matches Intl.PluralRules on all ordinary values', () => {
    const values = [0, 1, 2, 3, 5, 17, 21, 100, 999, 1000, 999999, 1000000, 2000000, 1e7, 1e15, 1e16, 0.5, 1.5];
    for (const locale of ['en', 'fr-FR', 'fr-CA', 'pt-BR', 'pt-PT'] as const) {
      const reference = new Intl.PluralRules(locale);
      for (const value of values) {
        expect(selectPlural(locale, value)).toBe(reference.select(value));
      }
    }
  });
});
