import {requiredCategories, selectPlural, type PluralCategory} from './plural';
import type {Locale} from './locales';

/**
 * A hand-written parser/formatters for the ICU MessageFormat subset used by
 * this workbench:
 *   - literal text, with '' / '{...}' style apostrophe escaping
 *   - simple arguments:            {name}
 *   - plural blocks:               {count, plural, one {...} other {...}}
 *     exact-case variants (=0) are accepted, and '#' inside a plural
 *     variant renders as the (possibly offset) matched number.
 * No i18n runtime library is used.
 */

export interface MessageNode {
  parts: MessagePart[];
}
export type MessagePart =
  | {kind: 'text'; value: string}
  | {kind: 'arg'; name: string}
  | {kind: 'hash'}
  | {kind: 'plural'; arg: string; offset: number; variants: PluralVariant[]};
export interface PluralVariant {
  /** Keyword ("one", …) or exact value ("=3"). */
  key: string;
  exact: number | null;
  category: PluralCategory | null;
  message: MessageNode;
}

export interface MessageError {
  message: string;
  index: number;
}

class Scanner {
  pos = 0;
  constructor(readonly src: string) {}
  get done(): boolean {
    return this.pos >= this.src.length;
  }
  peek(at = 0): string {
    return this.src[this.pos + at] ?? '';
  }
  next(): string {
    return this.src[this.pos++] ?? '';
  }
  error(message: string, index = this.pos): MessageError {
    return {message, index};
  }
}

/** Parse a message body; returns either an AST or the first syntax error. */
export function parseMessage(src: string): {ast: MessageNode} | {errors: MessageError[]} {
  const scanner = new Scanner(src);
  const errors: MessageError[] = [];
  const ast = parseParts(scanner, errors, false);
  if (!scanner.done) errors.push(scanner.error('unexpected trailing input'));
  return errors.length ? {errors} : {ast};
}

/** Parse parts up to '}' (when inBlock) or end of input. */
function parseParts(scanner: Scanner, errors: MessageError[], inBlock: boolean): MessageNode {
  const parts: MessagePart[] = [];
  let text = '';
  const pushText = () => {
    if (text) parts.push({kind: 'text', value: text});
    text = '';
  };
  while (!scanner.done) {
    const ch = scanner.peek();
    if (ch === '}' && inBlock) {
      scanner.next();
      break;
    }
    if (ch === "'") {
      text += parseQuoted(scanner);
      continue;
    }
    if (ch === '#') {
      scanner.next();
      pushText();
      parts.push({kind: 'hash'});
      continue;
    }
    if (ch === '{') {
      scanner.next();
      pushText();
      const block = parseBlock(scanner, errors);
      if (block) parts.push(block);
      continue;
    }
    text += scanner.next();
  }
  pushText();
  return {parts};
}

/**
 * Handle an apostrophe. Two apostrophes produce one; a single apostrophe
 * quotes until the next apostrophe. An unmatched quote is tolerated: the
 * rest of the input is treated as literal text.
 */
function parseQuoted(scanner: Scanner): string {
  scanner.next(); // opening '
  if (scanner.peek() === "'") {
    scanner.next();
    return "'";
  }
  let out = '';
  while (!scanner.done) {
    const ch = scanner.next();
    if (ch === "'") return out;
    out += ch;
  }
  return out;
}

function skipSpaces(scanner: Scanner): void {
  while (!scanner.done && /\s/.test(scanner.peek())) scanner.next();
}

function readIdentifier(scanner: Scanner): string {
  let name = '';
  while (!scanner.done && /[A-Za-z0-9_]/.test(scanner.peek())) name += scanner.next();
  return name;
}

