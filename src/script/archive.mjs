/**
 * Script files for the card: the collection `e2sPlugin.all` (many blocks) and
 * the single `.blech` file (one block plus an optional description and source
 * trailer). The layouts are data/script/contract.mjs (ARCHIVE, DESC_TRAILER,
 * SOURCE_TRAILER). The device loads the blocks and shows the description; the
 * source trailer is for the editor.
 */
import { ARCHIVE, SOURCE_TRAILER, DESC_TRAILER, MAGIC, ERROR } from "../../data/script/contract.mjs";
import { crc32, decodeBlob, fail } from "./blob.mjs";

// Returns the decoded parts, or the error when the block cannot be loaded from a file.
function checkBlock(bytes, label) {
  if (bytes.length > ARCHIVE.maxBlock) {
    return { ok: false, error: fail(ERROR.LIMITS, `${label}: Block ${bytes.length} Bytes, die Karte nimmt höchstens ${ARCHIVE.maxBlock}`) };
  }
  const parts = decodeBlob(bytes);
  if (!parts.ok) return { ok: false, error: { ...parts.error, message: `${label}: ${parts.error.message}` } };
  if (parts.header.totalSize !== bytes.length) {
    return { ok: false, error: fail(ERROR.BAD_SIZE, `${label}: Block ${parts.header.totalSize} Bytes, Datei ${bytes.length}`) };
  }
  return { ok: true, parts };
}

/**
 * Build `e2sPlugin.all` from blocks.
 * @param {Uint8Array[]} blocks
 * @returns {{ ok: true, bytes: Uint8Array } | { ok: false, error: object }}
 */
export function packAll(blocks) {
  if (blocks.length > 0xffff) return { ok: false, error: fail(ERROR.LIMITS, `${blocks.length} Plugins, höchstens 65535`) };
  const names = new Set();
  let size = ARCHIVE.headerSize;
  for (const [i, block] of blocks.entries()) {
    const checked = checkBlock(block, `Plugin ${i + 1}`);
    if (!checked.ok) return checked;
    const name = checked.parts.header.name;
    if (names.has(name)) return { ok: false, error: { code: null, name: "DUPLICATE_NAME", message: `der Name "${name}" kommt zweimal vor`, offset: null } };
    names.add(name);
    size += block.length;
  }
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, ARCHIVE.magic, true);
  dv.setUint16(4, ARCHIVE.version, true);
  dv.setUint16(6, blocks.length, true);
  dv.setUint32(8, size, true);
  let at = ARCHIVE.headerSize;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  dv.setUint32(12, crc32(out, ARCHIVE.checksumFrom, size), true);
  return { ok: true, bytes: out };
}

/**
 * Read `e2sPlugin.all`. The file is rejected as a whole when its header or
 * checksum is wrong; a bad block is reported on its own and the others stay
 * usable, as the device does.
 * @returns {{ ok: true, blocks: { name: string, offset: number, size: number, bytes: Uint8Array, error: object | null }[] } | { ok: false, error: object }}
 */
