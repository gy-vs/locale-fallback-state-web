import {describe, expect, it} from 'vitest';
import {
  describeShape,
  parseMessage,
  render,
  tryParse,
  validateSource,
  validateTranslation,
} from '../src/shared/message';

describe('message parser', () => {
  it('parses plain text and simple args', () => {
    const ast = parseMessage('Hello {name}, welcome!');
    expect(ast).toEqual([
      {kind: 'text', value: 'Hello '},
      {kind: 'arg', name: 'name'},
      {kind: 'text', value: ', welcome!'},
    ]);
  });

  it('parses plural blocks with categories', () => {
    const ast = parseMessage('{count, plural, one {# item} other {# items}}');
    const shape = describeShape(ast);
    expect(shape.pluralArgs).toEqual(['count']);
    expect(shape.pluralOptions[0].selectors).toEqual(['one', 'other']);
    expect(shape.args).toContain('count');
  });

  it('supports exact =N selectors and offset', () => {
    const ast = parseMessage('{n, plural, offset:1 =0 {none} =1 {one left} other {# left}}');
    const shape = describeShape(ast);
    expect(shape.pluralOptions[0].selectors).toEqual(['=0', '=1', 'other']);
    expect(render(ast, {n: 1}, 'en').text).toBe('none');
    expect(render(ast, {n: 2}, 'en').text).toBe('one left');
    expect(render(ast, {n: 5}, 'en').text).toBe('4 left');
  });

  it('rejects unsupported arg types and bad syntax', () => {
    expect(tryParse('{count, select, a {b} other {c}}').error).not.toBeNull();
    expect(tryParse('{name').error).not.toBeNull();
    expect(tryParse('oops }').error).not.toBeNull();
    expect(tryParse("{count, plural, one {} other {x}}").error).not.toBeNull();
    expect(tryParse('{count, plural, one {x}').error).not.toBeNull();
  });

  it('handles quoted text and apostrophes', () => {
    const ast = parseMessage("Aujourd''hui {day}");
    expect(render(ast, {day: 'lundi'}, 'fr-FR').text).toBe("Aujourd'hui lundi");
    const quoted = parseMessage("'{braces}' stay literal");
    expect(render(quoted, {}, 'en').text).toBe('{braces} stay literal');
  });
});

describe('plural rendering per CLDR', () => {
  const msg = '{count, plural, one {ONE #} many {MANY #} other {OTHER #}}';
  const ast = parseMessage(msg);

  it('en: only 1 is one, 0 is other', () => {
    expect(render(ast, {count: 0}, 'en').text).toBe('OTHER 0');
    expect(render(ast, {count: 1}, 'en').text).toBe('ONE 1');
    expect(render(ast, {count: 2}, 'en').text).toBe('OTHER 2');
  });

  it('fr: 0 and 1 are one; exact millions are many', () => {
    expect(render(ast, {count: 0}, 'fr-FR').text).toBe('ONE 0');
    expect(render(ast, {count: 1}, 'fr-CA').text).toBe('ONE 1');
    expect(render(ast, {count: 2}, 'fr-FR').text).toBe('OTHER 2');
    expect(render(ast, {count: 1_000_000}, 'fr-FR').text).toBe('MANY 1000000');
    expect(render(ast, {count: 2_000_000}, 'fr-CA').text).toBe('MANY 2000000');
    expect(render(ast, {count: 999_999}, 'fr-FR').text).toBe('OTHER 999999');
    expect(render(ast, {count: 0.5}, 'fr-FR').text).toBe('ONE 0.5');
  });

  it('pt-BR: 0 is one; pt-PT: 0 is other', () => {
    expect(render(ast, {count: 0}, 'pt-BR').text).toBe('ONE 0');
    expect(render(ast, {count: 0}, 'pt-PT').text).toBe('OTHER 0');
    expect(render(ast, {count: 1}, 'pt-PT').text).toBe('ONE 1');
    expect(render(ast, {count: 1_000_000}, 'pt-BR').text).toBe('MANY 1000000');
    expect(render(ast, {count: 1_000_000}, 'pt-PT').text).toBe('MANY 1000000');
    expect(render(ast, {count: 1.5}, 'pt-BR').text).toBe('ONE 1.5');
    expect(render(ast, {count: 1.5}, 'pt-PT').text).toBe('OTHER 1.5');
  });

  it('falls back to other for decimals and reports missing args', () => {
    const result = render(ast, {}, 'en');
    expect(result.text).toBe('OTHER {count}');
    expect(result.missingArgs).toEqual(['count']);
  });
});

describe('translation validation against English source', () => {
  const source = '{name} has {count, plural, one {# item} other {# items}}';

  it('accepts a structurally identical translation with required locale categories', () => {
    const ok = '{name} a {count, plural, one {# article} many {# millions} other {# articles}}';
    expect(validateTranslation(source, ok, 'fr-FR').filter(d => d.level === 'error')).toEqual([]);
  });

  it('requires many for fr/pt but en only needs one/other', () => {
    const noMany = '{name} hat {count, plural, one {# Artikel} other {# Artikel}}';
    const enErrors = validateTranslation(source, noMany, 'en').filter(d => d.level === 'error');
    const frErrors = validateTranslation(source, noMany, 'fr-FR');
    expect(enErrors).toEqual([]);
    expect(frErrors.some(d => d.message.includes('many'))).toBe(true);
  });

  it('rejects missing or extra placeholders', () => {
    const missingArg = '{count, plural, one {# truc} many {# M} other {# trucs}}';
    const extraArg = '{name}! {count, plural, one {# x} other {# x}} {extra}';
    expect(validateTranslation(source, missingArg, 'fr-FR').some(d => d.message.includes('{name}'))).toBe(true);
    expect(validateTranslation(source, extraArg, 'fr-FR').some(d => d.message.includes('{extra}'))).toBe(true);
  });

  it('rejects a missing plural block entirely', () => {
    const diags = validateTranslation(source, '{name}: {count}', 'fr-FR');
    expect(diags.some(d => d.message.includes('many'))).toBe(true);
  });

  it('treats empty target as intentional blank (always valid)', () => {
    expect(validateTranslation(source, '', 'pt-PT')).toEqual([]);
  });

  it('validates the English source itself requires other', () => {
    expect(validateSource('{n, plural, one {x}}').some(d => d.level === 'error')).toBe(true);
    expect(validateSource('plain {x}').filter(d => d.level === 'error')).toEqual([]);
  });
});
