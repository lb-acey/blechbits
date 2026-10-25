/**
 * Compiler from the script language to a blob (data/script/contract.mjs).
 *
 * Language decisions, in one place:
 * - Values are 32-bit integers and short texts. A text is a literal or a
 *   variable holding one; it can be compared with == and handed to an API
 *   function, nothing more. Functions take and return integers.
 * - All storage is static: globals, arrays and every function's locals have
 *   fixed slots in the variable area. That is why recursion is refused and
 *   why there are no closures: a function sees the globals and its own
 *   variables, nothing else. Arrays are fixed-size and global only.
 * - The top-level statements are the script body (event `start`). The
 *   handlers are registered by `korg.onEvent("name", handler)` at the top
 *   level and become active when the body has run without a fault.
 * - A plugin with a screen of its own is an app: `korg.app("Name", "GAMES")` at the
 *   top level, once. Only an open app draws on the display (see docs/plugins.md).
 */
import {
  LIMITS, BUDGET, EVENT_BY_NAME, EVENTS, API_BY_NAME, QUEUED_EVENTS, APP_EVENTS, SCRIPT_APPS, ARRAY_HANDLE, EVENT_ARG_SINCE,
} from "../../data/script/contract.mjs";
import { NAMES } from "../../data/script/names.mjs";
import { PROPERTY_BY_PATH, KNOB_NAMES } from "../../data/script/properties.mjs";
import { encodeBlob, decodeBlob, lineAt } from "./blob.mjs";
import { assemble } from "./asm.mjs";
import { verifyParts } from "./verifier.mjs";
import { binary } from "./alu.mjs";
import { parse, CompileError } from "./parser.mjs";

/** The API versions of the event values a handler takes (EVENT_ARG_SINCE), one per value. */
const ARG_SINCE = h => EVENTS[h.event].args.slice(0, h.argc).map(name => EVENT_ARG_SINCE[EVENTS[h.event].name]?.[name] ?? 0);

const BINARY_OPS = {
  "+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "%": "MOD", "&": "AND", "|": "OR", "^": "XOR", "<<": "SHL", ">>": "SHR",
  "==": "EQ", "===": "EQ", "!=": "NE", "!==": "NE", "<": "LT", "<=": "LE", ">": "GT", ">=": "GE",
};
const COMPOUND = { "+=": "ADD", "-=": "SUB", "*=": "MUL", "/=": "DIV", "%=": "MOD", "&=": "AND", "|=": "OR", "^=": "XOR", "<<=": "SHL", ">>=": "SHR" };
const TYPE_NAME = { int: "eine Zahl", str: "ein Text" };

const where = n => [n.line, n.col];
const err = (n, message) => new CompileError(message, ...where(n));

function pathOf(node) {
  if (node.type === "Ident") return [node.name];
  if (node.type === "Member") {
    const base = pathOf(node.object);
    return base ? [...base, node.name] : null;
  }
  return null;
}

/** A call node for an API entry, as if the plugin had written it: `korg.read.step(i)`. */
function callNode(name, args, at) {
  const callee = name.split(".").reduce((object, part) => (object ? { type: "Member", object, name: part, line: at.line, col: at.col } : { type: "Ident", name: part, line: at.line, col: at.col }), null);
  return { type: "Call", callee, args, line: at.line, col: at.col };
}

const isPure = n => {
  if (!n || typeof n !== "object") return true;
  if (n.type === "Call") return false;
  return Object.values(n).every(v => (Array.isArray(v) ? v.every(isPure) : isPure(v)));
};

class Fn {
  constructor(key, label, kind, display) {
    this.key = key;
    this.label = label;
    this.kind = kind;
    this.display = display;
    this.items = [{ label }];
    this.scopes = [];
    this.loops = [];
    this.base = 0;
    this.top = 0;
    this.max = 0;
    this.line = 1;
    this.blockDepth = 0;
  }
}

class Compiler {
  constructor(name, slotsAvailable) {
    this.name = name;
    this.slotsAvailable = slotsAvailable;
    this.consts = [];
    this.constIndex = new Map();
    this.strings = [];
    this.nextSlot = 0;
    this.globals = new Map();
    this.funcs = new Map();
    this.handlers = [];
    this.fns = [];
    this.pending = [];
    this.labelCount = 0;
    this.edges = [];
    this.apiSites = [];
    this.topIndex = 0;
    this.app = null;
    this.data = [];
  }

  newLabel(prefix) { return `${prefix}${this.labelCount++}`; }

  emit(fn, op, ...args) { fn.items.push({ op, args, line: fn.line }); }

  allocate(n, at, fn = null) {
    const slot = fn ? fn.base + fn.top : this.nextSlot;
    const end = slot + n;
    if (end > Math.min(LIMITS.vars, this.slotsAvailable)) throw err(at, this.slotsMessage(end));
    if (fn) {
      fn.top += n;
      fn.max = Math.max(fn.max, fn.top);
    } else this.nextSlot = end;
    return slot;
  }

  slotsMessage(needed) {
    const kib = n => `${Math.round((n * 4) / 102.4) / 10} KiB`;
    if (this.slotsAvailable <= LIMITS.vars) {
      return `Das Plugin braucht mindestens ${needed} Variablenplätze (${kib(needed)}). Die Variablen-Vorabprüfung lässt für dieses Plugin noch ${this.slotsAvailable} Plätze zu. Der gemeinsame Plugin-Speicher umfasst ${BUDGET.scriptBytes / 1024} KiB für Blöcke, Variablen und Einträge; die Laufzeit prüft ihn beim Laden. Kleinere Felder oder weniger Variablen nehmen.`;
    }
    return `Zu viele Variablen und Felder (${needed} Plätze, höchstens ${LIMITS.vars} je Plugin).`;
  }

