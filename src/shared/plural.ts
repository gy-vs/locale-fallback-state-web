import type {Locale} from './types';

/**
 * CLDR 复数规则（cardinal），手写实现，不依赖任何 i18n 库。
 *
 * 规则依据 CLDR 46（supplemental/plurals.xml），并用 Node 自带 ICU
 * （Intl.PluralRules, ICU 78.2）逐个取值核对：
 *
 *   en    one: v = 0 and i = 1
 *   fr-FR one: i = 0,1 within 0..1 + 带小数时 i=0
 *         many: e = 0 and i != 0 and 1000000 % i == 0   ← "1 million / 2 millions"
 *   fr-CA 同 fr-FR
 *   pt-BR one: i = 0,1 within 0..1 + 带小数时 i=0；many 同法语
 *   pt-PT one: i = 1 and v = 0（注意：0 在葡葡里是 other，与巴西葡语不同）；many 同上
 *
 * 因而本项目所有语言都需要提供 one / other；法语与两种葡语还必须提供 many。
 */

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export interface PluralOperand {
  /** n：绝对值（按十进制能表示的值）。 */
  n: number;
  /** i：整数部分数字。 */
  i: number;
  /** v：小数位数（非紧凑十进制输入下即小数部分长度）。 */
  v: number;
  /** f：小数部分数字。 */
  f: number;
  /** e：紧凑十进制指数；普通数字恒为 0。 */
  e: number;
}

export function operandFromValue(value: number | bigint): PluralOperand {
  if (typeof value === 'bigint') {
    return {n: Number(value < 0n ? -value : value), i: Number(value < 0n ? -value : value), v: 0, f: 0, e: 0};
  }
  const abs = Math.abs(value);
  const decimal = String(abs);
  const dot = decimal.indexOf('.');
  const fracDigits = dot === -1 ? '' : decimal.slice(dot + 1);
  const i = Math.trunc(abs);
  return {
    n: abs,
    i,
    v: fracDigits.length,
    f: fracDigits.length === 0 ? 0 : Number(fracDigits),
    e: 0, // 不处理紧凑十进制（compact notation）
  };
}

const isOne = (op: PluralOperand) => op.i === 1 && op.v === 0;

/** 法语/葡语的 many：整数、非零且被 1,000,000 整除（2 millions、3 milhões…）。 */
const isMillion = (op: PluralOperand) =>
  op.e === 0 && op.v === 0 && op.i !== 0 && op.i % 1_000_000 === 0;

/** fr 的 one：|n| 的整数部分为 0 或 1（0 和 1 用单数形式）。 */
const isFrenchOne = (op: PluralOperand) => op.i === 0 || op.i === 1;

/** pt-BR 的 one：与法语同（0、1 用单数形式）。 */
const isBrazilianPortugueseOne = isFrenchOne;

/** pt-PT 的 one：仅 n = 1（0 用 plural）。 */
const isEuropeanPortugueseOne = isOne;

export function selectCategory(locale: Locale, value: number | bigint): PluralCategory {
  const op = operandFromValue(value);
  switch (locale) {
    case 'en':
      return isOne(op) ? 'one' : 'other';
    case 'fr-FR':
    case 'fr-CA':
      if (isFrenchOne(op)) return 'one';
      if (isMillion(op)) return 'many';
      return 'other';
    case 'pt-BR':
      if (isBrazilianPortugueseOne(op)) return 'one';
      if (isMillion(op)) return 'many';
      return 'other';
    case 'pt-PT':
      if (isEuropeanPortugueseOne(op)) return 'one';
      if (isMillion(op)) return 'many';
      return 'other';
  }
}

/** 每种语言写复数块时必须给齐的类别（其余类别可选）。 */
export function requiredCategories(locale: Locale): PluralCategory[] {
  switch (locale) {
    case 'en':
      return ['one', 'other'];
    case 'fr-FR':
    case 'fr-CA':
    case 'pt-BR':
    case 'pt-PT':
      return ['one', 'many', 'other'];
  }
}
