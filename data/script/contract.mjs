/**
 * The script contract: the one source for everything the compiler, the
 * verifier, the JS reference VM and the future ARM VM have to agree on.
 * Nothing in here is code that runs a script; src/script/ reads this, and
 * src/script/arm-tables.mjs turns it into the tables the ARM VM is built from.
 *
 * Value model: every value is a signed 32-bit integer. A string is the index
 * of a 32-byte slot in the blob's string table (31 characters plus NUL), so
 * the VM never copies, concatenates or measures text.
 *
 * Change rules: ids and numbers below are never reused or renumbered. New
 * opcodes, events, errors and API entries are added at the end of their
 * list, and a new API entry raises API_VERSION (its `since`). FORMAT_VERSION
 * changes only when the blob layout or an opcode's meaning changes; a VM
 * accepts exactly its own FORMAT_VERSION and any blob whose apiVersion is not
 * newer than its own API_VERSION. A new value at the end of an event's list
 * (EVENT_ARG_SINCE) raises it the same way. test/script-contract.test.mjs pins
 * the numbers.
 *
 * Format 2 is the only format. Against the never-shipped format 1 it widens
 * variable and array operands to 16 bits and moves the variable count to a
 * 32-bit header field.
 */

export const FORMAT_VERSION = 2;
export const API_VERSION = 8;

/** "GSCR" in the first four bytes of every blob. */
export const MAGIC = 0x52435347;

export const LIMITS = Object.freeze({
  stack: 32,
  callDepth: 8,
  vars: 65536,
  arrayLength: 65535,
  consts: 256,
  strings: 64,
  stringLength: 31,
  stringSlot: 32,
  code: 16384,
  nameLength: 15,
  apiArgs: 4,
  sourceLines: 65535,
  fuel: 20000,
  timeCheckEvery: 256,
});

/** The shared arena holds blobs, variables and script entries. Scratch and the event ring are separate. */
const SCRIPT_POOL_BYTES = 128 * 1024;
export const BUDGET = Object.freeze({ frameMs: 5, handlerWarnMs: 0.5, ring: 64, scriptBytes: SCRIPT_POOL_BYTES, variableSlots: SCRIPT_POOL_BYTES / 4 });
/** Timer3 counts at 150 MHz and the firmware runs it with a period of one second (PRD 0x8F0D17F), so it wraps there, not at 2^32. */
export const TIMER3 = Object.freeze({ address: 0x01F0D010, hz: 150000000, period: 150000000 });

/**
 * Blob header, little endian, 52 bytes. Sections follow in this order:
 * handlers (4 bytes each), consts (4 bytes each), strings (32 bytes each),
 * code (padded to a multiple of 4), lines (4 bytes each).
 * totalSize counts all of it; the checksum is CRC-32 (IEEE) over the bytes
 * from offset 16 to totalSize.
 */
export const HEADER = Object.freeze({
  size: 52,
  checksumFrom: 16,
  fields: Object.freeze([
    { name: "magic", offset: 0, type: "u32" },
    { name: "formatVersion", offset: 4, type: "u16" },
    { name: "apiVersion", offset: 6, type: "u16" },
    { name: "totalSize", offset: 8, type: "u32" },
    { name: "checksum", offset: 12, type: "u32" },
    { name: "varCount", offset: 16, type: "u32" },
    { name: "entry", offset: 20, type: "u16" },
    { name: "codeSize", offset: 22, type: "u16" },
    { name: "stackMax", offset: 24, type: "u16" },
    { name: "handlerCount", offset: 26, type: "u16" },
    { name: "constCount", offset: 28, type: "u16" },
    { name: "stringCount", offset: 30, type: "u16" },
    { name: "lineCount", offset: 32, type: "u16" },
    { name: "flags", offset: 34, type: "u16" },
    { name: "name", offset: 36, type: "char16" },
  ]),
});

/**
 * Bits of the header's `flags`. PROBED: the editor probed this block and let it out. DATA: a data section follows the
 * lines, up to totalSize: records of { base u16, count u16, count bytes, zeros up to a multiple of 4 }, each a run of
 * array slots the loader sets to those bytes (0 to 255) after it cleared the variables; count is at least 1 and the run
 * lies inside the variables. Any other bit is refused.
 */