  constSlot(value, at) {
    if (!this.constIndex.has(value)) {
      if (this.consts.length >= LIMITS.consts) throw err(at, `Zu viele verschiedene große oder negative Zahlen (höchstens ${LIMITS.consts}).`);
      this.constIndex.set(value, this.consts.length);
      this.consts.push(value);
    }
    return this.constIndex.get(value);
  }

  stringSlot(text, at) {
    let i = this.strings.indexOf(text);
    if (i < 0) {
      if (this.strings.length >= LIMITS.strings) throw err(at, `Zu viele verschiedene Texte (höchstens ${LIMITS.strings}).`);
      i = this.strings.push(text) - 1;
    }
    return i;
  }

  pushConst(fn, c, at) {
    if (c.type === "str") this.emit(fn, "PUSHS", this.stringSlot(c.value, at));
    else if (c.value >= 0 && c.value <= 255) this.emit(fn, "PUSHB", c.value);
    else this.emit(fn, "PUSHK", this.constSlot(c.value, at));
  }

  // ---- symbols ----

  lookup(name, fn, at) {
    for (let i = fn.scopes.length - 1; i >= 0; i--) if (fn.scopes[i].has(name)) return fn.scopes[i].get(name);
    const g = this.globals.get(name);
    if (g) {
      if (fn.kind === "start" && g.order > this.topIndex) throw err(at, `„${name}“ wird benutzt, bevor es weiter unten deklariert wird.`);
      return g;
    }
    if (this.funcs.has(name)) return { kind: "func", func: this.funcs.get(name) };
    return null;
  }

  declareLocal(fn, name, sym, at) {
    const scope = fn.scopes.at(-1);
    if (scope.has(name)) throw err(at, `„${name}“ ist hier schon deklariert.`);
    this.checkName(name, at);
    scope.set(name, sym);
  }

  checkName(name, at) {
    if (name === "korg") throw err(at, "„korg“ ist der Name der Geräte-Funktionen und lässt sich nicht als Name benutzen.");
  }

  typeOfInit(n) {
    if (!n) return "int";
    if (n.type === "Str") return "str";
    if (n.type === "Ident") return this.globals.get(n.name)?.type ?? "int";
    if (n.type === "Cond") return this.typeOfInit(n.a);
    return "int";
  }

  // ---- constant folding ----

  fold(n, fn) {
    switch (n.type) {
      case "Num": return { value: n.value, type: "int" };
      case "Str": return { value: n.value, type: "str" };
      case "Ident": {
        const s = this.lookupQuiet(n.name, fn);
        return s?.kind === "const" ? { value: s.value, type: s.type } : null;
      }
      case "Member": {
        const named = this.panelName(n);
        if (named) return { value: named.value, type: "int" };
        if (n.name !== "length" || n.object.type !== "Ident") return null;
        const s = this.lookupQuiet(n.object.name, fn);
        return s?.kind === "array" ? { value: s.length, type: "int" } : null;
      }
      case "Unary": {
        const a = this.fold(n.arg, fn);
        if (!a || a.type !== "int") return null;
        if (n.op === "-") return { value: -a.value | 0, type: "int" };
        if (n.op === "!") return { value: a.value === 0 ? 1 : 0, type: "int" };
        return { value: ~a.value, type: "int" };
      }
      case "Binary": {
        const a = this.fold(n.left, fn);
        const b = this.fold(n.right, fn);
        if (!a || !b || a.type !== "int" || b.type !== "int") return null;
        const r = binary(BINARY_OPS[n.op], a.value, b.value);
        if (r === null) throw err(n, "Teilen durch null.");
        return { value: r, type: "int" };
      }
      case "Logical": {
        const a = this.fold(n.left, fn);
        const b = this.fold(n.right, fn);
        if (!a || !b || a.type !== "int" || b.type !== "int") return null;
        const v = n.op === "&&" ? (a.value ? b.value : a.value) : (a.value ? a.value : b.value);
        return { value: v, type: "int" };
      }
      case "Cond": {
        const t = this.fold(n.test, fn);
        if (!t || t.type !== "int") return null;
        return this.fold(t.value ? n.a : n.b, fn);
      }
      default: return null;
    }
  }

  /** `korg.key.TAP` and `korg.led.PAD_1_RED`: the entry of the panel names, or null. */
  panelName(n) {
    const path = pathOf(n);
    if (path?.length !== 3 || path[0] !== "korg") return null;
    return NAMES[path[1]]?.get(path[2]) ?? null;
  }

  panelNameError(n) {
    const path = pathOf(n);
    if (path?.[0] !== "korg" || !NAMES[path[1]]) return null;
    const kind = path[1];
    if (path.length === 2) return `„korg.${kind}“ ist eine Liste von Namen, schreibe zum Beispiel korg.${kind}.${NAMES[kind].keys().next().value}.`;
    if (path.length !== 3) return null;
    const near = [...NAMES[kind].keys()].filter(k => k.startsWith(path[2].toUpperCase().slice(0, 3)));
    return `Es gibt keinen Namen „korg.${kind}.${path[2]}“.${near.length ? ` Ähnlich: ${near.slice(0, 4).map(k => `korg.${kind}.${k}`).join(", ")}.` : ""}`;
  }

  lookupQuiet(name, fn) {
    for (let i = fn.scopes.length - 1; i >= 0; i--) if (fn.scopes[i].has(name)) return fn.scopes[i].get(name);
    return this.globals.get(name) ?? null;
  }

  // ---- globals (pass one) ----

