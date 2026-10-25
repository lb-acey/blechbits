/**
 * Names for key codes and LED numbers, generated from data/panel.mjs: `korg.key.TAP`,
 * `korg.led.TAP`, `korg.led.PAD_1_RED`. The compiler replaces a name by its number.
 * A name is the control's id in UPPER_SNAKE; the arrow keys partDec and partInc are
 * PART_LEFT and PART_RIGHT, encoders take their printed label, a second LED adds a
 * colour (`PLAY_BLUE`).
 */
import { BUTTONS, TOUCH_BUTTON, ENCODERS, PADS } from "../panel.mjs";
import { API_BY_NAME } from "./contract.mjs";

const RENAME = { partDec: "PART_LEFT", partInc: "PART_RIGHT" };

const fromId = id => RENAME[id] ?? id.replace(/([a-z])([A-Z0-9])/g, "$1_$2").toUpperCase();
const fromLabel = label => label.replace(/[^A-Za-z0-9]+/g, " ").trim().replace(/ /g, "_").toUpperCase();
/** The label as it reads in a list: a bare digit is a button called 1 to 4, not a number. */
const labelOf = b => (/^\d$/.test(b.label) ? `Taste ${b.label}` : b.label);

const entry = (name, value, label, group) => Object.freeze({ name, value, label, group });

/** The key codes, in the order of the panel table. The touchpad counts as a key of its own. */
export const KEY_NAMES = Object.freeze([
  ...BUTTONS.map(b => entry(fromId(b.id), b.index, labelOf(b), "Taste")),
  entry("TOUCHPAD", TOUCH_BUTTON, "Touchpad berührt", "Touchpad"),
]);

/** The LED numbers: button LEDs, the encoder LEDs, then the red and blue LED of every pad. */
export const LED_NAMES = Object.freeze([
  ...BUTTONS.flatMap(b => [
    entry(fromId(b.id), b.led, labelOf(b), "Taste"),
    ...(b.ledBlue === undefined ? [] : [entry(`${fromId(b.id)}_BLUE`, b.ledBlue, `${labelOf(b)}, blaue LED`, "Taste")]),
  ]),
  ...ENCODERS.map(e => entry(fromLabel(e.label), e.led, e.label, "Encoder")),
  ...PADS.flatMap(p => [
    entry(`PAD_${p.label}_RED`, p.ledRed, `Pad ${p.label}, rote LED`, "Pad"),
    entry(`PAD_${p.label}_BLUE`, p.ledBlue, `Pad ${p.label}, blaue LED (gewählter Part)`, "Pad"),
  ]),
]);

const ledMax = API_BY_NAME.get("korg.led").args[0].max;

for (const [kind, list] of [["korg.key", KEY_NAMES], ["korg.led", LED_NAMES]]) {
  const seen = new Set();
  for (const n of list) {
    if (seen.has(n.name)) throw new Error(`${kind}.${n.name} gibt es zweimal`);
    seen.add(n.name);
  }
}
for (const n of LED_NAMES) {
  if (!Number.isInteger(n.value) || n.value < 0 || n.value > ledMax) throw new Error(`korg.led.${n.name}: ${n.value} liegt nicht in 0 bis ${ledMax}`);
}

export const NAMES = Object.freeze({
  key: new Map(KEY_NAMES.map(n => [n.name, n])),
  led: new Map(LED_NAMES.map(n => [n.name, n])),
});

/** What a number is called, for the editor's hint: the key and the LED of that number, or undefined. */
export const keyNamed = value => KEY_NAMES.find(n => n.value === value);
export const ledNamed = value => LED_NAMES.find(n => n.value === value);
