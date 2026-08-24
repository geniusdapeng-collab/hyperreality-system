/**
 * fence-engine · 围栏 DSL 表达式求值器（L2.5 沙箱：禁任意代码）
 * 手写递归下降解析——不 eval、不 new Function，求值面只有：
 *   数字 / 字符串 / 布尔 / 列表字面量 / 路径（before.x · after.x · params.x · context.x · object.x）
 *   算术 + - * / % ｜ 比较 == != < <= > >= ｜ 归属 in ｜ 逻辑 and or not ｜ 括号
 *   函数：abs / min / max / contains / contains_any
 * 语义（D27）：语法错误、未知根标识、类型错误 → 抛 FenceEvalError（判定器按 block，E2.1 宁可错杀）；
 *   路径缺失 → undefined（==/!=/in/contains 语境下自然不命中，稀疏标记字段友好）；
 *   算术与大小比较遇缺失仍经 num() 抛错（数值门槛缺数据宁错杀）。
 */

export class FenceEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FenceEvalError";
  }
}

/* ---------- Tokenizer ---------- */

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "path"; v: string[] }
  | { t: "op"; v: string };

const OPS = ["<=", ">=", "==", "!=", "&&", "||", "<", ">", "+", "-", "*", "/", "%", "(", ")", "[", "]", ",", "!"];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'" || ch === '"') {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) throw new FenceEvalError("字符串未闭合");
      tokens.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^\d*\.?\d+/.exec(src.slice(i))!;
      tokens.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][\w]*(?:\.[\w]+)*/.exec(src.slice(i))!;
      const word = m[0];
      if (word === "true") tokens.push({ t: "bool", v: true });
      else if (word === "false") tokens.push({ t: "bool", v: false });
      else if (word === "and") tokens.push({ t: "op", v: "&&" });
      else if (word === "or") tokens.push({ t: "op", v: "||" });
      else if (word === "not") tokens.push({ t: "op", v: "!" });
      else if (word === "in") tokens.push({ t: "op", v: "in" });
      else if (["abs", "min", "max", "contains", "contains_any"].includes(word)) tokens.push({ t: "path", v: [word] }); // 函数名在 parser 判别
      else tokens.push({ t: "path", v: word.split(".") });
      i += word.length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FenceEvalError(`无法识别的字符：${ch}`);
    tokens.push({ t: "op", v: op });
    i += op.length;
  }
  return tokens;
}

/* ---------- Parser（递归下降） ---------- */

type Ast =
  | { k: "lit"; v: number | string | boolean }
  | { k: "list"; items: Ast[] }
  | { k: "path"; v: string[] }
  | { k: "un"; op: string; x: Ast }
  | { k: "bin"; op: string; l: Ast; r: Ast }
  | { k: "call"; fn: string; args: Ast[] };

function parse(tokens: Token[]): Ast {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];
  const expectOp = (v: string) => {
    const t = eat();
    if (!t || t.t !== "op" || t.v !== v) throw new FenceEvalError(`期望 ${v}`);
  };
  /** 吃掉一个运算符 token 并取其值（类型收窄辅助） */
  const eatOp = (): string => {
    const t = eat();
    if (!t || t.t !== "op") throw new FenceEvalError("期望运算符");
    return t.v;
  };

  const parseOr = (): Ast => {
    let l = parseAnd();
    while (peek()?.t === "op" && peek()!.v === "||") { eat(); l = { k: "bin", op: "||", l, r: parseAnd() }; }
    return l;
  };
  const parseAnd = (): Ast => {
    let l = parseCmp();
    while (peek()?.t === "op" && peek()!.v === "&&") { eat(); l = { k: "bin", op: "&&", l, r: parseCmp() }; }
    return l;
  };
  const parseCmp = (): Ast => {
    let l = parseAdd();
    const t = peek();
    if (t?.t === "op" && ["==", "!=", "<", "<=", ">", ">=", "in"].includes(t.v)) {
      eat();
      l = { k: "bin", op: t.v, l, r: parseAdd() };
    }
    return l;
  };
  const parseAdd = (): Ast => {
    let l = parseMul();
    while (peek()?.t === "op" && ["+", "-"].includes((peek() as { v: string }).v)) {
      const op = eatOp(); l = { k: "bin", op, l, r: parseMul() };
    }
    return l;
  };
  const parseMul = (): Ast => {
    let l = parseUnary();
    while (peek()?.t === "op" && ["*", "/", "%"].includes((peek() as { v: string }).v)) {
      const op = eatOp(); l = { k: "bin", op, l, r: parseUnary() };
    }
    return l;
  };
  const parseUnary = (): Ast => {
    const t = peek();
    if (t?.t === "op" && t.v === "-") { eat(); return { k: "un", op: "-", x: parseUnary() }; }
    if (t?.t === "op" && t.v === "!") { eat(); return { k: "un", op: "!", x: parseUnary() }; }
    return parsePrimary();
  };
  const parsePrimary = (): Ast => {
    const t = eat();
    if (!t) throw new FenceEvalError("表达式意外结束");
    if (t.t === "num") return { k: "lit", v: t.v };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "bool") return { k: "lit", v: t.v };
    if (t.t === "op" && t.v === "(") {
      const e = parseOr();
      expectOp(")");
      return e;
    }
    if (t.t === "op" && t.v === "[") {
      // 列表字面量：['a', 'b'] / [1, 2]（供 in / contains_any 使用）
      const items: Ast[] = [];
      if (!(peek()?.t === "op" && peek()!.v === "]")) {
        items.push(parseOr());
        while (peek()?.t === "op" && peek()!.v === ",") { eat(); items.push(parseOr()); }
      }
      expectOp("]");
      return { k: "list", items };
    }
    if (t.t === "path") {
      if (t.v.length === 1 && ["abs", "min", "max", "contains", "contains_any"].includes(t.v[0]!) && peek()?.t === "op" && peek()!.v === "(") {
        eat();
        const args: Ast[] = [];
        if (!(peek()?.t === "op" && peek()!.v === ")")) {
          args.push(parseOr());
          while (peek()?.t === "op" && peek()!.v === ",") { eat(); args.push(parseOr()); }
        }
        expectOp(")");
        return { k: "call", fn: t.v[0]!, args };
      }
      return { k: "path", v: t.v };
    }
    throw new FenceEvalError(`意外 token：${JSON.stringify(t)}`);
  };

  const ast = parseOr();
  if (pos !== tokens.length) throw new FenceEvalError("表达式尾部有多余 token");
  return ast;
}

