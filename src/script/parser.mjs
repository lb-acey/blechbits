/**
 * Lexer and parser for the script language, a small subset of JavaScript.
 * Every error is a CompileError with a line, a column and a German message
 * for the editor. The parser stops at the first one.
 */
import { LIMITS } from "../../data/script/contract.mjs";

export class CompileError extends Error {
  constructor(message, line = 1, column = 1) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

const KEYWORDS = new Set(["let", "const", "function", "if", "else", "while", "for", "break", "continue", "return", "true", "false", "new"]);

const NOT_HERE = {
  var: "„var“ gibt es nicht, nimm „let“ oder „const“.",
  class: "Klassen gibt es nicht.",
  switch: "„switch“ gibt es nicht, nimm „if“ und „else if“.",
  case: "„switch“ gibt es nicht, nimm „if“ und „else if“.",
  default: "„switch“ gibt es nicht, nimm „if“ und „else if“.",
  do: "„do … while“ gibt es nicht, nimm „while“.",
  try: "Es gibt keine Ausnahmen („try“). Ein Fehler schaltet das Plugin ab und erscheint am Gerät.",
  catch: "Es gibt keine Ausnahmen („catch“). Ein Fehler schaltet das Plugin ab und erscheint am Gerät.",
  throw: "Es gibt keine Ausnahmen („throw“). Ein Fehler schaltet das Plugin ab und erscheint am Gerät.",
  typeof: "„typeof“ gibt es nicht, es gibt nur ganze Zahlen und kurzen Text.",
  null: "Es gibt kein „null“, nur ganze Zahlen und kurzen Text.",
  undefined: "Es gibt kein „undefined“, nur ganze Zahlen und kurzen Text.",
  this: "„this“ gibt es nicht.",
  import: "Es gibt keine Module („import“).",
  export: "Es gibt keine Module („export“).",
  async: "„async“ gibt es nicht.",
  await: "„await“ gibt es nicht.",
  in: "„in“ gibt es nicht.",
  of: "„for … of“ gibt es nicht, nimm „for (let i = 0; i < n; i++)“.",
  delete: "„delete“ gibt es nicht.",
  void: "„void“ gibt es nicht.",
  yield: "„yield“ gibt es nicht.",
  with: "„with“ gibt es nicht.",
  instanceof: "„instanceof“ gibt es nicht.",
};

const PUNCT = [
  "<<=", ">>=", "===", "!==", ">>>", "**",
  "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "=>",
  "+", "-", "*", "/", "%", "=", "<", ">", "!", "~", "&", "|", "^", "?", ":", ";", ",", ".", "(", ")", "{", "}", "[", "]",
];

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

const BINARY_PRECEDENCE = {
  "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5,
  "==": 6, "!=": 6, "===": 6, "!==": 6,
  "<": 7, ">": 7, "<=": 7, ">=": 7,
  "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10,
};

const isDigit = c => c >= "0" && c <= "9";
const isIdStart = c => /[A-Za-z_$]/.test(c);
const isIdPart = c => /[A-Za-z0-9_$]/.test(c);

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const adv = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === "\n") { line += 1; col = 1; } else col += 1;
      i += 1;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { adv(); continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") adv(); continue; }
    if (c === "/" && src[i + 1] === "*") {
      const l0 = line;
      const c0 = col;
      adv(2);
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) adv();
      if (i >= src.length) throw new CompileError("Der Kommentar mit /* ist nie mit */ geschlossen.", l0, c0);
      adv(2);
      continue;
    }
    const at = { line, col };
    if (isDigit(c)) {
      let j = i;
      let value;
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        j = i + 2;
        while (/[0-9a-fA-F]/.test(src[j] ?? "")) j += 1;
        if (j === i + 2) throw new CompileError("Nach „0x“ fehlen die Ziffern.", at.line, at.col);
        value = parseInt(src.slice(i + 2, j), 16);
        if (value > 0xffffffff) throw new CompileError("Die Zahl ist zu groß (höchstens 0xFFFFFFFF).", at.line, at.col);
        value |= 0;
      } else {
        while (isDigit(src[j] ?? "")) j += 1;
        value = Number(src.slice(i, j));
        if (value > 2147483647) throw new CompileError("Die Zahl ist zu groß (höchstens 2147483647, als Hex bis 0xFFFFFFFF).", at.line, at.col);
      }
      if (src[j] === "." || src[j] === "e" || src[j] === "E") throw new CompileError("Es gibt nur ganze Zahlen, keine Kommazahlen.", at.line, at.col);
      if (isIdStart(src[j] ?? "")) throw new CompileError("Direkt hinter einer Zahl steht ein Buchstabe.", at.line, at.col);
      tokens.push({ t: "num", v: value, len: j - i, ...at });
      adv(j - i);
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (isIdPart(src[j] ?? "")) j += 1;
      const word = src.slice(i, j);
      if (NOT_HERE[word]) throw new CompileError(NOT_HERE[word], at.line, at.col);
      tokens.push({ t: KEYWORDS.has(word) ? "kw" : "id", v: word, len: word.length, ...at });
      adv(j - i);
      continue;
    }
    if (c === '"' || c === "'") {
      let text = "";
      let j = i + 1;
      for (;;) {
        const d = src[j];
        if (d === undefined || d === "\n") throw new CompileError("Der Text ist nicht geschlossen.", at.line, at.col);
        if (d === c) break;
        if (d === "\\") {
          const e = src[j + 1];
          if (e !== "\\" && e !== '"' && e !== "'") throw new CompileError("Im Text geht nur \\\\, \\\" und \\'.", at.line, at.col + (j - i));
          text += e;
          j += 2;
          continue;
        }
        if (d < " " || d > "~") throw new CompileError("Das Display zeigt nur ASCII-Zeichen ohne Umlaute.", at.line, at.col + (j - i));
        text += d;
        j += 1;
      }
      if (text.length > LIMITS.stringLength) throw new CompileError(`Der Text ist zu lang (${text.length} Zeichen, höchstens ${LIMITS.stringLength}).`, at.line, at.col);
      tokens.push({ t: "str", v: text, len: j + 1 - i, ...at });
      adv(j + 1 - i);
      continue;
    }
    if (c === "`") throw new CompileError("Textvorlagen mit ` gibt es nicht, nimm einen Text in Anführungszeichen.", at.line, at.col);
    const p = PUNCT.find(x => src.startsWith(x, i));
    if (!p) throw new CompileError(`Das Zeichen „${c}“ gibt es im Plugin-Code nicht.`, at.line, at.col);
    if (p === ">>>" || p === "**") throw new CompileError(`„${p}“ gibt es nicht.`, at.line, at.col);
    tokens.push({ t: "p", v: p, len: p.length, ...at });
    adv(p.length);
  }
  tokens.push({ t: "eof", v: "", line, col });
  return tokens;
}