  declareGlobals(program) {
    const probe = { scopes: [], kind: "start" };
    program.body.forEach((st, order) => {
      if (st.type === "Func") {
        this.checkName(st.name, st);
        if (this.funcs.has(st.name) || this.globals.has(st.name)) throw err(st, `„${st.name}“ ist schon deklariert.`);
        this.funcs.set(st.name, { name: st.name, node: st, key: `f_${st.name}`, params: st.params.length });
      } else if (st.type === "Let") {
        for (const d of st.decls) {
          this.checkName(d.name, d);
          if (this.globals.has(d.name) || this.funcs.has(d.name)) throw err(d, `„${d.name}“ ist schon deklariert.`);
          this.globals.set(d.name, { ...this.globalSymbol(st, d, probe), order });
        }
      }
    });
  }

  globalSymbol(st, d, probe) {
    const init = d.init;
    if (init?.type === "NewArray" || init?.type === "ArrayLit") {
      const length = init.type === "NewArray" ? this.arraySize(init, probe) : init.items.length;
      if (length < 1 || length > LIMITS.arrayLength) throw err(init, `Ein Feld hat 1 bis ${LIMITS.arrayLength} Plätze.`);
      return { kind: "array", base: this.allocate(length, d), length, init };
    }
    if (st.kind === "const" && init) {
      const c = this.fold(init, probe);
      if (c) return { kind: "const", value: c.value, type: c.type };
    }
    return { kind: "var", slot: this.allocate(1, d), type: this.typeOfInit(init), mutable: st.kind === "let" };
  }

  arraySize(n, probe) {
    const c = this.fold(n.size, probe);
    if (!c || c.type !== "int") throw err(n.size, "Die Größe eines Felds muss eine feste Zahl sein, zum Beispiel new Array(16).");
    return c.value;
  }

  // ---- expressions ----

  val(n, fn, want = null) {
    const t = this.expr(n, fn);
    if (t === "void") throw err(n, `„${pathOf(n.callee ?? n)?.join(".")}“ gibt keinen Wert zurück.`);
    if (want && t !== want) throw err(n, `Hier wird ${TYPE_NAME[want]} erwartet, das ist aber ${TYPE_NAME[t]}.`);
    return t;
  }

  expr(n, fn) {
    fn.line = n.line;
    const c = this.fold(n, fn);
    if (c) {
      this.pushConst(fn, c, n);
      return c.type;
    }
    switch (n.type) {
      case "Ident": {
        const s = this.lookup(n.name, fn, n);
        if (!s) throw err(n, `„${n.name}“ ist nicht deklariert.`);
        if (s.kind === "array") throw err(n, `„${n.name}“ ist ein Feld: schreibe ${n.name}[Index] oder ${n.name}.length.`);
        if (s.kind === "func") throw err(n, `„${n.name}“ ist eine Funktion: rufe sie mit ${n.name}() auf.`);
        this.emit(fn, "LOAD", s.slot);
        return s.type;
      }
      case "Index": {
        const prop = this.propertyOf(n);
        if (prop) return this.readProperty(prop, n, fn);
        const a = this.arrayOf(n, fn);
        this.val(n.index, fn, "int");
        fn.line = n.line;
        this.emit(fn, "ALOAD", a.base, a.length);
        return "int";
      }
      case "Member": {
        const prop = this.propertyOf(n);
        if (prop) return this.readProperty(prop, n, fn);
        throw err(n, this.panelNameError(n) ?? (n.name === "length" ? "„length“ gibt es nur bei einem Feld." : `„.${n.name}“ gibt es nicht.`));
      }
      case "Call": return this.call(n, fn);
      case "Unary": {
        this.val(n.arg, fn, "int");
        fn.line = n.line;
        if (n.op === "-") this.emit(fn, "NEG");
        else if (n.op === "!") this.emit(fn, "NOT");
        else {
          this.pushConst(fn, { value: -1, type: "int" }, n);
          this.emit(fn, "XOR");
        }
        return "int";
      }
      case "Binary": {
        const op = BINARY_OPS[n.op];
        const lt = this.val(n.left, fn);
        const rt = this.val(n.right, fn);
        const eq = op === "EQ" || op === "NE";
        if (lt === "str" || rt === "str") {
          if (!eq) throw err(n, n.op === "+" ? "Text lässt sich nicht mit + verbinden. Zahlen zeigt korg.display.number, Text korg.display.text." : "Mit Text lässt sich nicht rechnen, nur mit == und != vergleichen.");
          if (lt !== rt) throw err(n, "Ein Text lässt sich nur mit einem Text vergleichen.");
        }
        fn.line = n.line;
        this.emit(fn, op);
        return "int";
      }
      case "Logical": {
        const end = this.newLabel("L");
        this.val(n.left, fn, "int");
        this.emit(fn, "DUP");
        this.emit(fn, n.op === "&&" ? "JZ" : "JNZ", end);
        this.emit(fn, "DROP");
        this.val(n.right, fn, "int");
        fn.items.push({ label: end });
        return "int";
      }
      case "Cond": {
        const other = this.newLabel("L");
        const end = this.newLabel("L");
        this.val(n.test, fn, "int");
        this.emit(fn, "JZ", other);
        const ta = this.val(n.a, fn);
        this.emit(fn, "JMP", end);
        fn.items.push({ label: other });
        const tb = this.val(n.b, fn);
        if (ta !== tb) throw err(n, "Beide Zweige von ? : müssen dieselbe Art Wert liefern.");
        fn.items.push({ label: end });
        return ta;
      }
      case "NewArray": case "ArrayLit": throw err(n, "Ein Feld gibt es nur als Deklaration ganz oben im Plugin-Code: const f = new Array(16);");
      case "FuncExpr": throw err(n, "Eine Funktion als Wert gibt es nur in korg.onEvent(\"…\", () => { … }).");
      default: throw err(n, "Das lässt sich hier nicht übersetzen.");
    }
  }

