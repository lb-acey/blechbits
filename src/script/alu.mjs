/**
 * Integer arithmetic of the script language, shared by the VM and the
 * compiler's constant folding. Everything wraps to signed 32 bits; division
 * truncates toward zero; shifts use the low five bits of the count and `>>`
 * keeps the sign. A zero divisor returns null.
 */
export const s32 = n => n | 0;

export function binary(name, a, b) {
  switch (name) {
    case "ADD": return (a + b) | 0;
    case "SUB": return (a - b) | 0;
    case "MUL": return Math.imul(a, b);
    case "DIV": return b === 0 ? null : (b === -1 ? -a | 0 : (a / b) | 0);
    case "MOD": return b === 0 ? null : (b === -1 ? 0 : a % b | 0);
    case "AND": return a & b;
    case "OR": return a | b;
    case "XOR": return a ^ b;
    case "SHL": return a << (b & 31);
    case "SHR": return a >> (b & 31);
    case "EQ": return a === b ? 1 : 0;
    case "NE": return a !== b ? 1 : 0;
    case "LT": return a < b ? 1 : 0;
    case "LE": return a <= b ? 1 : 0;
    case "GT": return a > b ? 1 : 0;
    case "GE": return a >= b ? 1 : 0;
    default: throw new Error(`not a binary operation: ${name}`);
  }
}