export const BLOCK_FLAGS = Object.freeze({ PROBED: 1, DATA: 2, KNOWN: 3 });

/** Section entry sizes in bytes. A handler entry is { event u8, argc u8, entry u16 }; a line entry { offset u16, line u16 }. */
export const SECTION = Object.freeze({ handler: 4, constant: 4, string: 32, line: 4, dataRecord: 4 });

const byte = (name, as = "byte") => ({ name, size: 1, as });
const half = (name, as) => ({ name, size: 2, as });
const word = (name, as = "target") => ({ name, size: 2, as });

const OP_LIST = [
  // name, number, operands, pop, push, cost, flow
  ["HALT", 0, [], 0, 0, 1, "end"],
  ["PUSHB", 1, [byte("value")], 0, 1, 1],
  ["PUSHK", 2, [byte("index", "const")], 0, 1, 1],
  ["PUSHS", 3, [byte("index", "string")], 0, 1, 1],
  ["LOAD", 4, [half("slot", "var")], 0, 1, 1],
  ["STORE", 5, [half("slot", "var")], 1, 0, 1],
  ["ALOAD", 6, [half("base", "arrayBase"), half("length", "arrayLength")], 1, 1, 2],
  ["ASTORE", 7, [half("base", "arrayBase"), half("length", "arrayLength")], 2, 0, 2],
  ["DUP", 8, [], 1, 2, 1],
  ["DROP", 9, [], 1, 0, 1],
  ["ADD", 10, [], 2, 1, 1],
  ["SUB", 11, [], 2, 1, 1],
  ["MUL", 12, [], 2, 1, 2],
  ["DIV", 13, [], 2, 1, 8],
  ["MOD", 14, [], 2, 1, 8],
  ["AND", 15, [], 2, 1, 1],
  ["OR", 16, [], 2, 1, 1],
  ["XOR", 17, [], 2, 1, 1],
  ["SHL", 18, [], 2, 1, 1],
  ["SHR", 19, [], 2, 1, 1],
  ["NEG", 20, [], 1, 1, 1],
  ["NOT", 21, [], 1, 1, 1],
  ["EQ", 22, [], 2, 1, 1],
  ["NE", 23, [], 2, 1, 1],
  ["LT", 24, [], 2, 1, 1],
  ["LE", 25, [], 2, 1, 1],
  ["GT", 26, [], 2, 1, 1],
  ["GE", 27, [], 2, 1, 1],
  ["JMP", 28, [word("target")], 0, 0, 1, "jump"],
  ["JZ", 29, [word("target")], 1, 0, 1, "branch"],
  ["JNZ", 30, [word("target")], 1, 0, 1, "branch"],
  ["CALL", 31, [word("target"), byte("argc", "argc")], "argc", 1, 3, "call"],
  ["RET", 32, [], 1, 0, 2, "end"],
  ["CALLAPI", 33, [byte("id", "api"), byte("argc", "argc")], "argc", 1, 4],
];

/**
 * Opcode table. `pop` is a count or "argc" (taken from the operand of that
 * name), `push` a count. `cost` is in fuel units, an estimate until the VM
 * runs on the device (plan, phase 1.4); CALLAPI adds the API entry's cost.
 * The unit costs below are unchanged by the 16-bit variable operands; what
 * they cost the ARM interpreter is in docs/plugins.md ("Kosten von Format 2").
 * `flow`: next, jump, branch (jump or fall through), call (returns to the
 * next instruction), end (no successor). An operand's `as` says what it
 * indexes: byte (a plain unsigned value), const, string, var, arrayBase and
 * arrayLength (a slot range in the variable area; 16 bits each, so a variable
 * area holds up to 65536 slots and an array up to 65535), target (a code offset), argc, api (an API id). RET hands the value
 * on top to the caller, which sees it as the push of its CALL; with no
 * caller it ends the run, like HALT.
 */
export const OPCODES = Object.freeze(OP_LIST.map(([name, code, operands, pop, push, cost, flow = "next"]) =>
  Object.freeze({ name, code, operands: Object.freeze(operands), size: 1 + operands.reduce((n, o) => n + o.size, 0), pop, push, cost, flow })));