  /**
   * The property a `korg.…` node names (data/script/properties.mjs): { prop, index } with the node that goes in the
   * brackets, or null. `asTarget` also takes `korg.led.TAP`, which reads as the LED's number but sets its brightness.
   */
  propertyOf(n, asTarget = false) {
    const at = { line: n.line, col: n.col };
    const num = value => ({ type: "Num", value, ...at });
    if (n.type === "Index" && n.object.type === "Member") {
      const path = pathOf(n.object)?.join(".");
      const prop = path && PROPERTY_BY_PATH.get(`${path}[]`);
      if (prop) return { prop, index: n.index };
      const fields = path ? this.fieldsOf(path) : [];
      if (fields.length) throw err(n, `„${path}[…]“ ist ein Objekt, schreibe eine Eigenschaft dahinter: ${fields.map(f => `${path}[i].${f}`).join(", ")}.`);
      return null;
    }
    if (n.type !== "Member") return null;
    if (n.object.type === "Index" && n.object.object.type === "Member") {
      const path = pathOf(n.object.object)?.join(".");
      if (!path?.startsWith("korg.")) return null;
      const prop = PROPERTY_BY_PATH.get(`${path}[].${n.name}`);
      if (prop) return { prop, index: n.object.index };
      const fields = this.fieldsOf(path);
      if (fields.length) throw err(n, `„${path}[…].${n.name}“ gibt es nicht. Es gibt: ${fields.map(f => "." + f).join(", ")}.`);
      return null;
    }
    const path = pathOf(n);
    if (!path || path[0] !== "korg") return null;
    if (path.length === 2) {
      const prop = PROPERTY_BY_PATH.get(path.join("."));
      return prop ? { prop, index: null } : null;
    }
    if (path.length === 3 && PROPERTY_BY_PATH.has(path.join("."))) return { prop: PROPERTY_BY_PATH.get(path.join(".")), index: null };
    if (path.length === 3 && path[1] === "knobs") {
      const knob = KNOB_NAMES.find(k => k.name === path[2]);
      if (!knob) throw err(n, `Es gibt keinen Regler „korg.knobs.${path[2]}“. Es gibt: ${KNOB_NAMES.map(k => k.name).join(", ")}.`);
      return { prop: PROPERTY_BY_PATH.get("korg.knobs[]"), index: num(knob.value) };
    }
    if (asTarget && path.length === 3 && path[1] === "led") {
      const led = this.panelName(n);
      if (led) return { prop: PROPERTY_BY_PATH.get("korg.leds[]"), index: num(led.value) };
    }
    return null;
  }

  /** The fields of an indexed object such as korg.parts: ["step", "muted"]. */
  fieldsOf(path) { return [...PROPERTY_BY_PATH.keys()].filter(k => k.startsWith(`${path}[].`)).map(k => k.slice(path.length + 3)); }

  propertyName(prop) { return prop.path.replace("[]", "[…]"); }

  /** The arguments of a property's read or write call: "index" is the bracket, "value" the assigned value. */
  propertyArgs(spec, index, value, at) {
    return spec.map(a => (a === "index" ? index : a === "value" ? value : { type: "Num", value: a, line: at.line, col: at.col }));
  }

  readProperty({ prop, index }, n, fn) {
    if (!prop.read) throw err(n, `${this.propertyName(prop)} lässt sich nur setzen, nicht lesen.`);
    return this.call(callNode(prop.read[0], this.propertyArgs(prop.read[1], index, null, n), n), fn);
  }

  writeProperty({ prop, index }, n, fn) {
    if (!prop.write) throw err(n.target, `${this.propertyName(prop)} lässt sich nur lesen, nicht setzen.`);
    let value = n.value;
    if (n.op !== "=") {
      if (index && !isPure(index)) throw err(index, "Bei += und ++ darf der Index keinen Funktionsaufruf enthalten, schreibe ihn zuerst in eine Variable.");
      if (!prop.read) throw err(n.target, `${this.propertyName(prop)} lässt sich nicht lesen, also auch nicht mit ${n.op} ändern.`);
      value = { type: "Binary", op: n.op.slice(0, -1), left: n.target, right: n.value, line: n.line, col: n.col };
    }
    this.call(callNode(prop.write[0], this.propertyArgs(prop.write[1], index, value, n), n), fn);
    this.emit(fn, "DROP");
    return undefined;
  }

  arrayOf(n, fn) {
    if (n.object.type !== "Ident") throw err(n, "Eckige Klammern gehen nur direkt hinter dem Namen eines Felds.");
    const s = this.lookup(n.object.name, fn, n);
    if (!s) throw err(n.object, `„${n.object.name}“ ist nicht deklariert.`);
    if (s.kind !== "array") throw err(n.object, `„${n.object.name}“ ist kein Feld.`);
    return s;
  }

