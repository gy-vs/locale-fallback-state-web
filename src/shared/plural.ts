import type {Locale} from './locales';

/**
 * Cardinal plural rules, transcribed by hand from CLDR v46
 * common/supplemental/pluralRules.xml (verified against cldr-core@46
 * supplemental/plurals.json). Only the locales this workbench manages
 * are encoded; no i18n runtime library is involved.
 *
 * Category sets required by validation:
 *   en    : one, other
 *   fr-FR : one, many, other   (one covers i = 0,1)
 *   fr-CA : one, many, other   (same rule as fr)
 *   pt-BR : one, many, other   (one covers i = 0,1)
 *   pt-PT : one, many, other   (one is exactly i = 1 and v = 0)
 */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/** A raw rule line, without the "@example" annotations. */
type RuleSet = Partial<Record<PluralCategory, string>>;

const MILLION_RULE =
  'e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5';

const PLURAL_RULES: Record<string, RuleSet> = {
  en: {one: 'i = 1 and v = 0', other: ''},
  fr: {one: 'i = 0,1', many: MILLION_RULE, other: ''},
  pt: {one: 'i = 0..1', many: MILLION_RULE, other: ''},
  'pt-PT': {one: 'i = 1 and v = 0', many: MILLION_RULE, other: ''},
};

export function ruleSetForLocale(locale: Locale): RuleSet {
  if (locale === 'pt-PT') return PLURAL_RULES['pt-PT'];
  if (locale === 'pt-BR') return PLURAL_RULES.pt;
  if (locale.startsWith('fr')) return PLURAL_RULES.fr;
  return PLURAL_RULES.en;
}

/** CLDR plural operands (https://cldr.unicode.org/index/cldr-spec/plural-rules). */
export interface Operands {
  n: number;
  i: bigint; // integer digits
  v: number;
  w: number;
  f: bigint; // visible fraction digits
  t: bigint; // visible fraction digits without trailing zeros
  c: number;
  e: number;
}

export function parseOperands(value: number): Operands {
  if (!Number.isFinite(value)) {
    return {n: value, i: 0n, v: 0, w: 0, f: 0n, t: 0n, c: 0, e: 0};
  }
  const decimals = String(value);
  // The "e"/"c" operands come from compact/exponent *notation* (1c6):
  // they are 0 for plain decimal input, even when the number is large.
  // String(1234567) is plain digits; String(1e21) carries an exponent.
  const ePos = decimals.toLowerCase().indexOf('e');
  const compact = ePos !== -1;
  const abs = Math.abs(value);
  let e = 0;
  if (compact && abs !== 0) {
    e = Number(decimals.slice(ePos + 1));
  }
  const c = e;

  // Expand to exact decimal digits (scientific notation included) so the
  // integer operands stay exact: 1e21 % 1e6 is 0 mathematically, not the
  // IEEE-754 float remainder.
  const decimal = toDecimalDigits(abs);
  const dot = decimal.indexOf('.');
  const intDigits = dot === -1 ? decimal : decimal.slice(0, dot);
  const fracPartRaw = dot === -1 ? '' : decimal.slice(dot + 1);
  const trimmedFrac = fracPartRaw.replace(/0+$/, '');
  return {
    n: abs,
    i: BigInt(intDigits || '0'),
    v: fracPartRaw.length,
    w: trimmedFrac.length,
    f: fracPartRaw === '' ? 0n : BigInt(fracPartRaw),
    t: trimmedFrac === '' ? 0n : BigInt(trimmedFrac),
    c,
    e,
  };
}

/** Turn a finite non-negative JS number into plain decimal digits without exponent. */
function toDecimalDigits(abs: number): string {
  const str = String(abs);
  const ePos = str.toLowerCase().indexOf('e');
  if (ePos === -1) return str;
  const exponent = Number(str.slice(ePos + 1));
  const mantissaSource = str.slice(0, ePos);
  const dot = mantissaSource.indexOf('.');
  const digits = mantissaSource.replace('.', '');
  const intLen = dot === -1 ? digits.length : dot;
  const newPos = intLen + exponent;
  if (newPos <= 0) return '0.' + '0'.repeat(-newPos) + digits;
  if (newPos >= digits.length) return digits + '0'.repeat(newPos - digits.length);
  return digits.slice(0, newPos) + '.' + digits.slice(newPos);
}

