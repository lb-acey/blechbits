/**
 * What the editor shows about names: the hint for a number under the caret and the
 * suggestions after `korg.key.` or `korg.led.`. Nothing here changes the compiled block.
 */
import { KEY_NAMES, LED_NAMES, keyNamed, ledNamed } from "../../data/script/names.mjs";

const NUMBER = /\b(?:0[xX][0-9a-fA-F]+|\d+)\b/g;
const KEY_BEFORE = /\w*key\w*\s*[!=]=*\s*$/i;
const KEY_AFTER = /^\s*[!=]=+\s*\w*key\b/i;
const LED_BEFORE = /(?:korg\.led\s*\(\s*|\w*led\w*\s*=\s*)$/i;

/** The number at `pos` in `text` with the line before it and after it, or null. */
function numberAt(text, pos) {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  const end = text.indexOf("\n", pos);
  const line = text.slice(start, end < 0 ? text.length : end);
  for (const m of line.matchAll(NUMBER)) {
    const from = m.index;
    const to = from + m[0].length;
    if (pos - start >= from && pos - start <= to) return { value: Number(m[0]), before: line.slice(0, from), after: line.slice(to) };
  }
  return null;
}

/**
 * A sentence for the number under the caret when the line says it is a key code or an LED
 * number (`key == 11`, `korg.led(20, ...)`), else an empty string.
 */
export function hintAt(text, pos) {
  const n = numberAt(text, pos);
  if (!n) return "";
  const parts = [];
  if (KEY_BEFORE.test(n.before) || KEY_AFTER.test(n.after)) {
    const k = keyNamed(n.value);
    parts.push(k ? `${n.value} ist die Taste ${k.label} (korg.key.${k.name}).` : `${n.value} ist keine Taste des Geräts.`);
  }
  if (LED_BEFORE.test(n.before)) {
    const l = ledNamed(n.value);
    parts.push(l ? `${n.value} ist die LED ${l.label} (korg.led.${l.name}).` : `${n.value} ist keine LED des Geräts.`);
  }
  return parts.join(" ");
}

/** The names that complete `korg.key.XY` or `korg.led.XY` right before `pos`: { kind, typed, names } or null. */
export function suggestAt(text, pos, limit = 8) {
  const m = /\bkorg\.(key|led)\.([A-Za-z0-9_]*)$/.exec(text.slice(Math.max(0, pos - 40), pos));
  if (!m) return null;
  const typed = m[2].toUpperCase();
  const list = m[1] === "key" ? KEY_NAMES : LED_NAMES;
  const names = list.filter(n => n.name.startsWith(typed) && n.name !== typed).slice(0, limit);
  return names.length ? { kind: m[1], typed: m[2], names } : null;
}