  call(n, fn) {
    const path = pathOf(n.callee);
    if (!path) throw err(n, "Aufrufen lässt sich nur eine Funktion mit ihrem Namen.");
    const name = path.join(".");
    if (name === "korg.onEvent") throw err(n, "korg.onEvent steht als eigene Anweisung ganz oben im Plugin-Code, nicht in einem Block, einer Funktion oder einem Ausdruck.");
    if (name === "korg.app") throw err(n, "korg.app steht als eigene Anweisung ganz oben im Plugin-Code, nicht in einem Block, einer Funktion oder einem Ausdruck.");
    if (path.length === 1) {
      const f = this.funcs.get(name);
      if (!f) throw err(n, this.lookupQuiet(name, fn) ? `„${name}“ ist keine Funktion.` : `Die Funktion „${name}“ gibt es nicht.`);
      if (n.args.length !== f.params) throw err(n, `„${name}“ nimmt ${f.params} Argument${f.params === 1 ? "" : "e"}, hier sind ${n.args.length}.`);
      n.args.forEach(a => this.val(a, fn, "int"));
      fn.line = n.line;
      this.emit(fn, "CALL", f.key, n.args.length);
      this.edges.push({ from: fn.key, to: f.key, at: n });
      return "int";
    }
    const api = API_BY_NAME.get(name);
    if (!api) throw err(n, `Die Funktion „${name}“ gibt es nicht.`);
    if (n.args.length !== api.args.length) throw err(n, `„${name}“ nimmt ${api.args.length} Argument${api.args.length === 1 ? "" : "e"} (${api.args.map(a => a.name).join(", ")}), hier sind ${n.args.length}.`);
    n.args.forEach((a, i) => {
      if (api.args[i].kind === "arr") { this.arrayArg(a, api, i, n, fn); return; }
      const t = this.val(a, fn);
      const want = api.args[i].kind;
      if (t !== want) throw err(a, `Das Argument „${api.args[i].name}“ von ${name} muss ${TYPE_NAME[want]} sein, das ist aber ${TYPE_NAME[t]}.`);
    });
    fn.line = n.line;
    this.emit(fn, "CALLAPI", api.id, api.args.length);
    this.apiSites.push({ fn: fn.key, api, at: n });
    return api.returns === "void" ? "void" : "int";
  }

  /**
   * An array argument: the name of a global array, passed as one value (ARRAY_HANDLE). The argument the contract names as
   * the strip width has to fit the array once it is a fixed number, so a call that can never draw is refused here.
   */
  arrayArg(a, api, i, call, fn) {
    const spec = api.args[i];
    const s = a.type === "Ident" ? this.lookup(a.name, fn, a) : null;
    if (!s || s.kind !== "array") throw err(a, `Das Argument „${spec.name}“ von ${api.name} muss ein Feld sein, zum Beispiel ${api.name}(bild, 0, 0, 8) mit const bild = [0, 255, 255, 0, 0, 255, 255, 0];.`);
    const strip = spec.strip ? call.args[api.args.findIndex(x => x.name === spec.strip)] : null;
    const width = strip ? this.fold(strip, fn) : null;
    if (width?.type === "int" && width.value > s.length) {
      throw err(a, `Das Feld „${a.name}“ hat ${s.length} Plätze, ${api.name} liest es in Streifen zu je ${width.value} (${spec.strip}).`);
    }
    this.pushConst(fn, { value: ARRAY_HANDLE.make(s.base, s.length), type: "int" }, a);
  }

  // ---- statements ----

  scoped(fn, body) {
    const top = fn.top;
    fn.scopes.push(new Map());
    fn.blockDepth += 1;
    try { body(); } finally {
      fn.scopes.pop();
      fn.blockDepth -= 1;
      fn.top = top;
    }
  }

  stmts(list, fn) { for (const s of list) this.stmt(s, fn); }

  stmt(n, fn) {
    fn.line = n.line;
    switch (n.type) {
      case "Block": return this.scoped(fn, () => this.stmts(n.body, fn));
      case "Let": return this.localLet(n, fn);
      case "ExprStmt": {
        if (pathOf(n.expr.callee)?.join(".") === "korg.onEvent") return this.registerHandler(n.expr, fn);
        if (pathOf(n.expr.callee)?.join(".") === "korg.app") return this.registerApp(n.expr, fn);
        this.expr(n.expr, fn);
        this.emit(fn, "DROP");
        return undefined;
      }
      case "Assign": return this.assign(n, fn);
      case "IncDec": return this.assign({ ...n, op: n.op === "++" ? "+=" : "-=", value: { type: "Num", value: 1, line: n.line, col: n.col } }, fn);
      case "If": {
        const other = this.newLabel("L");
        this.val(n.cond, fn, "int");
        this.emit(fn, "JZ", other);
        this.scoped(fn, () => this.stmt(n.then, fn));
        if (n.other) {
          const end = this.newLabel("L");
          this.emit(fn, "JMP", end);
          fn.items.push({ label: other });
          this.scoped(fn, () => this.stmt(n.other, fn));
          fn.items.push({ label: end });
        } else fn.items.push({ label: other });
        return undefined;
      }
      case "While": {
        const top = this.newLabel("L");
        const end = this.newLabel("L");
        fn.items.push({ label: top });
        this.val(n.cond, fn, "int");
        this.emit(fn, "JZ", end);
        fn.loops.push({ brk: end, cont: top });
        this.scoped(fn, () => this.stmt(n.body, fn));
        fn.loops.pop();
        this.emit(fn, "JMP", top);
        fn.items.push({ label: end });
        return undefined;
      }
      case "For": return this.scoped(fn, () => {
        const top = this.newLabel("L");
        const cont = this.newLabel("L");
        const end = this.newLabel("L");
        if (n.init) this.stmt(n.init, fn);
        fn.items.push({ label: top });
        if (n.cond) {
          this.val(n.cond, fn, "int");
          this.emit(fn, "JZ", end);
        }
        fn.loops.push({ brk: end, cont });
        this.scoped(fn, () => this.stmt(n.body, fn));
        fn.loops.pop();
        fn.items.push({ label: cont });
        if (n.update) this.stmt(n.update, fn);
        this.emit(fn, "JMP", top);
        fn.items.push({ label: end });
      });
      case "Break": case "Continue": {
        const loop = fn.loops.at(-1);
        if (!loop) throw err(n, `„${n.type === "Break" ? "break" : "continue"}“ gibt es nur in einer Schleife.`);
        this.emit(fn, "JMP", n.type === "Break" ? loop.brk : loop.cont);
        return undefined;
      }
      case "Return": {
        if (fn.kind === "start") throw err(n, "Im Plugin-Rumpf ganz oben gibt es kein „return“.");
        if (fn.kind === "handler") {
          if (n.value) throw err(n, "Ein Ereignis-Handler gibt nichts zurück.");
          this.emit(fn, "HALT");
        } else {
          if (n.value) this.val(n.value, fn, "int"); else this.pushConst(fn, { value: 0, type: "int" }, n);
          this.emit(fn, "RET");
        }
        return undefined;
      }
      case "Func": throw err(n, "Funktionen stehen nur ganz oben im Plugin-Code.");
      default: throw err(n, "Diese Anweisung gibt es nicht.");
    }
  }