export const OP = Object.freeze(Object.fromEntries(OPCODES.map(o => [o.name, o.code])));
export const OPCODE_COUNT = OPCODES.length;
/** Opcode numbers are a dense 0 to OPCODE_COUNT - 1; everything above is invalid. */
export const OPCODE_BY_CODE = Object.freeze(OPCODES.slice());
export const OPCODE_BY_NAME = new Map(OPCODES.map(o => [o.name, o]));

const EVENT_LIST = [
  // name, args
  ["start", []],
  ["ready", []],
  ["frame", []],
  ["buttonPress", ["key"]],
  ["buttonRelease", ["key"]],
  ["knob", ["index", "value"]],
  ["encoder", ["index", "delta"]],
  ["pad", ["index", "down", "velocity"]],
  ["touch", ["x", "y", "first"]],
  ["step", ["step"]],
  ["beat", []],
  ["play", []],
  ["stop", []],
  ["rec", []],
  ["patternChange", ["index"]],
  ["partChange", ["part"]],
  ["mute", ["part", "muted"]],
  ["tempo", ["tenthsBpm"]],
  ["save", []],
  ["menu", ["id", "value"]],
  ["open", []],
  ["close", []],
];

/**
 * The API version in which an event value was added at the end of the event's list, for the values newer than the
 * event itself. A handler that takes such a value needs a block of at least that version; the compiler sets it.
 */
export const EVENT_ARG_SINCE = Object.freeze({ touch: Object.freeze({ first: 6 }) });

/**
 * Events. `start` is the script body itself (top-level statements), not a
 * handler. `ready`, `frame` and the queued events run in the UiTask in the
 * frame hook; `save` runs in the CommandTask.
 */
export const EVENTS = Object.freeze(EVENT_LIST.map(([name, args], id) =>
  Object.freeze({ id, name, args: Object.freeze(args), argc: args.length })));
export const EVENT_BY_NAME = new Map(EVENTS.map(e => [e.name, e]));
export const EVENT_BY_ID = new Map(EVENTS.map(e => [e.id, e]));
/**
 * The events of an app (korg.app): `open` when the user opens it from the BLECH menu, `close` when it ends. They go to that
 * one script only, are no input and nothing outside the runtime posts them.
 */
export const APP_EVENTS = Object.freeze(["open", "close"]);
/** Events a script may post from outside the VM: everything the frame hook feeds from the ring, except the app events. */
export const QUEUED_EVENTS = Object.freeze(EVENTS.filter(e => e.id >= 3 && !APP_EVENTS.includes(e.name)).map(e => e.name));

/** Word-aligned per-script metadata; maxima arrays have one word per event. */
/** Persistent values of one script: 16 integer slots and a mask of the slots that hold a saved value. */
export const STORE = Object.freeze({
  slots: 16,
  nameBytes: 16,
  recordSize: 84,
  headerSize: 16,
  magic: 0x54535347,
  version: 1,
  files: Object.freeze(["store.a.bin", "store.b.bin"]),
  minPauseFrames: 50,
  fields: Object.freeze([
    { name: "magic", offset: 0, type: "u32" },
    { name: "version", offset: 4, type: "u16" },
    { name: "count", offset: 6, type: "u16" },
    { name: "generation", offset: 8, type: "u32" },
    { name: "checksum", offset: 12, type: "u32" },
  ]),
});

export const SCRIPT_ENTRY = Object.freeze({
  size: 48 + EVENTS.length * 8 + 4 + STORE.slots * 4,
  fields: Object.freeze([
    ["next", 0], ["blob", 4], ["vars", 8], ["state", 12], ["fault", 16], ["offset", 20],
    ["line", 24], ["event", 28], ["ops", 32], ["cost", 36], ["maxTicks", 40], ["maxCost", 44], ["maxEventTicks", 44 + EVENTS.length * 4], ["readySent", 44 + EVENTS.length * 8],
    ["storeMask", 48 + EVENTS.length * 8], ["store", 52 + EVENTS.length * 8],
  ].map(([name, offset]) => Object.freeze({ name, offset, words: name === "maxCost" || name === "maxEventTicks" ? EVENTS.length : name === "store" ? STORE.slots : 1 }))),
});
export const SCRIPT_STATE = Object.freeze({ LOADED: 1, ARMED: 2, DISABLED: 3 });

