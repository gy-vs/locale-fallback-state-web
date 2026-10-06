import type {Locale} from './types';
import {requiredCategories, selectCategory, type PluralCategory} from './plural';

/**
 * 自写的 ICU MessageFormat 子集解析器。
 * 不使用 i18next / formatjs / intl-messageformat / messageformat。
 *
 * 支持：
 *   {name}                              占位符
 *   {count, plural, one {...} other {...}}
 *                                       复数块，类别可用 one/many/other…，
 *                                       也可用 =0、=1 这类精确匹配
 *   ''                                  两个连续单引号输出一个单引号
 *
 * 不支持（遇到即报解析错误）：select / selectordinal / {number,…} 等嵌套参数类型。
 */

export interface PluralOption {
  /** 类别名（one/many/other…）或精确匹配（{ exact: "=1" }）。 */
  selector: { kind: 'category'; category: PluralCategory } | { kind: 'exact'; exact: string };
  /** 该分支内部仍然是消息，可继续嵌套占位符与复数块。 */
  body: MessageNode[];
}

export type MessageNode =
  | { kind: 'text'; value: string }
  | { kind: 'arg'; name: string }
  | { kind: 'plural'; arg: string; offset: number; options: PluralOption[] };

export interface ParseError {
  message: string;
  pos?: number;
}

const CATEGORIES = new Set<PluralCategory>(['zero', 'one', 'two', 'few', 'many', 'other']);

class Parser {
  constructor(private readonly src: string) {}

  parse(): MessageNode[] {
    const nodes = this.parseUntil(() => this.pos >= this.src.length);
    return nodes;
  }