/* ---------- Evaluator ---------- */

export interface EvalScope {
  before?: unknown;
  after?: unknown;
  params?: unknown;
  context?: unknown;
  object?: unknown;
}

function resolvePath(scope: EvalScope, path: string[]): unknown {
  const root = path[0]!;
  if (!["before", "after", "params", "context", "object"].includes(root)) {
    throw new FenceEvalError(`未知根标识符：${root}（只允许 before/after/params/context/object）`);
  }
  let cur: unknown = scope[root as keyof EvalScope];
  for (const key of path.slice(1)) {
    if (cur === null || typeof cur !== "object") {
      throw new FenceEvalError(`路径 ${path.join(".")} 在 ${key} 处中断（前值非对象）`);
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  if (cur === undefined) throw new FenceEvalError(`路径不存在：${path.join(".")}`);
  return cur;
}

function num(v: unknown, at: string): number {
  if (typeof v !== "number" || Number.isNaN(v)) throw new FenceEvalError(`${at} 期望数字，得到 ${typeof v}`);
  return v;
}

function evalAst(ast: Ast, scope: EvalScope): unknown {
  switch (ast.k) {
    case "lit": return ast.v;
    case "list": return ast.items.map((x) => evalAst(x, scope));
    case "path": {
      // 缺失路径宽容语义（D27）：路径不存在 → undefined（比较语境下自然不命中），
      // 而非一律抛错熔断——稀疏标记类字段（params.involves_persona 等）天然不是每次都在。
      // 算术/大小比较仍经 num() 严格抛错（缺数据宁错杀，E2.1 不变）。
      try {
        return resolvePath(scope, ast.v);
      } catch (err) {
        if (err instanceof FenceEvalError && err.message.startsWith("路径")) return undefined;
        throw err;
      }
    }
    case "un": {
      const v = evalAst(ast.x, scope);
      if (ast.op === "-") return -num(v, "一元负号");
      return !(typeof v === "boolean" ? v : Boolean(v));
    }
    case "bin": {
      const { op } = ast;
      if (op === "&&") return Boolean(evalAst(ast.l, scope)) && Boolean(evalAst(ast.r, scope));
      if (op === "||") return Boolean(evalAst(ast.l, scope)) || Boolean(evalAst(ast.r, scope));
      const l = evalAst(ast.l, scope);
      const r = evalAst(ast.r, scope);
      switch (op) {
        case "+": return num(l, "+") + num(r, "+");
        case "-": return num(l, "-") - num(r, "-");
        case "*": return num(l, "*") * num(r, "*");
        case "/": {
          const d = num(r, "/");
          if (d === 0) throw new FenceEvalError("除零（E2.1 按 block）");
          return num(l, "/") / d;
        }
        case "%": return num(l, "%") % num(r, "%");
        case "==": return l === r;
        case "!=": return l !== r;
        case "in": {
          // x in [a, b, ...]：右值须为列表；左值缺失（undefined）→ 不命中
          if (!Array.isArray(r)) throw new FenceEvalError(`in 右值须为列表，得到 ${typeof r}`);
          if (l === undefined) return false;
          return r.includes(l);
        }
        case "<": return num(l, "<") < num(r, "<");
        case "<=": return num(l, "<=") <= num(r, "<=");
        case ">": return num(l, ">") > num(r, ">");
        case ">=": return num(l, ">=") >= num(r, ">=");
        default: throw new FenceEvalError(`未知运算符 ${op}`);
      }
    }
    case "call": {
      // 文本函数宽容语义（D27）：haystack 缺失或非字符串 → false（文本检查不成立 ≠ 系统异常）
      if (ast.fn === "contains" || ast.fn === "contains_any") {
        const hay = evalAst(ast.args[0]!, scope);
        if (typeof hay !== "string") return false;
        if (ast.fn === "contains") {
          const needle = evalAst(ast.args[1]!, scope);
          return typeof needle === "string" && needle.length > 0 ? hay.includes(needle) : false;
        }
        const needles = evalAst(ast.args[1]!, scope);
        if (!Array.isArray(needles)) throw new FenceEvalError("contains_any 第二参数须为列表");
        return needles.some((n) => typeof n === "string" && n.length > 0 && hay.includes(n));
      }
      const args = ast.args.map((a) => num(evalAst(a, scope), `函数 ${ast.fn}`));
      if (ast.fn === "abs") return Math.abs(args[0]!);
      if (ast.fn === "min") return Math.min(...args);
      if (ast.fn === "max") return Math.max(...args);
      throw new FenceEvalError(`未知函数 ${ast.fn}`);
    }
  }
}

/** 求值入口：表达式 → boolean（判定语义）；任何异常抛 FenceEvalError */
export function evalCondition(expr: string, scope: EvalScope): boolean {
  if (!expr || expr.trim().length === 0) return true; // 空条件 = 恒命中（DSL 语义）
  const result = evalAst(parse(tokenize(expr)), scope);
  return Boolean(result);
}