export const SCRIPT_CONTROL = Object.freeze({
  headerSize: 256,
  fields: Object.freeze([
    ["armed", 96], ["ready", 100], ["ringHead", 104], ["ringTail", 108],
    ["frameStart", 112], ["frameActive", 116], ["cursorEntry", 120], ["cursorEvent", 124],
    ["cursorArgs", 128, 3], ["cursorRingEnd", 140], ["cursorPhase", 144], ["captureMask", 148],
    ["frames", 152], ["paused", 156], ["ledSent", 160],
    ["cardStatus", 164], ["cardLoaded", 168], ["cardRejected", 172], ["cardFirstError", 176],
    ["displayActive", 180], ["storePending", 184], ["storeFrame", 188], ["storeGeneration", 192], ["storeBytes", 196],
    ["storeErrors", 200], ["storeWrites", 204],
    ["clockInit", 208], ["clockLast", 212], ["clockRem", 216], ["clockMs", 220],
    ["seqInit", 224], ["seqTransport", 228], ["seqTempo", 232], ["seqPattern", 236], ["seqPart", 240], ["seqStep", 244], ["seqMutes", 248],
    ["ledHold", 252],
  ].map(([name, offset, words = 1]) => Object.freeze({ name, offset, words }))),
});
export const SCRIPT_PHASE = Object.freeze({ READY: 0, QUEUED: 1, FRAME: 2, IDLE: 3 });
export const SCRIPT_EVENT_RECORD = Object.freeze({
  size: 16,
  fields: Object.freeze([
    Object.freeze({ name: "event", offset: 0, words: 1 }),
    Object.freeze({ name: "args", offset: 4, words: 3 }),
  ]),
});

const eventMask = names => names.reduce((m, n) => m | (1 << EVENT_BY_NAME.get(n).id), 0) >>> 0;
const ALL = EVENTS.map(e => e.name);
const UI = EVENTS.filter(e => e.name !== "start" && e.name !== "save").map(e => e.name);
const MENU_ADD = ["start", "ready"];
const APP_ONLY = ["start"];

const int = (name, min = -2147483648, max = 2147483647) => ({ name, kind: "int", min, max });
const str = name => ({ name, kind: "str" });
/** A global array, handed over as one value that holds its first slot (16 bits) and its length (16 bits, above). `strip` names the argument that cuts it into strips. */
const arr = (name, strip) => ({ name, kind: "arr", strip });

/** Fuel units for each slot of a bitmap's array, on top of the call's cost of 14: the ARM routine takes 63 instructions for the call, at most 28 for a lit slot and about 20 more for each band of a picture one slot wide, at 10 instructions to a unit (tools/patch/test_script_display.py counts them against these numbers). */
const BITMAP_ITEM_COST = 3;

