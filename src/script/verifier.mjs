/**
 * The bytecode verifier. A blob that passes cannot jump outside its code,
 * name a constant, text, variable or API entry that is not there, or leave
 * the operand stack unbalanced or too deep, and no function it can reach is
 * recursive or calls an API entry its event may not use. The VM re-checks
 * what is cheap at run time; this is what the loader runs once.
 *
 * A function is a code region reached from an entry: the script body, a
 * handler, or a CALL target. Its depth counts from the arguments it was
 * called with. Calls consume `argc` values and leave one.
 */
import {
  ERROR, LIMITS, API_BY_ID, API_VERSION, EVENT_BY_ID,
} from "../../data/script/contract.mjs";
import { decodeBlob, decodeInstructions, fail } from "./blob.mjs";

/** Verify a blob's bytes: container first, then the code. */
export function verify(bytes) {
  const parts = decodeBlob(bytes);
  if (!parts.ok) return parts;
  return verifyParts(parts);
}

/**
 * @param {object} parts as returned by decodeBlob
 * @returns {{ ok: true, info: { stackMax: number, maxCallDepth: number, functions: object[], offsets: number[] } } | { ok: false, error: object }}
 */
export function verifyParts(parts) {
  const { header: h, handlers, code, lines } = parts;
  const err = (c, detail, offset) => ({ ok: false, error: fail(c, detail, offset) });
  const decoded = decodeInstructions(code);
  if (!decoded.ok) return decoded;
  const list = decoded.list;
  if (list.length === 0) return err(ERROR.BAD_JUMP, "kein Code");
  const at = new Map(list.map((ins, i) => [ins.offset, i]));
  const last = list.at(-1);
  if (last.info.flow !== "end" && last.info.flow !== "jump") return err(ERROR.BAD_JUMP, "der Code endet ohne HALT, RET oder JMP", last.offset);

  for (const ins of list) {
    for (const o of ins.info.operands) {
      const v = ins.operands[o.name];
      const here = ins.offset;
      if (o.as === "const" && v >= h.constCount) return err(ERROR.BAD_CONST, `Konstante ${v} von ${h.constCount}`, here);
      if (o.as === "string" && v >= h.stringCount) return err(ERROR.BAD_STRING, `Text ${v} von ${h.stringCount}`, here);
      if (o.as === "var" && v >= h.varCount) return err(ERROR.BAD_VAR, `Variable ${v} von ${h.varCount}`, here);
      if (o.as === "target" && !at.has(v)) return err(ERROR.BAD_JUMP, `Ziel ${v} ist kein Befehlsanfang`, here);
    }
    if (ins.info.operands.some(o => o.as === "arrayBase")) {
      const { base, length } = ins.operands;
      if (length === 0 || base + length > h.varCount) return err(ERROR.BAD_VAR, `Feld ${base}+${length} von ${h.varCount} Variablen`, ins.offset);
    }
    if (ins.info.name === "CALLAPI") {
      const api = API_BY_ID.get(ins.operands.id);
      if (!api) return err(ERROR.API_UNKNOWN, `Id ${ins.operands.id}`, ins.offset);
      if (api.since > h.apiVersion) return err(ERROR.API_VERSION, `${api.name} gehört zu Version ${api.since}, der Block nennt ${h.apiVersion}`, ins.offset);
      if (ins.operands.argc !== api.args.length) return err(ERROR.API_ARGC, `${api.name} nimmt ${api.args.length}, der Block ruft mit ${ins.operands.argc}`, ins.offset);
    }
  }
  if (h.apiVersion > API_VERSION) return err(ERROR.API_VERSION, `Block ${h.apiVersion}, diese Laufzeit ${API_VERSION}`);

  // Entries: the body, the handlers, and every CALL target; each with the argument count it starts with.
  const entryArgc = new Map([[h.entry, 0]]);
  const roots = [{ entry: h.entry, event: 0 }];
  if (!at.has(h.entry)) return err(ERROR.BAD_HANDLER, `Einstieg ${h.entry} ist kein Befehlsanfang`);
  const seenEvents = new Set();
  for (const hd of handlers) {
    const ev = EVENT_BY_ID.get(hd.event);
    if (!ev || ev.name === "start") return err(ERROR.BAD_HANDLER, `Ereignis ${hd.event} gibt es nicht oder ist der Plugin-Rumpf`);
    if (seenEvents.has(hd.event)) return err(ERROR.BAD_HANDLER, `Ereignis ${ev.name} doppelt`);
    seenEvents.add(hd.event);
    if (!at.has(hd.entry)) return err(ERROR.BAD_HANDLER, `Einstieg von ${ev.name} (${hd.entry}) ist kein Befehlsanfang`);
    if (hd.argc > ev.argc) return err(ERROR.BAD_HANDLER, `${ev.name} liefert ${ev.argc} Werte, der Handler nimmt ${hd.argc}`);
    if (entryArgc.has(hd.entry) && entryArgc.get(hd.entry) !== hd.argc) return err(ERROR.STACK_MISMATCH, `Einstieg ${hd.entry} mit zwei Argumentzahlen`);
    entryArgc.set(hd.entry, hd.argc);
    roots.push({ entry: hd.entry, event: hd.event });
  }

  const fns = new Map();
  const queue = [...entryArgc.keys()];
  const analyzeFn = entry => {
    const argc = entryArgc.get(entry);
    const depthAt = new Map();
    const fn = { entry, argc, need: argc, calls: [], apis: [], reach: new Set() };
    const work = [[at.get(entry), argc]];
    while (work.length) {
      let [i, depth] = work.pop();
      for (;;) {
        const ins = list[i];
        if (depthAt.has(i)) {
          if (depthAt.get(i) !== depth) return err(ERROR.STACK_MISMATCH, `Stapelhöhe ${depthAt.get(i)} und ${depth} laufen bei ${ins.offset} zusammen`, ins.offset);
          break;
        }
        depthAt.set(i, depth);
        fn.reach.add(ins.offset);
        const info = ins.info;
        const pop = info.pop === "argc" ? ins.operands.argc : info.pop;
        if (depth < pop) return err(ERROR.STACK, `${info.name} bei ${ins.offset} braucht ${pop}, der Stapel hat ${depth}`, ins.offset);
        depth = depth - pop + info.push;
        fn.need = Math.max(fn.need, depth);
        if (info.name === "CALLAPI") fn.apis.push({ offset: ins.offset, api: API_BY_ID.get(ins.operands.id) });
        if (info.name === "CALL") {
          const target = ins.operands.target;
          const want = ins.operands.argc;
          if (entryArgc.has(target) && entryArgc.get(target) !== want) return err(ERROR.STACK_MISMATCH, `Aufruf bei ${ins.offset} mit ${want} Argumenten, der Einstieg ${target} erwartet ${entryArgc.get(target)}`, ins.offset);
          if (!entryArgc.has(target)) { entryArgc.set(target, want); queue.push(target); }
          fn.calls.push({ offset: ins.offset, target, depthBefore: depth + pop - 1 });
        }
        if (info.flow === "end") {
          if (info.name === "HALT" && depth !== 0) return err(ERROR.STACK_MISMATCH, `HALT bei ${ins.offset} mit ${depth} Werten auf dem Stapel`, ins.offset);
          if (info.name === "RET" && depth !== 0) return err(ERROR.STACK_MISMATCH, `RET bei ${ins.offset} lässt ${depth} Werte auf dem Stapel`, ins.offset);
          break;
        }
        if (info.flow === "jump") { i = at.get(ins.operands.target); continue; }
        if (info.flow === "branch") work.push([at.get(ins.operands.target), depth]);
        i += 1;
      }
    }
    fns.set(entry, fn);
    return null;
  };
  while (queue.length) {
    const e = queue.shift();
    if (fns.has(e)) continue;
    const bad = analyzeFn(e);
    if (bad) return bad;
  }

  // Call graph: no recursion, bounded call depth, total operand stack.
  const state = new Map();
  const total = new Map();
  const frames = new Map();
  const walk = entry => {
    if (state.get(entry) === 2) return null;
    state.set(entry, 1);
    const fn = fns.get(entry);
    let need = fn.need;
    let deep = 0;
    for (const c of fn.calls) {
      if (state.get(c.target) === 1) return err(ERROR.RECURSION, `der Aufruf bei ${c.offset} schließt einen Kreis`, c.offset);
      const bad = walk(c.target);
      if (bad) return bad;
      const callee = fns.get(c.target);
      need = Math.max(need, c.depthBefore - callee.argc + total.get(c.target));
      deep = Math.max(deep, 1 + frames.get(c.target));
    }
    total.set(entry, need);
    frames.set(entry, deep);
    state.set(entry, 2);
    return null;
  };
  let stackMax = 0;
  let maxCallDepth = 0;
  for (const r of roots) {
    const bad = walk(r.entry);
    if (bad) return bad;
    stackMax = Math.max(stackMax, total.get(r.entry));
    maxCallDepth = Math.max(maxCallDepth, frames.get(r.entry));
  }
  if (stackMax > LIMITS.stack) return err(ERROR.STACK, `${stackMax} Werte tief, höchstens ${LIMITS.stack}`);
  if (maxCallDepth > LIMITS.callDepth) return err(ERROR.CALL_DEPTH, `${maxCallDepth} Aufrufe tief, höchstens ${LIMITS.callDepth}`);
  if (h.stackMax < stackMax) return err(ERROR.STACK_MISMATCH, `der Kopf nennt ${h.stackMax}, der Code braucht ${stackMax}`);

  // Which API entries each event can reach.
  for (const r of roots) {
    const ev = EVENT_BY_ID.get(r.event);
    const seen = new Set();
    const visit = entry => {
      if (seen.has(entry)) return null;
      seen.add(entry);
      const fn = fns.get(entry);
      for (const a of fn.apis) {
        if (!(a.api.eventMask >> r.event & 1)) return err(ERROR.API_EVENT, `${a.api.name} im Ereignis ${ev.name}`, a.offset);
      }
      for (const c of fn.calls) {
        const bad = visit(c.target);
        if (bad) return bad;
      }
      return null;
    };
    const bad = visit(r.entry);
    if (bad) return bad;
  }

  let prev = -1;
  for (const l of lines) {
    if (l.offset >= code.length || !at.has(l.offset) || l.offset <= prev || l.line < 1) return err(ERROR.BAD_LINES, `Eintrag bei ${l.offset}, Zeile ${l.line}`);
    prev = l.offset;
  }

  return {
    ok: true,
    info: {
      stackMax,
      maxCallDepth,
      functions: [...fns.values()].map(f => ({ entry: f.entry, argc: f.argc, need: f.need })),
      offsets: list.map(i => i.offset),
    },
  };
}