type Token =
  | {kind: 'num'; value: bigint}
  | {kind: 'range'; from: bigint; to: bigint}
  | {kind: 'op'; value: '=' | '!='}
  | {kind: 'operand'; value: keyof Operands}
  | {kind: 'mod'}
  | {kind: 'and' | 'or'};

function tokenize(rule: string): Token[] {
  const tokens: Token[] = [];
  const re = /(?<![A-Za-z])(n|i|v|w|f|t|c|e)(?![A-Za-z])|(\d+)\.\.(\d+)|(\d+)|(!=|=|%)|(\band\b|\bor\b)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rule))) {
    if (match[1]) tokens.push({kind: 'operand', value: match[1] as keyof Operands});
    else if (match[2]) tokens.push({kind: 'range', from: BigInt(match[2]), to: BigInt(match[3])});
    else if (match[4] !== undefined) tokens.push({kind: 'num', value: BigInt(match[4])});
    else if (match[5] === '=') tokens.push({kind: 'op', value: '='});
    else if (match[5] === '!=') tokens.push({kind: 'op', value: '!='});
    else if (match[5] === '%') tokens.push({kind: 'mod'});
    else if (match[6] === 'and') tokens.push({kind: 'and'});
    else if (match[6] === 'or') tokens.push({kind: 'or'});
  }
  return tokens;
}

/** Evaluate one CLDR plural condition (an "or" of "and" relations). */
export function evalCondition(rule: string, value: number): boolean {
  const cond = rule.replace(/@.*/, '').trim();
  if (!cond) return true; // bare other rule
  return evalOr(tokenize(cond), parseOperands(value));
}

function evalOr(tokens: Token[], ops: Operands): boolean {
  return splitOn(tokens, 'or').some(part => evalAnd(part, ops));
}

function evalAnd(tokens: Token[], ops: Operands): boolean {
  return splitOn(tokens, 'and').every(part => evalRelation(part, ops));
}

function splitOn(tokens: Token[], kind: 'and' | 'or'): Token[][] {
  const groups: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === kind) groups.push([]);
    else groups[groups.length - 1].push(token);
  }
  return groups;
}

function operandNumber(ops: Operands, name: keyof Operands): bigint {
  const value = ops[name];
  return typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
}

/** relation = operand [% num] (= | !=) rangeList */
function evalRelation(tokens: Token[], ops: Operands): boolean {
  let idx = 0;
  const operand = tokens[idx++];
  if (operand?.kind !== 'operand') return false;
  let actual = operandNumber(ops, operand.value);
  if (tokens[idx]?.kind === 'mod') {
    idx += 1;
    const divisor = tokens[idx++];
    if (divisor?.kind !== 'num') return false;
    actual = actual % divisor.value;
  }
  const opToken = tokens[idx++];
  if (opToken?.kind !== 'op') return false;
  let matched = false;
  for (const valueToken of tokens.slice(idx)) {
    if (valueToken.kind === 'num') matched = matched || actual === valueToken.value;
    else if (valueToken.kind === 'range')
      matched = matched || (actual >= valueToken.from && actual <= valueToken.to);
    // commas are simply skipped (range list separators)
  }
  return opToken.value === '!=' ? !matched : matched;
}

/**
 * Select the plural category for a value. Rules are tested in the order
 * given by CLDR; "other" (possibly an empty rule) is the fallback.
 */
export function selectPlural(locale: Locale, value: number): PluralCategory {
  const rules = ruleSetForLocale(locale);
  for (const category of Object.keys(rules)) {
    if (category === 'other') continue;
    if (evalCondition(rules[category as PluralCategory]!, value)) return category as PluralCategory;
  }
  return 'other';
}

/** Category labels that a translation for this locale must provide. */
export function requiredCategories(locale: Locale): PluralCategory[] {
  return Object.keys(ruleSetForLocale(locale)) as PluralCategory[];
}