const API_LIST = [
  // id, name, args, returns, events, cost (one byte), since, perItem. Display costs follow the native instruction counts in
  // Unicorn at 10 instructions to a unit, for a short call, capped at 250; the 5 ms frame budget limits real time.
  [1, "korg.led", [int("index", 0, 87), int("level", 0, 255)], "void", UI, 6, 1],
  [2, "korg.millis", [], "int", ALL, 3, 1],
  [16, "korg.display.clear", [], "void", UI, 80, 1],
  [17, "korg.display.text", [str("text"), int("x", 0, 127), int("y", 0, 63)], "void", UI, 250, 1],
  [18, "korg.display.number", [int("value"), int("x", 0, 127), int("y", 0, 63)], "void", UI, 250, 1],
  [19, "korg.display.pixel", [int("x", 0, 127), int("y", 0, 63), int("on", 0, 1)], "void", UI, 4, 1],
  [20, "korg.display.rect", [int("x", 0, 127), int("y", 0, 63), int("width", 1, 128), int("height", 1, 64)], "void", UI, 40, 1],
  [21, "korg.display.clearRect", [int("x", 0, 127), int("y", 0, 63), int("width", 1, 128), int("height", 1, 64)], "void", UI, 40, 1],
  [22, "korg.display.take", [], "int", UI, 80, 5],
  [23, "korg.display.release", [], "void", UI, 4, 5],
  [24, "korg.display.bitmap", [arr("array", "width"), int("x", -128, 127), int("y", -64, 63), int("width", 1, 128)], "void", UI, 14, 6, BITMAP_ITEM_COST],
  [25, "korg.display.textNumber", [str("text"), int("value"), int("x", 0, 127), int("y", 0, 63)], "void", UI, 250, 6],
  [32, "korg.store.get", [int("slot", 0, 15), int("fallback")], "int", ALL, 4, 2],
  [33, "korg.store.set", [int("slot", 0, 15), int("value")], "void", ALL, 4, 2],
  [34, "korg.store.save", [], "void", UI, 20, 2],
  [35, "korg.read.transport", [], "int", ALL, 4, 3],
  [36, "korg.read.tempo", [], "int", ALL, 4, 3],
  [37, "korg.read.pattern", [], "int", ALL, 4, 3],
  [38, "korg.read.part", [], "int", ALL, 4, 3],
  [39, "korg.read.step", [int("part", 0, 15)], "int", ALL, 4, 3],
  [40, "korg.read.mute", [int("part", 0, 15)], "int", ALL, 4, 3],
  [41, "korg.read.knob", [int("index", 0, 19)], "int", ALL, 4, 3],
  [42, "korg.read.chainMode", [], "int", ALL, 4, 8],
  [43, "korg.read.patternValue", [int("pattern", -1, 249), int("part", -1, 15), int("field", 0, 31)], "int", ALL, 6, 8],
  [44, "korg.remapKey", [int("from", 0, 33), int("to", 0, 33)], "void", MENU_ADD, 20, 8],
  [48, "korg.play", [], "void", UI, 30, 3],
  [49, "korg.stop", [], "void", UI, 30, 3],
  [50, "korg.pattern", [int("index", 0, 249)], "void", UI, 30, 3],
  [51, "korg.tempo", [int("tenthsBpm", 100, 3000)], "void", UI, 30, 3],
  [52, "korg.part", [int("part", 0, 15)], "void", UI, 30, 3],
  [53, "korg.mute", [int("part", 0, 15), int("muted", 0, 1)], "void", UI, 30, 3],
  [56, "korg.backlight", [int("red", 0, 1), int("green", 0, 1), int("blue", 0, 1)], "void", UI, 20, 3],
  [57, "korg.ledHold", [int("on", 0, 1)], "void", UI, 100, 3],
  [58, "korg.menu.add", [str("label"), int("min", -1000000, 1000000), int("max", -1000000, 1000000), int("value", -1000000, 1000000)], "int", MENU_ADD, 60, 4],
  [59, "korg.app", [str("name"), str("group")], "int", APP_ONLY, 60, 5],
  [60, "korg.file.frame", [arr("array"), int("file", 0, 99), int("index", 0, 65535)], "int", UI, 250, 7],
];

/**
 * API table. Ids are stable and may have gaps (ids 32 and up are reserved for
 * store, menu and sequencer reads in later phases). `events` is the list of
 * events whose handlers, and the functions they call, may use the entry.
 * `cost` is added to the fuel on every call, and `perItem` more for each slot of an array argument.
 * Int arguments are range-checked by the VM from min and max, so a host function only sees valid values;
 * a text argument reaches the host as the string, not the index; an array argument reaches it as the
 * slots themselves, after the VM has checked that they lie inside the variable area. The compiler passes
 * only a global array there: it pushes the one value ARRAY_HANDLE builds from the array's first slot and its length.
 */
export const API = Object.freeze(API_LIST.map(([id, name, args, returns, events, cost, since, perItem = 0]) =>
  Object.freeze({ id, name, args: Object.freeze(args), returns, events: Object.freeze(events), eventMask: eventMask(events), cost, since, perItem })));
/**
 * The value an array argument is passed as: the array's first variable slot in the low 16 bits and its length in the
 * high 16. It is a plain 32-bit integer on the stack, so a blob can forge one; the VM checks it every call.
 */
export const ARRAY_HANDLE = Object.freeze({
  make: (base, length) => ((length << 16) | base) | 0,
  base: handle => handle & 0xFFFF,
  length: handle => handle >>> 16,
});

export const API_BY_ID = new Map(API.map(a => [a.id, a]));
export const API_BY_NAME = new Map(API.map(a => [a.name, a]));