/** Scanner is positioned just after the opening '{'. */
function parseBlock(scanner: Scanner, errors: MessageError[]): MessagePart | null {
  skipSpaces(scanner);
  const arg = readIdentifier(scanner);
  if (!arg) {
    errors.push(scanner.error('expected argument name'));
    recoverToBlockEnd(scanner);
    return null;
  }
  skipSpaces(scanner);
  if (scanner.peek() === '}') {
    scanner.next();
    return {kind: 'arg', name: arg};
  }
  if (scanner.peek() !== ',') {
    errors.push(scanner.error("expected ',' or '}' after argument name"));
    recoverToBlockEnd(scanner);
    return null;
  }
  scanner.next();
  skipSpaces(scanner);
  const type = readIdentifier(scanner);
  skipSpaces(scanner);
  if (scanner.peek() !== ',') {
    errors.push(scanner.error(`malformed ${type || 'argument'} block`));
    recoverToBlockEnd(scanner);
    return null;
  }
  scanner.next();
  if (type === 'plural' || type === 'selectordinal') {
    return parsePluralBody(scanner, errors, arg);
  }
  errors.push(scanner.error(`unsupported format "${type || '?'}" (only plural is supported)`));
  recoverToBlockEnd(scanner);
  return null;
}

/** Scanner is positioned after "arg, plural,". */
function parsePluralBody(scanner: Scanner, errors: MessageError[], arg: string): MessagePart | null {
  let offset = 0;
  const variants: PluralVariant[] = [];
  for (;;) {
    skipSpaces(scanner);
    if (scanner.done) {
      errors.push(scanner.error('unterminated plural block'));
      return null;
    }
    if (scanner.peek() === '}') {
      scanner.next();
      break;
    }
    const label = readPluralLabel(scanner);
    if (label === null) {
      errors.push(scanner.error('expected plural category (one, other, =N …) or offset:N'));
      recoverToBlockEnd(scanner);
      return null;
    }
    if (label.keyword === 'offset') {
      offset = label.offset ?? 0;
      continue;
    }
    skipSpaces(scanner);
    if (scanner.peek() !== '{') {
      errors.push(scanner.error("expected '{' after plural category"));
      recoverToBlockEnd(scanner);
      return null;
    }
    scanner.next();
    const message = parseParts(scanner, errors, true);
    const key = label.keyword ?? `=${label.exact}`;
    variants.push({
      key,
      exact: label.exact,
      category: label.keyword ? (label.keyword as PluralCategory) : null,
      message,
    });
  }
  if (!variants.some(v => v.key === 'other')) {
    errors.push(scanner.error('plural block must contain an "other" variant'));
  }
  return {kind: 'plural', arg, offset, variants};
}

function readPluralLabel(scanner: Scanner):
  | {keyword: string | null; exact: number | null; offset: number | null} | null {
  if (scanner.peek() === '=') {
    scanner.next();
    let digits = '';
    while (!scanner.done && /\d/.test(scanner.peek())) digits += scanner.next();
    if (!digits) return null;
    return {keyword: null, exact: Number(digits), offset: null};
  }
  const word = readIdentifier(scanner);
  if (!word) return null;
  if (word === 'offset') {
    skipSpaces(scanner);
    if (scanner.peek() === ':') scanner.next();
    let digits = '';
    while (!scanner.done && /\d/.test(scanner.peek())) digits += scanner.next();
    return {keyword: 'offset', exact: null, offset: digits ? Number(digits) : 0};
  }
  return {keyword: word, exact: null, offset: null};
}