export function parseAll(bytes) {
  const bad = (code, detail) => ({ ok: false, error: fail(code, detail) });
  if (bytes.length < ARCHIVE.headerSize) return bad(ERROR.TRUNCATED, `${bytes.length} Bytes, der Kopf braucht ${ARCHIVE.headerSize}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== ARCHIVE.magic) return bad(ERROR.MAGIC, "keine Sammeldatei e2sPlugin.all");
  const version = dv.getUint16(4, true);
  if (version !== ARCHIVE.version) return bad(ERROR.FORMAT_VERSION, `Datei ${version}, diese Laufzeit ${ARCHIVE.version}`);
  const count = dv.getUint16(6, true);
  const total = dv.getUint32(8, true);
  if (total < ARCHIVE.headerSize + count * 52) return bad(ERROR.BAD_SIZE, `Kopf nennt ${total} Bytes für ${count} Plugins`);
  if (bytes.length < total) return bad(ERROR.TRUNCATED, `${bytes.length} von ${total} Bytes`);
  if (crc32(bytes, ARCHIVE.checksumFrom, total) !== dv.getUint32(12, true)) return bad(ERROR.CHECKSUM);
  const blocks = [];
  let at = ARCHIVE.headerSize;
  for (let i = 0; i < count; i++) {
    if (at + 52 > total) return bad(ERROR.TRUNCATED, `Plugin ${i + 1} fehlt`);
    const size = dv.getUint32(at + 8, true);
    if (size < 52 || size > ARCHIVE.maxBlock || size % 4 || at + size > total) return bad(ERROR.BAD_SIZE, `Plugin ${i + 1} nennt ${size} Bytes`);
    const block = bytes.slice(at, at + size);
    const checked = checkBlock(block, `Plugin ${i + 1}`);
    blocks.push({ name: checked.ok ? checked.parts.header.name : "", offset: at, size, bytes: block, error: checked.ok ? null : checked.error });
    at += size;
  }
  if (at !== total) return bad(ERROR.BAD_SIZE, `Kopf nennt ${total} Bytes, die Plugins brauchen ${at}`);
  return { ok: true, blocks };
}

const UMLAUTS = { ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss" };

/**
 * The description the device shows for a plugin: the `//` lines at the top of its source (an empty `//` line starts a new
 * paragraph), in ASCII, wrapped to DESC_TRAILER.width. Empty when the source does not start with a comment.
 * @param {string} source
 */
export function describeSource(source) {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const paragraphs = [[]];
  for (const line of lines) {
    const m = /^\s*\/\/ ?(.*)$/.exec(line);
    if (!m) break;
    const text = m[1].replace(/[äöüÄÖÜß]/g, c => UMLAUTS[c]).replace(/[^ -~]/g, "").trim();
    if (text) paragraphs[paragraphs.length - 1].push(text);
    else if (paragraphs[paragraphs.length - 1].length) paragraphs.push([]);
  }
  const out = [];
  for (const words of paragraphs.filter(p => p.length).map(p => p.join(" ").split(/\s+/))) {
    if (out.length) out.push("");
    let row = "";
    for (let word of words) {
      while (word.length > DESC_TRAILER.width) {
        if (row) out.push(row);
        out.push(word.slice(0, DESC_TRAILER.width));
        word = word.slice(DESC_TRAILER.width);
        row = "";
      }
      if (!word) continue;
      if (row && row.length + 1 + word.length > DESC_TRAILER.width) {
        out.push(row);
        row = word;
      } else row = row ? `${row} ${word}` : word;
    }
    if (row) out.push(row);
  }
  let text = "";
  for (const row of out) {
    if (text.length + row.length + 1 > DESC_TRAILER.maxBytes) break;
    text += `${row}\n`;
  }
  return text;
}

function trailer(magic, bytes) {
  const out = new Uint8Array(SOURCE_TRAILER.headerSize + bytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, magic, true);
  dv.setUint32(4, bytes.length, true);
  out.set(bytes, SOURCE_TRAILER.headerSize);
  return out;
}

/**
 * Build a `.blech` file: one block, then, with a source, the description taken from it (when it has one) and the source.
 * @param {Uint8Array} block
 * @param {string} [source]
 */
export function packBlech(block, source) {
  const checked = checkBlock(block, "Plugin");
  if (!checked.ok) return checked;
  const parts = [block];
  if (source !== undefined) {
    const description = describeSource(source);
    if (description) parts.push(trailer(DESC_TRAILER.magic, new TextEncoder().encode(description)));
    parts.push(trailer(SOURCE_TRAILER.magic, new TextEncoder().encode(source)));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return { ok: true, bytes: out };
}

/**
 * Read a `.blech` file. The device loads the block and reads the description; a missing or damaged trailer only means there is
 * no description or source to show.
 * @returns {{ ok: true, block: Uint8Array, source: string | null, description: string | null, parts: object } | { ok: false, error: object }}
 */
export function parseBlech(bytes) {
  if (bytes.length < 12) return { ok: false, error: fail(ERROR.TRUNCATED, `${bytes.length} Bytes`) };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) return { ok: false, error: fail(ERROR.MAGIC) };
  const size = dv.getUint32(8, true);
  if (size > bytes.length) return { ok: false, error: fail(ERROR.TRUNCATED, `${bytes.length} von ${size} Bytes`) };
  const block = bytes.slice(0, size);
  const checked = checkBlock(block, "Plugin");
  if (!checked.ok) return checked;
  let source = null;
  let description = null;
  let at = size;
  while (bytes.length >= at + SOURCE_TRAILER.headerSize) {
    const magic = dv.getUint32(at, true);
    const length = dv.getUint32(at + 4, true);
    const end = at + SOURCE_TRAILER.headerSize + length;
    if ((magic !== SOURCE_TRAILER.magic && magic !== DESC_TRAILER.magic) || end > bytes.length) break;
    let text = null;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at + SOURCE_TRAILER.headerSize, end));
    } catch {
      text = null;
    }
    if (magic === SOURCE_TRAILER.magic) source = text;
    else description = text;
    at = end;
  }
  return { ok: true, block, source, description, parts: checked.parts };
}