const LED_API = API_BY_NAME.get("korg.led");
const LED_COUNT = LED_API.args[0].max + 1;
export const SCRIPT_LED = Object.freeze({
  count: LED_COUNT,
  levelMax: LED_API.args[1].max,
  packetBytes: 5,
  perFrame: 16,
  reserveBytes: 256,
  size: LED_COUNT * 4 + 4,
  fields: Object.freeze([
    ["desired", 0, LED_COUNT], ["delivered", LED_COUNT, LED_COUNT],
    ["pending", LED_COUNT * 2, LED_COUNT], ["valid", LED_COUNT * 3, LED_COUNT],
    ["nextIndex", LED_COUNT * 4, 4],
  ].map(([name, offset, bytes]) => Object.freeze({ name, offset, bytes }))),
});
export const SCRIPT_LED_VALID = Object.freeze({ DESIRED: 1, DELIVERED: 2 });

/**
 * The script display: a 1024 byte copy in the runtime that korg.display.*
 * draws into (8 pages of 128 columns, bit 0 the top row). While a script has
 * drawn and the firmware shows its main screen, the frame hook copies it over
 * the firmware's display RAM after the firmware has drawn its widgets.
 */
/**
 * The values of a pattern that korg.read.patternValue(pattern, part, field) reads, and the properties korg.current.*,
 * korg.patterns[i].* and korg.parts[i].* stand for. `field` is the index in the list: PATTERN_FIELDS with part -1,
 * PART_FIELDS with part 0 to 15. Offsets are those of data/map/pattern.mjs, a part's from 0x800 + part * 0x330. The kind
 * says how the bytes become the value: u8, s8 (signed), u16 (little endian), bars (the length byte 0 to 3 as 1 to 4),
 * chain (Chain To counted from 1 as 0 to 249, -1 for none), atLeast1 (Chain Repeat, the device shows 0 as 1).
 * Field indices are never reused or renumbered; new fields go at the end.
 */
export const PATTERN_FIELD_KINDS = Object.freeze(["u8", "s8", "u16", "bars", "chain", "atLeast1"]);
const field = (name, offset, kind, text) => Object.freeze({ name, offset, kind, text });
export const PATTERN_FIELDS = Object.freeze([
  field("tempo", 34, "u16", "Tempo in Zehntel BPM, 1280 ist 128,0."),
  field("swing", 36, "s8", "Swing, -48 bis 48."),
  field("length", 37, "bars", "Länge in Takten, 1 bis 4."),
  field("beat", 38, "u8", "Beat: 0 16tel, 1 32tel, 2 8tel-Triolen, 3 16tel-Triolen."),
  field("key", 39, "u8", "Tonart, 0 C bis 11 H."),
  field("scale", 40, "u8", "Tonleiter, 0 bis 34 in der Reihenfolge des Pattern-Menüs."),
  field("chordSet", 41, "u8", "Chord Set, 0 bis 4."),
  field("level", 42, "u8", "Lautstärke des Patterns, 0 bis 127."),
  field("mfxType", 61, "u8", "Master-Effekt, sein Platz im Master-Menü."),
  field("chainTo", 15104, "chain", "Chain To: das nächste Pattern, 0 bis 249, -1 ohne Kette."),
  field("chainRepeat", 15106, "atLeast1", "Chain Repeat: wie oft das Pattern spielt, bevor die Kette weitergeht, mindestens 1."),
]);
export const PART_FIELDS = Object.freeze([
  field("sample", 8, "u16", "Sample, die Slot-Nummer."),
  field("filterType", 12, "u8", "Filtertyp, 0 bis 16."),
  field("cutoff", 13, "u8", "Cutoff, 0 bis 127."),
  field("resonance", 14, "u8", "Resonanz, 0 bis 127."),
  field("egInt", 15, "s8", "Filter EG Int, -63 bis 63."),
  field("modType", 16, "u8", "Modulation, ihr Platz in der Liste."),
  field("modSpeed", 17, "u8", "Mod Speed, 0 bis 127."),
  field("modDepth", 18, "u8", "Mod Depth, 0 bis 127."),
  field("attack", 20, "u8", "Attack, 0 bis 127."),
  field("decay", 21, "u8", "Decay/Release, 0 bis 127."),
  field("level", 24, "u8", "Amp Level, 0 bis 127."),
  field("pan", 25, "s8", "Panorama, -63 links bis 63 rechts."),
  field("ifxOn", 32, "u8", "1, wenn der Insert-Effekt an ist."),
  field("ifxType", 33, "u8", "Insert-Effekt, sein Platz im Insert-Menü."),
  field("ifxEdit", 34, "u8", "IFX Edit, 0 bis 127."),
  field("pitch", 36, "s8", "Osc Pitch, -63 bis 63."),
  field("glide", 37, "u8", "Glide, 0 bis 127."),
  field("voiceAssign", 2, "u8", "Voice Assign, 0 bis 3."),
  field("oscEdit", 11, "u8", "Osc Edit, 0 bis 127."),
  field("mfxSend", 27, "u8", "1, wenn der Part an den Master-Effekt geht."),
]);
/** Where a part starts in a pattern block, and the distance from one part to the next. */
export const PATTERN_PARTS = Object.freeze({ base: 0x800, stride: 0x330, bytes: 0x4000 });