  private pos = 0;

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
  }

  private startsAt(pos: number, token: string): boolean {
    return this.src.startsWith(token, pos);
  }

  /** 解析到终止谓词成立（终止符不消费）。 */
  private parseUntil(isEnd: () => boolean): MessageNode[] {
    const nodes: MessageNode[] = [];
    let text = '';
    const pushText = () => {
      if (text) {
        nodes.push({kind: 'text', value: text});
        text = '';
      }
    };
    while (!isEnd()) {
      const ch = this.peek();
      if (ch === "'") {
        text += this.consumeQuoted();
      } else if (ch === '}') {
        throw this.error('多余的右花括号 }');
      } else if (ch === '#' && this.inPlural > 0) {
        // plural 分支内的 # 代表格式化后的复数数字，按等价占位符处理
        pushText();
        nodes.push({kind: 'arg', name: '#'});
        this.pos += 1;
      } else if (ch === '{') {
        pushText();
        nodes.push(this.parseArg());
      } else {
        text += ch;
        this.pos += 1;
      }
    }
    pushText();
    return nodes;
  }

  /**
   * 消费一个引号结构，返回字面文本：
   *   ''    -> '
   *   'xx'  -> xx（里面的花括号没有语法意义）
   */
  private consumeQuoted(): string {
    const start = this.pos;
    if (this.peek(1) === "'") {
      this.pos += 2;
      return "'";
    }
    const closing = this.src.indexOf("'", this.pos + 1);
    if (closing === -1) throw this.error('未闭合的单引号，使用两个连续单引号 \'\' 表示撇号', start);
    const literal = this.src.slice(this.pos + 1, closing);
    this.pos = closing + 1;
    return literal;
  }

  private inPlural = 0;

  private parseArg(): MessageNode {
    // 已确定当前字符是 {
    const start = this.pos;
    this.pos += 1;
    const name = this.readIdentifier();
    this.skipSpaces();
    if (this.peek() === '}') {
      this.pos += 1;
      return {kind: 'arg', name};
    }
    if (this.peek() !== ',') throw this.error(`占位符 {${name} 后应为 } 或 ,`, start);
    this.pos += 1;
    this.skipSpaces();
    const type = this.readWord();
    this.skipSpaces();
    if (type !== 'plural') {
      throw this.error(`不支持的参数类型 "${type}"，本工作台只支持普通占位符与 plural`, start);
    }
    if (this.peek() !== ',') throw this.error(`plural 后应为逗号`, start);
    this.pos += 1;
    this.skipSpaces();
    let offset = 0;
    // offset:N（可选）
    if (this.startsAt(this.pos, 'offset:')) {
      this.pos += 'offset:'.length;
      this.skipSpaces();
      const digits = this.readWhile(ch => /[0-9-]/.test(ch));
      offset = Number(digits);
      if (!Number.isInteger(offset)) throw this.error('offset 必须是整数', start);
      this.skipSpaces();
    }
    const options: PluralOption[] = [];
    while (true) {
      if (this.peek() === '}') break;
      const selectorRaw = this.readWhile(ch => ch !== '{' && ch !== '}');
      const selector = selectorRaw.trim();
      if (!selector) throw this.error('plural 缺少类别（one/many/other 或 =N）', start);
      if (this.peek() !== '{') throw this.error(`plural 类别 ${selector} 后应为 {`, start);
      options.push({selector: this.parseSelector(selector, start), body: this.parsePluralBody()});
      this.skipSpaces();
    }
    this.pos += 1; // 消费 }
    if (options.length === 0) throw this.error('plural 块至少要有一个类别分支', start);
    return {kind: 'plural', arg: name, offset, options};
  }

  private parseSelector(selector: string, start: number): PluralOption['selector'] {
    if (selector.startsWith('=')) {
      // =N：等号后可以有空格（ICU 允许 = 0 写法），数字本身不留空格
      const exact = selector.slice(1).replace(/\s/g, '');
      if (!/^-?\d+(\.\d+)?$/.test(exact)) throw this.error(`无效的精确匹配 ${selector}`, start);
      return {kind: 'exact', exact};
    }
    if (!CATEGORIES.has(selector as PluralCategory)) {
      throw this.error(`未知的复数类别 "${selector}"（可用 zero/one/two/few/many/other 或 =N）`, start);
    }
    return {kind: 'category', category: selector as PluralCategory};
  }

  private parsePluralBody(): MessageNode[] {
    // 当前字符是 {
    this.pos += 1;
    this.inPlural += 1;
    let nodes: MessageNode[];
    try {
      nodes = this.parseUntil(() => this.peek() === '}');
    } finally {
      this.inPlural -= 1;
    }
    if (this.peek() !== '}') throw this.error('plural 分支缺少右花括号 }');
    this.pos += 1;
    if (nodes.length === 0) throw this.error('plural 分支不能为空');
    return nodes;
  }

  private readIdentifier(): string {
    this.skipSpaces();
    const name = this.readWhile(ch => /[A-Za-z0-9_]/.test(ch));
    if (!name) throw this.error('占位符缺少名称');
    return name;
  }

  private readWord(): string {
    return this.readWhile(ch => /[a-z]/i.test(ch));
  }

  private readWhile(predicate: (ch: string) => boolean): string {
    let out = '';
    while (this.pos < this.src.length && predicate(this.peek())) {
      out += this.peek();
      this.pos += 1;
    }
    return out;
  }

  private skipSpaces(): void {
    while (this.pos < this.src.length && /\s/.test(this.peek())) this.pos += 1;
  }

  private error(message: string, pos = this.pos): Error {
    const err = new Error(`${message}（位置 ${pos}）`) as Error & { pos: number };
    err.pos = pos;
    return err;
  }
}

export function parseMessage(input: string): MessageNode[] {
  return new Parser(input).parse();
}

export function tryParse(input: string): { ast: MessageNode[] | null; error: ParseError | null } {
  try {
    return {ast: parseMessage(input), error: null};
  } catch (e) {
    return {
      ast: null,
      error: {message: e instanceof Error ? e.message : String(e), pos: (e as { pos?: number }).pos},
    };
  }
}

/* ----------------------------- 结构与校验 ----------------------------- */

