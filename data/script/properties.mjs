/**
 * The Electribe as objects: `korg.tempo`, `korg.parts[3].muted`, `korg.knobs.LEVEL`, `korg.store[2]`. The compiler
 * turns reading a property into a call of its `read` entry of the API table and setting it into a call of its `write`
 * entry, so the block format stays as it is. The arguments: "index" is the bracket, "value" the assigned value.
 */
import { KNOBS } from "../panel.mjs";
import { PATTERN_FIELDS, PART_FIELDS } from "./contract.mjs";

const knobName = id => id.replace(/([a-z])([A-Z0-9])/g, "$1_$2").toUpperCase();

/** `korg.knobs.LEVEL`: the knob names, from the panel table, as the index the knob event and korg.read.knob use. */
export const KNOB_NAMES = Object.freeze(KNOBS.map(k => Object.freeze({ name: knobName(k.id), value: k.index, label: k.label })));

const p = (path, read, write, text) => Object.freeze({ path, read, write, text });

export const PROPERTIES = Object.freeze([
  p("korg.tempo", ["korg.read.tempo", []], ["korg.tempo", ["value"]], "Tempo in Zehntel BPM, 1280 ist 128,0. Setzen wechselt das Tempo (100 bis 3000)."),
  p("korg.transport", ["korg.read.transport", []], null, "0 Stop, 1 Play, 2 Pause, 3 REC bereit, 4 Aufnahme. Starten und Anhalten mit korg.play() und korg.stop()."),
  p("korg.selectedPattern", ["korg.read.pattern", []], ["korg.pattern", ["value"]], "Das gewählte Pattern, 0 bis 249. Setzen wählt ein anderes."),
  p("korg.selectedPart", ["korg.read.part", []], ["korg.part", ["value"]], "Der gewählte Part, 0 bis 15, 16 heißt alle. Setzen wählt einen Part (0 bis 15)."),
  p("korg.millis", ["korg.millis", []], null, "Millisekunden seit dem ersten Aufruf."),
  p("korg.parts[].step", ["korg.read.step", ["index"]], null, "Der Schrittzähler des Parts, 0 bis 63."),
  p("korg.parts[].muted", ["korg.read.mute", ["index"]], ["korg.mute", ["index", "value"]], "1, wenn der Part stumm ist. Setzen schaltet ihn stumm (1) oder wieder an (0)."),
  p("korg.knobs[]", ["korg.read.knob", ["index"]], null, "Der letzte Wert des Reglers, bis er bewegt wurde 0. Der Regler mit Namen: korg.knobs.LEVEL."),
  p("korg.store[]", ["korg.store.get", ["index", 0]], ["korg.store.set", ["index", "value"]], "Der gespeicherte Wert des Platzes 0 bis 15, 0 wenn dort noch nichts steht. Auf die Karte kommt er mit korg.store.save()."),
  p("korg.leds[]", null, ["korg.led", ["index", "value"]], "Helligkeit einer LED setzen, 0 bis 255. Mit Namen: korg.led.TAP = 255;"),
  p("korg.chainMode", ["korg.read.chainMode", []], null, "1, wenn CHAIN MODE im Global-Menü an ist; nur dann kettet die Firmware Patterns weiter."),
  ...PATTERN_FIELDS.map((f, i) => p(`korg.current.${f.name}`, ["korg.read.patternValue", [-1, -1, i]], null, `Das Pattern, das gerade läuft, mit ungespeicherten Änderungen. ${f.text}`)),
  ...PATTERN_FIELDS.map((f, i) => p(`korg.patterns[].${f.name}`, ["korg.read.patternValue", ["index", -1, i]], null, `Das Pattern 0 bis 249, so wie es gespeichert ist. ${f.text}`)),
  ...PART_FIELDS.map((f, i) => p(`korg.parts[].${f.name}`, ["korg.read.patternValue", [-1, "index", i]], null, `Der Part 0 bis 15 im Pattern, das gerade läuft. ${f.text}`)),
]);

export const PROPERTY_BY_PATH = new Map(PROPERTIES.map(x => [x.path, x]));