/** Knob values the input filter keeps for korg.read.knob: one word per knob, raw panel value. */
export const SCRIPT_KNOBS = 20;

/**
 * Apps (korg.app): a script that has its own screen. The runtime keeps a small table after its other areas: the open app
 * (its script entry, 0 when none), the count and one record per app (script entry, pointer to its name text in the block,
 * group). Only the open app draws on the display and gets `frame`; the BLECH menu lists the apps by group.
 * A plugin that is no app can take the display with korg.display.take() while the main screen shows; EXIT ends that the
 * same way it closes an app. Whoever owns the display is the one entry in this table's `open` word.
 * One record of the table is the firmware's own app, Blechy, built into BLECH: it is always record 0, in the group
 * BUILTIN, which no menu lists. `max` is what plugins can declare, `slots` what the table holds.
 */
export const SCRIPT_APPS = Object.freeze({
  max: 12,
  builtin: 1,
  slots: 12 + 1,
  groups: Object.freeze(["GAMES", "TOOLS"]),
  builtinGroup: 2,
  nameLength: 15,
  recordSize: 12,
  /** Frames after an open in which the firmware may still be on its way to the main screen (its screen switch is a queued message). */
  openGrace: 3,
  stateSize: 8 + 13 * 12 + 4,
  fields: Object.freeze([["open", 0], ["count", 4], ["table", 8], ["grace", 8 + 13 * 12]].map(([name, offset]) => Object.freeze({ name, offset }))),
  recordFields: Object.freeze([["entry", 0], ["name", 4], ["group", 8]].map(([name, offset]) => Object.freeze({ name, offset }))),
});

export const SCRIPT_DISPLAY = Object.freeze({ width: 128, height: 64, bytes: 1024, ram: 0xC031B310 });

/**
 * A picture file for korg.file.frame on the card, `SD:KORG/blechtribe/Gif/GIFnn.E2G` (nn the file number, two digits), little
 * endian: "GGIF", version (u16), frame count (u16), then each frame as its delay in milliseconds (u16), two zero bytes and the
 * 1024 bytes of a whole display in the layout of its memory (src/script/gif.mjs packs and reads it).
 */
export const SCRIPT_GIF = Object.freeze({ magic: 0x46494747, version: 1, header: 8, frameHeader: 4, frameBytes: 1024, maxFile: 99,
  folder: "KORG/blechtribe/Gif/" });

/*
 * korg.display.bitmap(array, x, y, width): the picture is laid out like the display's own memory. One slot holds the 8
 * pixels of one column in one band, bit 0 the top pixel (only the lowest 8 bits count); a band is `width` slots, columns
 * left to right, and the bands follow each other from the top. The height is 8 times the number of whole bands the array
 * holds (its length divided by `width`); slots after the last whole band are not read. Only lit pixels are drawn, nothing is
 * erased, and what lies beyond an edge is cut off.
 */

/**
 * The collection file `e2sPlugin.all` on the card, little endian: a 16 byte
 * header, then script blocks (format 2, each carrying its own size and CRC)
 * one after the other; a block's size is a multiple of 4 by construction, so
 * nothing is padded. The checksum is CRC-32
 * (IEEE) over everything from offset 16 to totalSize. The loader reads one
 * block at a time into a buffer of `maxBlock` bytes, so no block may be larger.
 */
