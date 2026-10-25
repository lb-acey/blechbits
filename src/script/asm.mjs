/**
 * A small assembler for script bytecode, used by the compiler's back end and
 * by tests that need hand-made code. An item is `{ label }`, `{ op, args, line }`
 * or the short form `["OP", arg, ...]` / `"label:"`. A target operand is a
 * label name or a plain code offset, so a test can aim a jump anywhere.
 */
import { OPCODE_BY_NAME } from "../../data/script/contract.mjs";

const normalize = item => {
  if (typeof item === "string") return { label: item.replace(/:$/, "") };
  if (Array.isArray(item)) return { op: item[0], args: item.slice(1) };
  return item;
};

/** @returns {{ code: Uint8Array, labels: Map<string, number>, offsets: number[], lines: { offset: number, line: number }[] }} */
export function assemble(items) {
  const list = items.map(normalize);
  const labels = new Map();
  const offsets = [];
  let pc = 0;
  for (const it of list) {
    offsets.push(pc);
    if (it.label !== undefined) {
      if (labels.has(it.label)) throw new Error(`label ${it.label} defined twice`);
      labels.set(it.label, pc);
    } else {
      const info = OPCODE_BY_NAME.get(it.op);
      if (!info) throw new Error(`unknown opcode ${it.op}`);
      pc += info.size;
    }
  }
  const code = new Uint8Array(pc);
  const lines = [];
  let lastLine = null;
  list.forEach((it, i) => {
    if (it.label !== undefined) return;
    const info = OPCODE_BY_NAME.get(it.op);
    let at = offsets[i];
    code[at++] = info.code;
    info.operands.forEach((o, k) => {
      let v = it.args?.[k] ?? 0;
      if (typeof v === "string") {
        if (!labels.has(v)) throw new Error(`unknown label ${v}`);
        v = labels.get(v);
      }
      if (!Number.isInteger(v) || v < 0 || v >= 1 << (8 * o.size)) throw new Error(`${it.op}: operand ${o.name} = ${v} does not fit ${o.size} byte(s)`);
      code[at++] = v & 0xff;
      if (o.size === 2) code[at++] = v >> 8;
    });
    if (it.line !== undefined && it.line !== lastLine) {
      lines.push({ offset: offsets[i], line: it.line });
      lastLine = it.line;
    }
  });
  return { code, labels, offsets, lines };
}