  localLet(n, fn) {
    const top = fn.kind === "start" && fn.blockDepth === 0;
    for (const d of n.decls) {
      fn.line = d.line;
      if (top) {
        this.initGlobal(this.globals.get(d.name), d, fn);
        continue;
      }
      if (d.init?.type === "NewArray" || d.init?.type === "ArrayLit") throw err(d.init, "Felder gibt es nur ganz oben im Plugin-Code, nicht in einem Block oder einer Funktion.");
      if (n.kind === "const" && d.init) {
        const c = this.fold(d.init, fn);
        if (c) {
          this.declareLocal(fn, d.name, { kind: "const", value: c.value, type: c.type }, d);
          continue;
        }
      }
      const type = d.init ? this.val(d.init, fn) : "int";
      if (!d.init) this.pushConst(fn, { value: 0, type: "int" }, d);
      const slot = this.allocate(1, d, fn);
      this.emit(fn, "STORE", slot);
      this.declareLocal(fn, d.name, { kind: "var", slot, type, mutable: n.kind === "let" }, d);
    }
    return undefined;
  }

  initGlobal(g, d, fn) {
    if (g.kind === "const") return;
    if (g.kind === "array") {
      if (g.init.type === "ArrayLit") {
        const values = g.init.items.map(item => {
          const c = this.fold(item, fn);
          if (!c || c.type !== "int") throw err(item, "Die Werte eines Felds müssen feste Zahlen sein.");
          return c;
        });
        // values of 0 to 255 (pictures) go into the block's data section as bytes, the loader writes them; no code
        if (values.every(c => c.value >= 0 && c.value <= 255)) {
          const first = values.findIndex(c => c.value !== 0);
          if (first < 0) return;
          let last = values.length - 1;
          while (values[last].value === 0) last--;
          this.data.push({ base: g.base + first, bytes: Uint8Array.from(values.slice(first, last + 1), c => c.value) });
          return;
        }
        g.init.items.forEach((item, i) => {
          const c = values[i];
          if (c.value === 0) return; // the runtime clears every variable slot when it loads the block, so a 0 needs no code
          this.pushConst(fn, { value: i, type: "int" }, item);
          this.pushConst(fn, c, item);
          this.emit(fn, "ASTORE", g.base, g.length);
        });
      }
      return;
    }
    if (!d.init) return;
    const t = this.val(d.init, fn);
    if (t !== g.type) throw err(d.init, `„${d.name}“ ist ${TYPE_NAME[g.type]}, der Wert ist aber ${TYPE_NAME[t]}.`);
    this.emit(fn, "STORE", g.slot);
  }

  assign(n, fn) {
    const compound = n.op === "=" ? null : COMPOUND[n.op];
    const t = n.target;
    const prop = this.propertyOf(t, true);
    if (prop) return this.writeProperty(prop, n, fn);
    if (t.type === "Member") throw err(t, this.panelNameError(t) ?? `„${pathOf(t)?.join(".") ?? "." + t.name}“ lässt sich nicht setzen.`);
    if (t.type === "Ident") {
      const s = this.lookup(t.name, fn, t);
      if (!s) throw err(t, `„${t.name}“ ist nicht deklariert.`);
      if (s.kind === "array") throw err(t, `„${t.name}“ ist ein Feld und lässt sich nicht neu zuweisen, setze ein Element: ${t.name}[0] = …`);
      if (s.kind === "func") throw err(t, `„${t.name}“ ist eine Funktion.`);
      if (s.kind === "const" || !s.mutable) throw err(t, `„${t.name}“ ist const und lässt sich nicht ändern.`);
      if (compound) {
        if (s.type !== "int") throw err(t, "Mit Text lässt sich nicht rechnen.");
        this.emit(fn, "LOAD", s.slot);
        this.val(n.value, fn, "int");
        fn.line = n.line;
        this.emit(fn, compound);
      } else {
        const vt = this.val(n.value, fn);
        if (vt !== s.type) throw err(n.value, `„${t.name}“ ist ${TYPE_NAME[s.type]}, der Wert ist aber ${TYPE_NAME[vt]}.`);
      }
      this.emit(fn, "STORE", s.slot);
      return undefined;
    }
    const a = this.arrayOf(t, fn);
    this.val(t.index, fn, "int");
    if (compound) {
      if (!isPure(t.index)) throw err(t.index, "Bei += und ++ darf der Index keinen Funktionsaufruf enthalten, schreibe ihn zuerst in eine Variable.");
      this.val(t.index, fn, "int");
      this.emit(fn, "ALOAD", a.base, a.length);
      this.val(n.value, fn, "int");
      fn.line = n.line;
      this.emit(fn, compound);
    } else this.val(n.value, fn, "int");
    fn.line = n.line;
    this.emit(fn, "ASTORE", a.base, a.length);
    return undefined;
  }