export const ARCHIVE = Object.freeze({
  magic: 0x4C415347,
  version: 1,
  headerSize: 16,
  checksumFrom: 16,
  maxBlock: 32752,
  folder: "KORG/blechtribe/Plugin",
  file: "e2sPlugin.all",
  fields: Object.freeze([
    { name: "magic", offset: 0, type: "u32" },
    { name: "version", offset: 4, type: "u16" },
    { name: "count", offset: 6, type: "u16" },
    { name: "totalSize", offset: 8, type: "u32" },
    { name: "checksum", offset: 12, type: "u32" },
  ]),
});

/**
 * A `.blech` file is one block followed by an optional source trailer: the
 * tag "GSRC", the source length as u32 and the UTF-8 source. The device
 * reads the block only; the editor reads the trailer to reopen the script.
 */
export const SOURCE_TRAILER = Object.freeze({ magic: 0x43525347, headerSize: 8, extension: ".blech" });

/** "GDSC", u32 length, ASCII lines of `width` characters at most, each ending in "\n"; behind the block, in front of the source. */
export const DESC_TRAILER = Object.freeze({ magic: 0x43534447, headerSize: 8, width: 20, maxBytes: 2047 });

/** What the boot loader leaves in the control block as `cardStatus`; the words stay 0xFFFFFFFF until it has run. */
export const CARD_STATUS = Object.freeze({
  LOADED: 1, NO_FILE: 2, BAD_HEADER: 3, BAD_CHECKSUM: 4, READ_ERROR: 5, BLOCK_SIZE: 6, KILL_SWITCH: 7, NO_PANEL: 8, SETTINGS_OFF: 9,
});

const ERROR_LIST = [
  // code, name, phase (load, run or both), message
  [0, "OK", "both", "kein Fehler"],
  [1, "FUEL", "run", "Rechenbudget aufgebraucht (Endlosschleife?)"],
  [2, "BAD_OPCODE", "both", "ungültiger Befehl"],
  [3, "BOUNDS", "run", "Feldindex außerhalb des Feldes"],
  [4, "DIV_ZERO", "run", "Division durch null"],
  [5, "STACK", "both", "Stapel läuft über oder unter"],
  [6, "BAD_JUMP", "both", "Sprungziel ungültig"],
  [7, "TIME", "run", "Zeitbudget überschritten"],
  [8, "CALL_DEPTH", "both", "Aufrufe zu tief verschachtelt"],
  [9, "BAD_CONST", "both", "Konstante außerhalb der Tabelle"],
  [10, "BAD_STRING", "both", "Text außerhalb der Tabelle oder fehlerhaft"],
  [11, "BAD_VAR", "both", "Variable außerhalb des Variablenfelds"],
  [12, "API_UNKNOWN", "both", "unbekannte Funktion"],
  [13, "API_ARGC", "both", "falsche Argumentzahl"],
  [14, "API_EVENT", "both", "Funktion in diesem Ereignis nicht erlaubt"],
  [15, "API_ARG", "run", "Argument außerhalb des erlaubten Bereichs"],
  [16, "TRUNCATED", "both", "Block abgeschnitten"],
  [17, "MAGIC", "load", "keine Plugin-Kennung"],
  [18, "FORMAT_VERSION", "load", "Formatversion nicht unterstützt"],
  [19, "API_VERSION", "both", "Funktionstabelle zu neu für diese Firmware"],
  [20, "CHECKSUM", "load", "Prüfsumme falsch"],
  [21, "LIMITS", "load", "Größen über den Grenzen"],
  [22, "STACK_MISMATCH", "load", "Stapelhöhe passt nicht"],
  [23, "BAD_HANDLER", "load", "Ereignistabelle fehlerhaft"],
  [24, "BAD_LINES", "load", "Zeilentabelle fehlerhaft"],
  [25, "RECURSION", "load", "Rekursion ist nicht erlaubt"],
  [26, "BAD_SIZE", "load", "Größenangaben im Block passen nicht zusammen"],
  [27, "VARS_BUDGET", "load", "Variablenbudget aller Plugins reicht nicht"],
  [28, "POOL_BUDGET", "load", "Plugin-Budget aller Plugins reicht nicht"],
];

export const ERRORS = Object.freeze(ERROR_LIST.map(([code, name, phase, message]) => Object.freeze({ code, name, phase, message })));
export const ERROR = Object.freeze(Object.fromEntries(ERRORS.map(e => [e.name, e.code])));
export const ERROR_BY_CODE = new Map(ERRORS.map(e => [e.code, e]));