export interface MessageShape {
  /** 直接占位符 {name}（plural 分支里的 # 以 # 出现）。 */
  args: string[];
  /** plural 选择变量名（一个消息里可能有多个 plural）。 */
  pluralArgs: string[];
  /** 每个 plural 变量用到的类别/精确匹配（按出现顺序）。 */
  pluralOptions: { arg: string; selectors: string[] }[];
}

export function describeShape(nodes: MessageNode[]): MessageShape {
  const args = new Set<string>();
  const pluralArgs: string[] = [];
  const pluralOptions: MessageShape['pluralOptions'] = [];
  const walk = (list: MessageNode[]) => {
    for (const node of list) {
      if (node.kind === 'arg') args.add(node.name);
      if (node.kind === 'plural') {
        if (!pluralArgs.includes(node.arg)) pluralArgs.push(node.arg);
        pluralOptions.push({
          arg: node.arg,
          selectors: node.options.map(o => (o.selector.kind === 'exact' ? `=${o.selector.exact}` : o.selector.category)),
        });
        for (const option of node.options) walk(option.body);
      }
    }
  };
  walk(nodes);
  // plural 选择变量同时也是一个占位符
  for (const arg of pluralArgs) args.add(arg);
  return {
    args: [...args],
    pluralArgs,
    pluralOptions,
  };
}

export type DiagnosticLevel = 'error' | 'warning';
export interface Diagnostic {
  level: DiagnosticLevel;
  message: string;
}

/**
 * 校验一条目标语言译文相对于英文原文是否可用。
 * - 语法必须可解析；
 * - 占位符集合要与原文一致（多了、少了都算错误，避免渲染出 {xxx} 或漏填）；
 * - 用到的 plural 变量必须一致；
 * - 该语言需要的复数类别必须给齐。
 */
export function validateTranslation(
  sourceText: string,
  targetText: string,
  targetLocale: Locale,
): Diagnostic[] {
  // 明确留空是合法状态，不需要任何结构
  if (targetText === '') return [];
  const sourceParsed = tryParse(sourceText);
  if (sourceParsed.error) {
    return [{level: 'error', message: `英文原文无法解析：${sourceParsed.error.message}`}];
  }
  const targetParsed = tryParse(targetText);
  if (targetParsed.error) return [{level: 'error', message: targetParsed.error.message}];
  const source = describeShape(sourceParsed.ast!);
  const target = describeShape(targetParsed.ast!);

  const diags: Diagnostic[] = [];
  const sourceArgs = new Set(source.args);
  const targetArgs = new Set(target.args);
  for (const arg of sourceArgs) {
    if (!targetArgs.has(arg)) diags.push({level: 'error', message: `缺少占位符 {${arg}}`});
  }
  for (const arg of targetArgs) {
    if (!sourceArgs.has(arg)) diags.push({level: 'error', message: `多出原文没有的占位符 {${arg}}`});
  }

  const sourcePlurals = new Map(source.pluralOptions.map(p => [p.arg, p]));
  const targetPlurals = new Map(target.pluralOptions.map(p => [p.arg, p]));
  for (const arg of source.pluralArgs) {
    if (!targetPlurals.has(arg)) {
      // 目标把 plural 变量写成了普通占位符（或缺整块）：按该语言必需类别一次性报出
      diags.push({
        level: 'error',
        message: `缺少基于 {${arg}} 的 plural 块；${targetLocale} 必需类别：${requiredCategories(targetLocale).join(' / ')}`,
      });
      continue;
    }
    const have = new Set(targetPlurals.get(arg)!.selectors);
    for (const required of requiredCategories(targetLocale)) {
      if (!have.has(required)) {
        diags.push({
          level: 'error',
          message: `{${arg}} 的 plural 缺少 ${targetLocale} 必需的类别 ${required}（CLDR 要求：${requiredCategories(targetLocale).join(' / ')}）`,
        });
      }
    }
  }
  for (const arg of target.pluralArgs) {
    if (!sourcePlurals.has(arg)) {
      diags.push({level: 'error', message: `多出原文没有的 plural 块 {${arg}}`});
    }
  }
  return diags;
}