  // ---- functions and handlers ----

  /** `korg.app("Snake", "GAMES")`: the plugin is an app. Top level, once, with a name and a group as plain texts. */
  registerApp(call, fn) {
    if (fn.kind !== "start" || fn.blockDepth !== 0) throw err(call, "korg.app steht ganz oben im Plugin-Code, nicht in einem Block oder einer Funktion.");
    if (call.args.length !== 2) throw err(call, "korg.app(\"Name\", \"GAMES\") nimmt zwei Argumente: den Namen der App und ihre Gruppe.");
    if (this.app) throw err(call, "Ein Plugin ist höchstens eine App: korg.app steht nur einmal im Plugin-Code.");
    const [nameNode, groupNode] = call.args;
    if (nameNode.type !== "Str") throw err(nameNode, "Der Name der App muss ein Text in Anführungszeichen sein.");
    if (groupNode.type !== "Str") throw err(groupNode, `Die Gruppe der App muss ein Text in Anführungszeichen sein: ${SCRIPT_APPS.groups.map(g => `„${g}“`).join(" oder ")}.`);
    if (!/^[ -~]{1,15}$/.test(nameNode.value) || nameNode.value.length > SCRIPT_APPS.nameLength) throw err(nameNode, `Der Name der App ist ASCII und hat 1 bis ${SCRIPT_APPS.nameLength} Zeichen, so steht er im Menü BLECH.`);
    if (!SCRIPT_APPS.groups.includes(groupNode.value)) throw err(groupNode, `Die Gruppe „${groupNode.value}“ gibt es nicht. Es gibt: ${SCRIPT_APPS.groups.join(", ")}.`);
    const api = API_BY_NAME.get("korg.app");
    this.pushConst(fn, { type: "str", value: nameNode.value }, nameNode);
    this.pushConst(fn, { type: "str", value: groupNode.value }, groupNode);
    fn.line = call.line;
    this.emit(fn, "CALLAPI", api.id, 2);
    this.emit(fn, "DROP");
    this.apiSites.push({ fn: fn.key, api, at: call });
    this.app = { name: nameNode.value, group: groupNode.value };
    return undefined;
  }

  registerHandler(call, fn) {
    if (fn.kind !== "start" || fn.blockDepth !== 0) throw err(call, "korg.onEvent steht ganz oben im Plugin-Code, nicht in einem Block oder einer Funktion.");
    if (call.args.length !== 2) throw err(call, "korg.onEvent(\"Ereignis\", Handler) nimmt zwei Argumente.");
    const [nameNode, handler] = call.args;
    if (nameNode.type !== "Str") throw err(nameNode, "Der Name des Ereignisses muss ein Text in Anführungszeichen sein.");
    const ev = EVENT_BY_NAME.get(nameNode.value);
    if (!ev) throw err(nameNode, `Das Ereignis „${nameNode.value}“ gibt es nicht. Es gibt: ${QUEUED_EVENTS.concat(["ready", "frame"], APP_EVENTS).sort().join(", ")}.`);
    if (ev.name === "start") throw err(nameNode, "„start“ ist der Plugin-Rumpf selbst: schreibe den Code einfach ganz oben hin.");
    if (this.handlers.some(h => h.event === ev.id)) throw err(nameNode, `Für „${ev.name}“ gibt es schon einen Handler.`);
    let params;
    let entry;
    if (handler.type === "FuncExpr") {
      params = handler.params;
      entry = `h_${ev.name}`;
      this.pending.push({ kind: "handler", key: entry, node: handler, event: ev });
    } else if (handler.type === "Ident" && this.funcs.has(handler.name)) {
      const f = this.funcs.get(handler.name);
      params = f.node.params;
      entry = f.key;
    } else throw err(handler, "Als Handler geht eine Funktion: () => { … } oder der Name einer Funktion.");
    if (params.length > ev.argc) throw err(handler, `Das Ereignis „${ev.name}“ liefert ${ev.argc} Wert${ev.argc === 1 ? "" : "e"}${ev.argc ? ` (${ev.args.join(", ")})` : ""}, der Handler nimmt ${params.length}.`);
    this.handlers.push({ event: ev.id, argc: params.length, entry, at: handler });
    return undefined;
  }

  compileFunction({ kind, key, node, params, event }) {
    const fn = new Fn(key, key, kind, kind === "handler" ? `Handler „${event.name}“` : key.replace(/^f_/, ""));
    fn.base = this.nextSlot;
    fn.line = node.line;
    this.fns.push(fn);
    fn.scopes.push(new Map());
    const list = params ?? node.params;
    const slots = list.map(p => {
      this.checkName(p.name, p);
      const slot = this.allocate(1, p, fn);
      this.declareLocal(fn, p.name, { kind: "var", slot, type: "int", mutable: true }, p);
      return slot;
    });
    for (const slot of slots.slice().reverse()) this.emit(fn, "STORE", slot);
    this.stmts(node.body.body, fn);
    const last = node.body.body.at(-1);
    if (last?.type !== "Return") {
      fn.line = last?.line ?? node.line;
      if (kind === "handler") this.emit(fn, "HALT");
      else {
        this.pushConst(fn, { value: 0, type: "int" }, node);
        this.emit(fn, "RET");
      }
    }
    this.nextSlot = fn.base + fn.max;
  }

  // ---- whole program ----