const describe = tok => (tok.t === "eof" ? "das Ende des Codes" : `„${tok.v}“`);

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  get tok() { return this.tokens[this.pos]; }

  peek(k = 1) { return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)]; }

  next() { return this.tokens[this.pos++]; }

  is(v) { return (this.tok.t === "p" || this.tok.t === "kw") && this.tok.v === v; }

  eat(v) {
    if (!this.is(v)) return false;
    this.pos += 1;
    return true;
  }

  fail(message, tok = this.tok) { throw new CompileError(message, tok.line, tok.col); }

  expect(v) {
    if (this.is(v)) return this.next();
    const hint = this.is("=") ? " Eine Zuweisung gibt es hier nicht als Ausdruck, meinst du „==“?" : "";
    if (this.is("++") || this.is("--")) return this.fail("++ und -- gibt es nur als eigene Anweisung, nicht in einem Ausdruck.");
    const prev = this.tokens[this.pos - 1];
    if (v === ";" && prev && prev.line < this.tok.line) return this.fail("Hier fehlt „;“ am Ende der Anweisung.", { line: prev.line, col: prev.col + prev.len });
    return this.fail(`Hier fehlt „${v}“, gefunden wurde ${describe(this.tok)}.${hint}`);
  }

  ident(what = "ein Name") {
    if (this.tok.t !== "id") this.fail(`Hier wird ${what} erwartet, gefunden wurde ${describe(this.tok)}.`);
    return this.next();
  }

  program() {
    const body = [];
    while (this.tok.t !== "eof") body.push(this.statement(true));
    return { type: "Program", body };
  }

  block() {
    const open = this.expect("{");
    const body = [];
    while (!this.is("}")) {
      if (this.tok.t === "eof") this.fail("Die Klammer { wurde nie mit } geschlossen.", open);
      body.push(this.statement(false));
    }
    this.next();
    return { type: "Block", body, line: open.line, col: open.col };
  }

  statement(top) {
    const t = this.tok;
    const at = { line: t.line, col: t.col };
    if (t.t === "kw") {
      switch (t.v) {
        case "function": {
          if (!top) this.fail("Funktionen stehen nur ganz oben im Plugin-Code, nicht in einem Block oder einer anderen Funktion.");
          this.next();
          const name = this.ident("ein Funktionsname");
          return { type: "Func", name: name.v, params: this.params(), body: this.block(), ...at };
        }
        case "let": case "const": {
          const s = this.declaration();
          this.expect(";");
          return s;
        }
        case "if": {
          this.next();
          this.expect("(");
          const cond = this.expression();
          this.expect(")");
          const then = this.statement(false);
          const other = this.eat("else") ? this.statement(false) : null;
          return { type: "If", cond, then, other, ...at };
        }
        case "while": {
          this.next();
          this.expect("(");
          const cond = this.expression();
          this.expect(")");
          return { type: "While", cond, body: this.statement(false), ...at };
        }
        case "for": return this.forStatement(at);
        case "break": case "continue": {
          this.next();
          this.expect(";");
          return { type: t.v === "break" ? "Break" : "Continue", ...at };
        }
        case "return": {
          this.next();
          const value = this.is(";") ? null : this.expression();
          this.expect(";");
          return { type: "Return", value, ...at };
        }
        case "else": return this.fail("„else“ ohne ein „if“ davor.");
        default: break;
      }
    }
    if (this.is("{")) return this.block();
    if (this.eat(";")) return { type: "Block", body: [], ...at };
    const s = this.simple();
    this.expect(";");
    return s;
  }

  params() {
    this.expect("(");
    const list = [];
    if (!this.is(")")) {
      do {
        const p = this.ident("ein Parametername");
        list.push({ name: p.v, line: p.line, col: p.col });
      } while (this.eat(","));
    }
    this.expect(")");
    return list;
  }

  declaration() {
    const kw = this.next();
    const decls = [];
    do {
      const name = this.ident();
      let init = null;
      if (this.eat("=")) init = this.expression();
      else if (kw.v === "const") this.fail(`„const ${name.v}“ braucht einen Wert.`, name);
      decls.push({ name: name.v, init, line: name.line, col: name.col });
    } while (this.eat(","));
    return { type: "Let", kind: kw.v, decls, line: kw.line, col: kw.col };
  }

  forStatement(at) {
    this.next();
    this.expect("(");
    let init = null;
    if (this.is("let") || this.is("const")) init = this.declaration();
    else if (!this.is(";")) init = this.simple();
    this.expect(";");
    const cond = this.is(";") ? null : this.expression();
    this.expect(";");
    const update = this.is(")") ? null : this.simple();
    this.expect(")");
    return { type: "For", init, cond, update, body: this.statement(false), ...at };
  }

  /** An assignment, an increment or a call, without its closing semicolon. */
  simple() {
    const t = this.tok;
    const at = { line: t.line, col: t.col };
    if (this.is("++") || this.is("--")) {
      this.next();
      const target = this.postfix();
      this.checkTarget(target);
      return { type: "IncDec", op: t.v, target, ...at };
    }
    const e = this.expression();
    if (this.tok.t === "p" && ASSIGN_OPS.has(this.tok.v)) {
      const op = this.next().v;
      this.checkTarget(e, "Links von „" + op + "“ muss eine Variable oder ein Feldelement stehen.");
      return { type: "Assign", op, target: e, value: this.expression(), ...at };
    }
    if (this.is("++") || this.is("--")) {
      const op = this.next().v;
      this.checkTarget(e);
      return { type: "IncDec", op, target: e, ...at };
    }
    if (e.type !== "Call") throw new CompileError("Das ist keine Anweisung. Erlaubt sind eine Zuweisung, ++, -- oder ein Funktionsaufruf.", e.line, e.col);
    return { type: "ExprStmt", expr: e, ...at };
  }

  checkTarget(e, message = "++ und -- gehen nur bei einer Variablen oder einem Feldelement.") {
    if (e.type !== "Ident" && e.type !== "Index" && e.type !== "Member") throw new CompileError(message, e.line, e.col);
  }

  expression() { return this.ternary(); }

  ternary() {
    const test = this.binary(1);
    if (!this.is("?")) return test;
    this.next();
    const a = this.ternary();
    this.expect(":");
    const b = this.ternary();
    return { type: "Cond", test, a, b, line: test.line, col: test.col };
  }

  binary(min) {
    let left = this.unary();
    for (;;) {
      const op = this.tok.t === "p" ? this.tok.v : null;
      const prec = op ? BINARY_PRECEDENCE[op] : undefined;
      if (prec === undefined || prec < min) return left;
      this.next();
      const right = this.binary(prec + 1);
      left = { type: op === "&&" || op === "||" ? "Logical" : "Binary", op, left, right, line: left.line, col: left.col };
    }
  }

  unary() {
    const t = this.tok;
    if (t.t === "p" && (t.v === "-" || t.v === "!" || t.v === "~")) {
      this.next();
      return { type: "Unary", op: t.v, arg: this.unary(), line: t.line, col: t.col };
    }
    if (t.t === "p" && (t.v === "++" || t.v === "--")) this.fail("++ und -- gibt es nur als eigene Anweisung, nicht in einem Ausdruck.");
    if (t.t === "p" && t.v === "+") this.fail("Ein Plus vor einer Zahl gibt es nicht.");
    return this.postfix();
  }

  postfix() {
    let e = this.primary();
    for (;;) {
      if (this.is(".")) {
        this.next();
        const name = this.ident("ein Name nach dem Punkt");
        e = { type: "Member", object: e, name: name.v, line: e.line, col: e.col };
      } else if (this.is("[")) {
        this.next();
        const index = this.expression();
        this.expect("]");
        e = { type: "Index", object: e, index, line: e.line, col: e.col };
      } else if (this.is("(")) {
        this.next();
        const args = [];
        if (!this.is(")")) {
          do args.push(this.expression()); while (this.eat(","));
        }
        this.expect(")");
        e = { type: "Call", callee: e, args, line: e.line, col: e.col };
      } else return e;
    }
  }

  arrowAhead() {
    if (this.tok.t === "id" && this.peek().v === "=>" && this.peek().t === "p") return true;
    if (!this.is("(")) return false;
    let depth = 0;
    for (let k = this.pos; k < this.tokens.length; k++) {
      const x = this.tokens[k];
      if (x.t === "p" && x.v === "(") depth += 1;
      if (x.t === "p" && x.v === ")") {
        depth -= 1;
        if (depth === 0) return this.tokens[k + 1].t === "p" && this.tokens[k + 1].v === "=>";
      }
    }
    return false;
  }

  primary() {
    const t = this.tok;
    const at = { line: t.line, col: t.col };
    if (t.t === "num") { this.next(); return { type: "Num", value: t.v, ...at }; }
    if (t.t === "str") { this.next(); return { type: "Str", value: t.v, ...at }; }
    if (t.t === "kw" && (t.v === "true" || t.v === "false")) { this.next(); return { type: "Num", value: t.v === "true" ? 1 : 0, ...at }; }
    if (t.t === "kw" && t.v === "function") {
      this.next();
      return { type: "FuncExpr", params: this.params(), body: this.block(), ...at };
    }
    if (this.arrowAhead()) {
      let params = null;
      if (this.tok.t === "id") { params = [{ name: t.v, line: t.line, col: t.col }]; this.next(); } else params = this.params();
      this.expect("=>");
      if (this.is("{")) return { type: "FuncExpr", params, body: this.block(), ...at };
      const body = this.expression();
      if (body.type !== "Call") throw new CompileError("Nach „=>“ folgt ein Block { … } oder ein einzelner Funktionsaufruf.", body.line, body.col);
      return { type: "FuncExpr", params, body: { type: "Block", body: [{ type: "ExprStmt", expr: body, line: body.line, col: body.col }], line: body.line, col: body.col }, ...at };
    }
    if (t.t === "kw" && t.v === "new") {
      this.next();
      const cls = this.ident("„Array“");
      if (cls.v !== "Array") this.fail("„new“ gibt es nur als new Array(Größe).", cls);
      this.expect("(");
      const size = this.expression();
      this.expect(")");
      return { type: "NewArray", size, ...at };
    }
    if (t.t === "id") { this.next(); return { type: "Ident", name: t.v, ...at }; }
    if (this.is("(")) {
      this.next();
      const e = this.expression();
      this.expect(")");
      return e;
    }
    if (this.is("[")) {
      this.next();
      const items = [];
      if (!this.is("]")) {
        do items.push(this.expression()); while (this.eat(","));
      }
      this.expect("]");
      return { type: "ArrayLit", items, ...at };
    }
    return this.fail(`Hier wird ein Wert erwartet, gefunden wurde ${describe(t)}.`);
  }
}

export function parse(source) {
  return new Parser(tokenize(source)).program();
}