/** 校验源（英文）自身的语法。 */
export function validateSource(sourceText: string): Diagnostic[] {
  const parsed = tryParse(sourceText);
  if (parsed.error) return [{level: 'error', message: parsed.error.message}];
  const shape = describeShape(parsed.ast!);
  const diags: Diagnostic[] = [];
  for (const {arg, selectors} of shape.pluralOptions) {
    if (!selectors.includes('other')) {
      diags.push({level: 'error', message: `{${arg}} 的 plural 必须包含 other 兜底分支`});
    }
  }
  return diags;
}

/* ------------------------------- 渲染 ------------------------------- */

export type RenderValues = Record<string, number | bigint | string | undefined>;

export interface RenderResult {
  text: string;
  /** 缺失的变量名（按出现顺序去重），调用方可提示用户。 */
  missingArgs: string[];
}

export function render(ast: MessageNode[], values: RenderValues, locale: Locale): RenderResult {
  const missing: string[] = [];
  const noteMissing = (name: string) => {
    if (!missing.includes(name)) missing.push(name);
  };
  const renderNodes = (nodes: MessageNode[], pluralCtx: {arg: string; hashValue: number | bigint | string | undefined} | null): string => {
    let out = '';
    for (const node of nodes) {
      if (node.kind === 'text') {
        out += node.value;
      } else if (node.kind === 'arg') {
        if (node.name === '#') {
          if (!pluralCtx) {
            out += '#';
          } else if (pluralCtx.hashValue === undefined) {
            // # 是外层 plural 变量的替身：缺失时与 {arg} 一样保留占位符
            out += `{${pluralCtx.arg}}`;
            noteMissing(pluralCtx.arg);
          } else {
            const value = pluralCtx.hashValue;
            out += String(typeof value === 'number' || typeof value === 'bigint' ? Number(value) : value);
          }
        } else {
          const value = values[node.name];
          if (value === undefined) {
            out += `{${node.name}}`;
            noteMissing(node.name);
          } else {
            out += String(value);
          }
        }
      } else {
        const raw = values[node.arg];
        if (raw === undefined) {
          noteMissing(node.arg);
          // 没有变量时退化为 other 分支，并把数字按 {arg} 形式呈现
          const fallback =
            node.options.find(o => o.selector.kind === 'category' && o.selector.category === 'other') ??
            node.options[0];
          out += renderNodes(fallback.body, {arg: node.arg, hashValue: undefined});
        } else if (typeof raw === 'number' || typeof raw === 'bigint') {
          // ICU：offset 同时影响「类别选择」「精确匹配」和分支里 # 的输出
          const adjusted =
            typeof raw === 'bigint'
              ? (node.offset === 0 ? raw : raw - BigInt(node.offset))
              : raw - node.offset;
          let option =
            node.options.find(o => {
              if (o.selector.kind !== 'exact') return false;
              const expected = Number(o.selector.exact);
              return typeof raw === 'bigint' ? BigInt(expected) === adjusted : expected === adjusted;
            }) ?? null;
          if (!option) {
            const category = selectCategory(locale, adjusted);
            option =
              node.options.find(o => o.selector.kind === 'category' && o.selector.category === category) ??
              node.options.find(o => o.selector.kind === 'category' && o.selector.category === 'other') ??
              node.options[0];
          }
          out += renderNodes(option.body, {arg: node.arg, hashValue: adjusted});
        } else {
          // 非数字值无法做复数选择：other 兜底
          const option =
            node.options.find(o => o.selector.kind === 'category' && o.selector.category === 'other') ??
            node.options[0];
          out += renderNodes(option.body, {arg: node.arg, hashValue: raw});
        }
      }
    }
    return out;
  };
  return {text: renderNodes(ast, null), missingArgs: missing};
}