  run(source) {
    if (source.split("\n").length > LIMITS.sourceLines) throw new CompileError(`Das Plugin hat zu viele Zeilen (höchstens ${LIMITS.sourceLines}).`);
    const program = parse(source);
    this.declareGlobals(program);
    const start = new Fn("start", "start", "start", "das Plugin");
    start.base = this.nextSlot;
    start.scopes.push(new Map());
    this.fns.push(start);
    program.body.forEach((st, i) => {
      this.topIndex = i;
      if (st.type === "Func") return;
      this.stmt(st, start);
    });
    this.emit(start, "HALT");
    this.nextSlot = start.base + start.max;

    const queue = [...this.pending.splice(0)];
    for (const f of this.funcs.values()) queue.push({ kind: "func", key: f.key, node: f.node });
    for (const item of queue) this.compileFunction(item);

    this.checkCalls();
    return this.assembleAll();
  }

  displayOf(key) { return this.fns.find(f => f.key === key)?.display ?? key; }

  checkCalls() {
    const out = new Map();
    for (const e of this.edges) {
      if (!out.has(e.from)) out.set(e.from, []);
      out.get(e.from).push(e);
    }
    const state = new Map();
    const dfs = key => {
      state.set(key, 1);
      for (const e of out.get(key) ?? []) {
        if (state.get(e.to) === 1) throw err(e.at, `Rekursion ist nicht erlaubt: „${this.displayOf(e.from)}“ ruft „${this.displayOf(e.to)}“ auf, und das führt zurück. Alle Variablen haben feste Plätze, deshalb darf sich keine Funktion selbst aufrufen.`);
        if (!state.has(e.to)) dfs(e.to);
      }
      state.set(key, 2);
    };
    for (const f of this.fns) if (!state.has(f.key)) dfs(f.key);

    const roots = [{ key: "start", event: EVENT_BY_NAME.get("start") }, ...this.handlers.map(h => ({ key: h.entry, event: EVENTS[h.event] }))];
    for (const r of roots) {
      const seen = new Set();
      const visit = key => {
        if (seen.has(key)) return;
        seen.add(key);
        for (const s of this.apiSites) {
          if (s.fn === key && !(s.api.eventMask >> r.event.id & 1)) {
            const hint = r.event.name === "start" ? " Beim Start laufen nur Variablen und Registrierung, Ausgaben gehören in „ready“ oder „frame“." : "";
            throw err(s.at, `„${s.api.name}“ darf im Ereignis „${r.event.name}“ nicht benutzt werden (${this.displayOf(key)}).${hint}`);
          }
        }
        for (const e of out.get(key) ?? []) visit(e.to);
      };
      visit(r.key);
    }
  }

  assembleAll() {
    const order = [this.fns[0], ...this.fns.filter(f => f.kind === "handler"), ...this.fns.filter(f => f.kind === "func")];
    const items = order.flatMap(f => f.items);
    let asm;
    try { asm = assemble(items); } catch (e) { throw new CompileError(`Intern: ${e.message}`); }
    if (asm.code.length > LIMITS.code) throw new CompileError(`Das Plugin ist zu groß (${asm.code.length} Byte Code, höchstens ${LIMITS.code}).`);
    const handlers = this.handlers.map(h => ({ event: h.event, argc: h.argc, entry: asm.labels.get(h.entry) }));
    const parts = {
      name: this.name.slice(0, LIMITS.nameLength),
      apiVersion: Math.max(1, ...this.apiSites.map(s => s.api.since), ...this.handlers.map(h => Math.max(0, ...ARG_SINCE(h)))),
      entry: asm.labels.get("start"),
      code: asm.code,
      varCount: this.nextSlot,
      stackMax: LIMITS.stack,
      handlers,
      consts: this.consts,
      strings: this.strings,
      lines: asm.lines,
      data: this.data,
    };
    const draft = decodeBlob(encodeBlob(parts));
    const verdict = verifyParts(draft);
    if (!verdict.ok) {
      const e = verdict.error;
      throw new CompileError(`${e.message}`, e.offset === null ? 1 : lineAt(asm.lines, e.offset) || 1);
    }
    const blob = encodeBlob({ ...parts, stackMax: verdict.info.stackMax });
    const symbols = {};
    for (const [name, g] of this.globals) {
      if (g.kind === "var") symbols[name] = { kind: "var", slot: g.slot, type: g.type };
      else if (g.kind === "array") symbols[name] = { kind: "array", slot: g.base, length: g.length };
    }
    return {
      ok: true,
      blob,
      info: {
        name: parts.name,
        size: blob.length,
        codeSize: asm.code.length,
        vars: this.nextSlot,
        stackMax: verdict.info.stackMax,
        maxCallDepth: verdict.info.maxCallDepth,
        handlers: handlers.map(h => ({ event: EVENTS[h.event].name, argc: h.argc, entry: h.entry })),
        apiVersion: parts.apiVersion,
        app: this.app,
        symbols,
        lines: [...new Set(asm.lines.map(l => l.line))],
      },
    };
  }
}

/**
 * Compile a script. On success `blob` is the bytes to load or export and
 * `info` describes it (symbols maps global names to their variable slots).
 * On failure `errors` holds one entry: line, column, a German message.
 * `slotsAvailable` is a preliminary variable-slot limit, derived by default
 * from the arena byte size. A declaration crossing it is refused. The
 * loader checks the complete arena cost, including the blob and entry.
 * @returns {{ ok: true, blob: Uint8Array, info: object } | { ok: false, errors: { line: number, column: number, message: string }[] }}
 */
export function compile(source, { name = "script", slotsAvailable = BUDGET.variableSlots } = {}) {
  try {
    return new Compiler(name, slotsAvailable).run(source);
  } catch (e) {
    if (e instanceof CompileError) return { ok: false, errors: [{ line: e.line, column: e.column, message: e.message }] };
    throw e;
  }
}

export function formatError(e) {
  return `Zeile ${e.line}, Spalte ${e.column}: ${e.message}`;
}

export { CompileError };
