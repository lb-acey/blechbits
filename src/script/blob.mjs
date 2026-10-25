/**
 * The script blob: packing, structural decoding, instruction decoding and a
 * listing. The layout is data/script/contract.mjs (HEADER, SECTION).
 * Decoding checks the container only; src/script/verifier.mjs checks that
 * the code in it is safe to run.
 */
import {
  FORMAT_VERSION, API_VERSION, MAGIC, LIMITS, HEADER, SECTION, ERROR, ERROR_BY_CODE,
  OPCODE_BY_CODE, OPCODE_COUNT, EVENT_BY_ID, BLOCK_FLAGS,
} from "../../data/script/contract.mjs";

/** A load or run failure: the contract's code, its name and message, and where in the code it happened. */
export function fail(code, detail = "", offset = null) {
  const info = ERROR_BY_CODE.get(code);
  return { code, name: info.name, message: detail ? `${info.message}: ${detail}` : info.message, offset };
}

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, from = 0, to = bytes.length) {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const pad4 = n => (n + 3) & ~3;

export function sectionOffsets(h) {
  const handlers = HEADER.size;
  const consts = handlers + SECTION.handler * h.handlerCount;
  const strings = consts + SECTION.constant * h.constCount;
  const code = strings + SECTION.string * h.stringCount;
  const lines = code + pad4(h.codeSize);
  const total = lines + SECTION.line * h.lineCount;
  return { handlers, consts, strings, code, lines, total };
}

const latin1 = (bytes, from, to) => {
  let s = "";
  for (let i = from; i < to && bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

/**
 * Pack parts into a blob. Nothing is validated beyond what fits in the
 * fields, so tests can build broken blobs on purpose.
 * @param {{ name?: string, apiVersion?: number, formatVersion?: number, entry?: number, code?: Uint8Array | number[],
 *   varCount?: number, stackMax?: number, handlers?: { event: number, argc: number, entry: number }[],
 *   consts?: number[], strings?: string[], lines?: { offset: number, line: number }[] }} p
 */
export function encodeBlob(p) {
  const code = Uint8Array.from(p.code ?? []);
  const handlers = p.handlers ?? [];
  const consts = p.consts ?? [];
  const strings = p.strings ?? [];
  const lines = p.lines ?? [];
  const data = p.data ?? [];
  const h = { handlerCount: handlers.length, constCount: consts.length, stringCount: strings.length, codeSize: code.length, lineCount: lines.length };
  const at = sectionOffsets(h);
  const dataSize = data.reduce((n, r) => n + SECTION.dataRecord + pad4(r.bytes.length), 0);
  const total = at.total + dataSize;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  const values = {
    magic: MAGIC, formatVersion: p.formatVersion ?? FORMAT_VERSION, apiVersion: p.apiVersion ?? 1, totalSize: total,
    varCount: p.varCount ?? 0, entry: p.entry ?? 0, stackMax: p.stackMax ?? 0, flags: (p.flags ?? 0) | (data.length ? BLOCK_FLAGS.DATA : 0), ...h,
  };
  for (const f of HEADER.fields) {
    if (f.type === "u32") dv.setUint32(f.offset, values[f.name] ?? 0, true);
    else if (f.type === "u16") dv.setUint16(f.offset, values[f.name] ?? 0, true);
  }
  const name = p.name ?? "";
  const nameAt = HEADER.fields.find(f => f.name === "name").offset;
  for (let i = 0; i < LIMITS.nameLength && i < name.length; i++) out[nameAt + i] = name.charCodeAt(i) & 0xff;
  handlers.forEach((e, i) => {
    const o = at.handlers + i * SECTION.handler;
    out[o] = e.event;
    out[o + 1] = e.argc;
    dv.setUint16(o + 2, e.entry, true);
  });
  consts.forEach((v, i) => dv.setInt32(at.consts + i * SECTION.constant, v, true));
  strings.forEach((s, i) => {
    for (let k = 0; k < s.length && k < LIMITS.stringSlot; k++) out[at.strings + i * SECTION.string + k] = s.charCodeAt(k) & 0xff;
  });
  out.set(code, at.code);
  lines.forEach((l, i) => {
    dv.setUint16(at.lines + i * SECTION.line, l.offset, true);
    dv.setUint16(at.lines + i * SECTION.line + 2, l.line, true);
  });
  let o = at.total;
  for (const r of data) {
    dv.setUint16(o, r.base, true);
    dv.setUint16(o + 2, r.bytes.length, true);
    out.set(r.bytes, o + SECTION.dataRecord);
    o += SECTION.dataRecord + pad4(r.bytes.length);
  }
  dv.setUint32(HEADER.fields.find(f => f.name === "checksum").offset, crc32(out, HEADER.checksumFrom, total), true);
  return out;
}

/**
 * Check the container and split it into parts. `bytes` is the region the
 * blob sits in: bytes after totalSize (an erased flash tail) are ignored.
 * @returns {{ ok: true, header: object, handlers: object[], consts: Int32Array, strings: string[], code: Uint8Array, lines: object[] } | { ok: false, error: object }}
 */
export function decodeBlob(bytes) {
  const bad = (code, detail, offset) => ({ ok: false, error: fail(code, detail, offset) });
  // Magic and version come first and need only 8 bytes, so a blob of another format is told so, not "truncated".
  if (bytes.length < 8) return bad(ERROR.TRUNCATED, `${bytes.length} Bytes`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) return bad(ERROR.MAGIC);
  const version = dv.getUint16(4, true);
  if (version !== FORMAT_VERSION) return bad(ERROR.FORMAT_VERSION, `Block ${version}, diese Laufzeit ${FORMAT_VERSION}`);
  if (bytes.length < HEADER.size) return bad(ERROR.TRUNCATED, `${bytes.length} Bytes, der Kopf braucht ${HEADER.size}`);
  const h = {};
  for (const f of HEADER.fields) {
    if (f.type === "u32") h[f.name] = dv.getUint32(f.offset, true);
    else if (f.type === "u16") h[f.name] = dv.getUint16(f.offset, true);
    else h[f.name] = latin1(bytes, f.offset, f.offset + 16);
  }
  if (h.apiVersion < 1 || h.apiVersion > API_VERSION) return bad(ERROR.API_VERSION, `Block ${h.apiVersion}, diese Laufzeit ${API_VERSION}`);
  const over = [
    ["Code", h.codeSize, LIMITS.code], ["Variablen", h.varCount, LIMITS.vars], ["Stapel", h.stackMax, LIMITS.stack],
    ["Konstanten", h.constCount, LIMITS.consts], ["Texte", h.stringCount, LIMITS.strings], ["Ereignisse", h.handlerCount, EVENT_BY_ID.size],
    ["Zeilen", h.lineCount, LIMITS.code],
  ].find(([, n, max]) => n > max);
  if (over) return bad(ERROR.LIMITS, `${over[0]}: ${over[1]} von höchstens ${over[2]}`);
  const at = sectionOffsets(h);
  if (h.flags & ~BLOCK_FLAGS.KNOWN) return bad(ERROR.BAD_SIZE, "unbekannte Bits im Feld flags");
  if (h.flags & BLOCK_FLAGS.DATA ? h.totalSize <= at.total : h.totalSize !== at.total) return bad(ERROR.BAD_SIZE, `Kopf nennt ${h.totalSize} Bytes, die Abschnitte brauchen ${at.total}`);
  if (bytes.length < h.totalSize) return bad(ERROR.TRUNCATED, `${bytes.length} von ${h.totalSize} Bytes`);
  if (crc32(bytes, HEADER.checksumFrom, h.totalSize) !== h.checksum) return bad(ERROR.CHECKSUM);
  const data = [];
  for (let o = at.total; o < h.totalSize;) {
    if (o + SECTION.dataRecord > h.totalSize) return bad(ERROR.BAD_SIZE, "Datenabschnitt endet mitten in einem Eintrag");
    const base = dv.getUint16(o, true), count = dv.getUint16(o + 2, true);
    if (count === 0 || base + count > h.varCount) return bad(ERROR.BAD_VAR, `Daten für Feld ${base}+${count} von ${h.varCount} Variablen`);
    const next = o + SECTION.dataRecord + pad4(count);
    if (next > h.totalSize) return bad(ERROR.BAD_SIZE, "Datenabschnitt endet mitten in einem Eintrag");
    data.push({ base, bytes: bytes.slice(o + SECTION.dataRecord, o + SECTION.dataRecord + count) });
    o = next;
  }

  const handlers = Array.from({ length: h.handlerCount }, (_, i) => {
    const o = at.handlers + i * SECTION.handler;
    return { event: bytes[o], argc: bytes[o + 1], entry: dv.getUint16(o + 2, true) };
  });
  const consts = new Int32Array(h.constCount);
  for (let i = 0; i < h.constCount; i++) consts[i] = dv.getInt32(at.consts + i * SECTION.constant, true);
  const strings = [];
  for (let i = 0; i < h.stringCount; i++) {
    const from = at.strings + i * SECTION.string;
    const slot = bytes.subarray(from, from + SECTION.string);
    if (slot[SECTION.string - 1] !== 0) return bad(ERROR.BAD_STRING, `Text ${i} hat keine Endmarke`);
    const end = slot.indexOf(0);
    for (let k = 0; k < end; k++) if (slot[k] < 0x20 || slot[k] > 0x7e) return bad(ERROR.BAD_STRING, `Text ${i} enthält ein Zeichen, das das Display nicht zeigt`);
    for (let k = end; k < slot.length; k++) if (slot[k] !== 0) return bad(ERROR.BAD_STRING, `Text ${i} hat Reste hinter der Endmarke`);
    strings.push(String.fromCharCode(...slot.subarray(0, end)));
  }
  const code = bytes.slice(at.code, at.code + h.codeSize);
  const lines = Array.from({ length: h.lineCount }, (_, i) => {
    const o = at.lines + i * SECTION.line;
    return { offset: dv.getUint16(o, true), line: dv.getUint16(o + 2, true) };
  });
  return { ok: true, header: h, handlers, consts, strings, code, lines, data };
}

/** The source line of the instruction at `offset`: the last line table entry at or before it, or 0. */
export function lineAt(lines, offset) {
  let line = 0;
  for (const l of lines) {
    if (l.offset > offset) break;
    line = l.line;
  }
  return line;
}

/**
 * Split code into instructions. Stops at the first byte that is not an
 * opcode or whose operands run past the end.
 * @returns {{ ok: true, list: object[] } | { ok: false, error: object }}
 */
export function decodeInstructions(code) {
  const list = [];
  let pc = 0;
  while (pc < code.length) {
    const info = code[pc] < OPCODE_COUNT ? OPCODE_BY_CODE[code[pc]] : null;
    if (!info) return { ok: false, error: fail(ERROR.BAD_OPCODE, `0x${code[pc].toString(16)} bei ${pc}`, pc) };
    if (pc + info.size > code.length) return { ok: false, error: fail(ERROR.TRUNCATED, `${info.name} bei ${pc} ohne Operanden`, pc) };
    const operands = {};
    let at = pc + 1;
    for (const o of info.operands) {
      operands[o.name] = o.size === 1 ? code[at] : code[at] | (code[at + 1] << 8);
      at += o.size;
    }
    list.push({ offset: pc, info, operands });
    pc += info.size;
  }
  return { ok: true, list };
}

/** A readable listing of decoded parts, one instruction per line, with source lines where the table has them. */
export function disassemble(parts) {
  const decoded = decodeInstructions(parts.code);
  const rows = [];
  const mark = new Map(parts.handlers.map(h => [h.entry, `${EVENT_BY_ID.get(h.event)?.name ?? `event ${h.event}`}`]));
  mark.set(parts.header.entry, "start");
  let last = -1;
  for (const ins of decoded.list ?? []) {
    if (mark.has(ins.offset)) rows.push(`${mark.get(ins.offset)}:`);
    const line = lineAt(parts.lines, ins.offset);
    const operands = ins.info.operands.map(o => ins.operands[o.name]).join(" ");
    rows.push(`  ${String(ins.offset).padStart(4, "0")}  ${ins.info.name.padEnd(8)}${operands.padEnd(10)}${line !== last ? `; Zeile ${line}` : ""}`.trimEnd());
    last = line;
  }
  if (!decoded.ok) rows.push(`; ${decoded.error.message}`);
  return rows.join("\n");
}

/**
 * A copy of a block with the PROBED flag set (or cleared with `on` false) and the checksum made again, for what the
 * editor lets out after its probe. The device asks once before it runs a block without the flag.
 */
export function markProbed(bytes, on = true) {
  const out = Uint8Array.from(bytes);
  const dv = new DataView(out.buffer);
  const flagsAt = HEADER.fields.find(f => f.name === "flags").offset;
  const flags = dv.getUint16(flagsAt, true);
  dv.setUint16(flagsAt, on ? flags | BLOCK_FLAGS.PROBED : flags & ~BLOCK_FLAGS.PROBED, true);
  const total = dv.getUint32(HEADER.fields.find(f => f.name === "totalSize").offset, true);
  dv.setUint32(HEADER.fields.find(f => f.name === "checksum").offset, crc32(out, HEADER.checksumFrom, total), true);
  return out;
}

/** True when the block carries the PROBED flag. */
export const isProbed = bytes => (new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(HEADER.fields.find(f => f.name === "flags").offset, true) & BLOCK_FLAGS.PROBED) !== 0;
