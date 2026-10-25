/**
 * The controls of the device front: which number the panel sends for each
 * control, and which LED the firmware lights for it.
 *
 * Numbers measured in the emulator against the own firmware; LEDs that did not
 * change there come from Freetribe and say so.
 */
const PANEL = "measure:2026-10-08/panel-bedienung";
const FREETRIBE = "derived:freetribe-svc-panel";

const INVENTORY = "measure:2026-10-13/led-inventur";

const button = (id, label, index, led, ledSource = "measured", ledBlue = null) => ({
  id, label, index, led, source: "measured", evidence: PANEL,
  ledEvidence: ledSource === "measured" ? PANEL : FREETRIBE,
  ...(ledBlue === null ? {} : { ledBlue, ledBlueEvidence: INVENTORY }),
});

/** Buttons: `00 index 1|0`. */
export const BUTTONS = [
  button("rec", "REC", 0x00, 0x12),
  button("stop", "STOP", 0x01, 0x13, "freetribe"),
  button("play", "PLAY", 0x02, 0x09, "measured", 0x15),
  button("tap", "TAP", 0x03, 0x14, "freetribe"),
  button("gateArp", "GATE ARP", 0x04, 0x1a),
  button("touchScale", "TOUCH SCALE", 0x05, 0x1b),
  button("masterFx", "MASTER FX", 0x06, 0x1c),
  button("mfxHold", "MFX HOLD", 0x07, 0x1d),
  button("editLeft", "◄ Edit", 0x08, 0x05, "freetribe"),
  button("menu", "MENU", 0x09, 0x07, "freetribe"),
  button("shift", "SHIFT", 0x0a, 0x0a, "freetribe"),
  button("partDec", "◄ Part", 0x0b, 0x1e, "freetribe"),
  button("editRight", "Edit ►", 0x0c, 0x06, "freetribe"),
  button("exit", "EXIT", 0x0d, 0x08, "freetribe"),
  button("write", "WRITE", 0x0e, 0x0b),
  button("partInc", "Part ►", 0x0f, 0x1f, "freetribe"),
  button("partMute", "PART MUTE", 0x10, 0x20),
  button("partErase", "PART ERASE", 0x11, 0x21),
  button("lpf", "LPF", 0x12, 0x0c),
  button("trigger", "TRIGGER", 0x13, 0x22),
  button("hpf", "HPF", 0x14, 0x0d),
  button("sequencer", "SEQUENCER", 0x15, 0x23),
  button("bpf", "BPF", 0x16, 0x0e),
  button("keyboard", "KEYBOARD", 0x17, 0x24),
  button("chord", "CHORD", 0x18, 0x25),
  button("stepJump", "STEP JUMP", 0x19, 0x26),
  button("mfxSend", "MFX SEND", 0x1a, 0x0f),
  button("patternSet", "PATTERN SET", 0x1b, 0x27),
  button("bar1", "1", 0x1c, 0x28, "measured", 0x16),
  button("bar2", "2", 0x1d, 0x29, "measured", 0x17),
  button("bar3", "3", 0x1e, 0x2a, "measured", 0x18),
  button("bar4", "4", 0x1f, 0x2b, "measured", 0x19),
  button("ampEg", "AMP EG", 0x20, 0x10),
  button("ifxOn", "IFX ON", 0x21, 0x11),
];

/** Touching the touchpad is a button of its own; letting go releases the note. */
export const TOUCH_BUTTON = 0x22;

/** Endless encoders: `01 index 00 delta`. */
export const ENCODERS = [
  { id: "value", label: "VALUE / PATTERN", index: 0, led: 0x00, source: "measured", evidence: PANEL },
  { id: "osc", label: "SAMPLE / OSC", index: 1, led: 0x01, source: "measured", evidence: PANEL },
  { id: "cutoff", label: "CUTOFF", index: 2, led: 0x02, source: "measured", evidence: PANEL },
  { id: "modType", label: "MOD. TYPE", index: 3, led: 0x03, source: "measured", evidence: PANEL },
  { id: "ifxType", label: "IFX TYPE", index: 4, led: 0x04, source: "measured", evidence: PANEL },
];

/** Knobs: `02 index 00 value`, value 0 to 255. */
export const KNOBS = [
  { id: "level", label: "LEVEL", index: 0 },
  { id: "pan", label: "PAN", index: 1 },
  { id: "pitch", label: "PITCH / GLIDE", index: 2 },
  { id: "resonance", label: "RESONANCE", index: 3 },
  { id: "egInt", label: "EG INT.", index: 4 },
  { id: "modDepth", label: "MOD. DEPTH", index: 5 },
  { id: "attack", label: "ATTACK", index: 6 },
  { id: "ifxEdit", label: "IFX EDIT", index: 7 },
  { id: "decay", label: "DECAY / RELEASE", index: 8 },
  { id: "oscEdit", label: "OSC EDIT", index: 9 },
  { id: "modSpeed", label: "MOD. SPEED", index: 10 },
].map(k => ({ ...k, source: "measured", evidence: PANEL }));

export const KNOB_MAX = 255;

/**
 * Where the marker of each knob points while the device is off, in degrees: -135 is the minimum,
 * 0 straight up, +135 the maximum. Read off the user's drawing of the switched-off device.
 * Volume and Input Level are no panel knobs; the editor only draws them.
 */
export const KNOB_OFF_ANGLE = {
  volume: -135, inputLevel: -135,
  pitch: 0, oscEdit: -135, resonance: -135, egInt: 0, modDepth: 135, modSpeed: 135,
  level: 135, pan: 0, attack: -135, decay: 135, ifxEdit: 135,
};

/** Pads: `04 index 00 velocity on`; LED red 0x2c + 2n, blue (selected part) 0x2d + 2n. */
export const PADS = Array.from({ length: 16 }, (_, n) => ({
  id: `pad${n + 1}`, label: String(n + 1), index: n, ledRed: 0x2c + 2 * n, ledBlue: 0x2d + 2 * n,
  source: "measured", evidence: PANEL,
}));

/** Touchpad: `05 xh xl yh yl`, raw values 0 to 1023 (derived from the calibration). */
export const TOUCHPAD_MAX = 1023;