/** Consume up to and including the matching closing brace. */
function recoverToBlockEnd(scanner: Scanner): void {
  let depth = 1;
  while (!scanner.done && depth > 0) {
    const ch = scanner.next();
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
}

/* ----------------------------- introspection ---------------------------- */

export interface MessageShape {
  args: string[];
  plurals: {arg: string; categories: string[]; exact: string[]}[];
}

export function describeMessage(src: string): {shape?: MessageShape; errors: MessageError[]} {
  const parsed = parseMessage(src);
  if ('errors' in parsed) return {errors: parsed.errors};
  const args = new Set<string>();
  const plurals: MessageShape['plurals'] = [];
  walk(parsed.ast, node => {
    if (node.kind === 'arg') args.add(node.name);
    if (node.kind === 'plural') {
      args.add(node.arg);
      plurals.push({
        arg: node.arg,
        categories: node.variants.filter(v => v.category).map(v => v.key),
        exact: node.variants.filter(v => v.exact !== null).map(v => v.key),
      });
    }
  });
  return {shape: {args: [...args], plurals}, errors: []};
}

function walk(node: MessageNode, visit: (part: MessagePart) => void): void {
  for (const part of node.parts) {
    visit(part);
    if (part.kind === 'plural') for (const variant of part.variants) walk(variant.message, visit);
  }
}

/* ------------------------------ validation ------------------------------ */

/**
 * Validate a translation against its English source.
 *  - both must parse
 *  - the set of placeholder arguments must be identical
 *  - plural control args and nesting must match
 *  - every CLDR category needed by the locale must be present in each plural
 */
export function validateTranslation(
  locale: Locale,
  sourceSrc: string,
  translationSrc: string,
): MessageError[] {
  const source = describeMessage(sourceSrc);
  if (source.errors.length) return source.errors;
  const translation = describeMessage(translationSrc);
  if (translation.errors.length) return translation.errors;

  const errors: MessageError[] = [];
  const sourceArgs = new Set(source.shape!.args);
  const translatedArgs = new Set(translation.shape!.args);
  for (const arg of sourceArgs)
    if (!translatedArgs.has(arg)) errors.push({message: `missing placeholder {${arg}}`, index: 0});
  for (const arg of translatedArgs)
    if (!sourceArgs.has(arg)) errors.push({message: `unknown placeholder {${arg}} (not in English source)`, index: 0});

  for (let i = 0; i < source.shape!.plurals.length; i += 1) {
    const sourcePlural = source.shape!.plurals[i];
    const translatedPlural = translation.shape!.plurals[i];
    if (!translatedPlural || translatedPlural.arg !== sourcePlural.arg) {
      errors.push({message: `plural block on ${sourcePlural.arg} is missing or reordered`, index: 0});
      continue;
    }
    const needed = requiredCategories(locale);
    for (const category of needed) {
      if (!translatedPlural.categories.includes(category)) {
        errors.push({message: `${locale} requires the "${category}" plural category`, index: 0});
      }
    }
  }
  if (translation.shape!.plurals.length > source.shape!.plurals.length) {
    errors.push({message: 'translation contains plural blocks not present in the English source', index: 0});
  }
  return errors;
}

/* ------------------------------ formatting ------------------------------ */

export type Values = Record<string, string | number | undefined>;

export function formatMessage(src: string, locale: Locale, values: Values = {}): string {
  const parsed = parseMessage(src);
  if ('errors' in parsed) return src;
  return renderNode(parsed.ast, locale, values, null);
}

function renderNode(
  node: MessageNode,
  locale: Locale,
  values: Values,
  plural: {value: number; hash: number} | null,
): string {
  let out = '';
  for (const part of node.parts) {
    if (part.kind === 'text') out += part.value;
    else if (part.kind === 'arg') {
      const value = values[part.name];
      out += value === undefined ? `{${part.name}}` : String(value);
    } else if (part.kind === 'hash') {
      out += plural ? formatNumber(locale, plural.hash) : '#';
    } else if (part.kind === 'plural') {
      out += renderPlural(part, locale, values);
    }
  }
  return out;
}

function renderPlural(part: Extract<MessagePart, {kind: 'plural'}>, locale: Locale, values: Values): string {
  const raw = values[part.arg];
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  const value = Number.isFinite(numeric) ? numeric : 0;
  const exact = part.variants.find(v => v.exact === value);
  const category = selectPlural(locale, value);
  const variant = exact ?? part.variants.find(v => v.category === category) ?? part.variants.find(v => v.key === 'other');
  if (!variant) return '';
  const hash = value - part.offset;
  return renderNode(variant.message, locale, values, {value, hash});
}

const numberFormatters = new Map<Locale, Intl.NumberFormat>();
function formatNumber(locale: Locale, value: number): string {
  let formatter = numberFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale);
    numberFormatters.set(locale, formatter);
  }
  return formatter.format(value);
}
