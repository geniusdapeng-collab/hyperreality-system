/**
 * 无外部服务的 URL 二维码（QR Version 5-L，Byte mode）。
 * 仅在服务端确认 URL 可公开访问后渲染；最多 106 UTF-8 字节，超限时诚实降级为复制链接。
 */
import { useMemo } from "react";

export const URL_QR_MAX_BYTES = 106;
const SIZE = 37;
const DATA_CODEWORDS = 108;
const ECC_CODEWORDS = 26;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
let value = 1;
for (let index = 0; index < 255; index++) {
  EXP[index] = value;
  LOG[value] = index;
  value <<= 1;
  if (value & 0x100) value ^= 0x11d;
}
for (let index = 255; index < EXP.length; index++) EXP[index] = EXP[index - 255]!;

function multiply(left: number, right: number): number {
  return left === 0 || right === 0 ? 0 : EXP[LOG[left]! + LOG[right]!]!;
}

function generator(degree: number): number[] {
  let result = [1];
  for (let exponent = 0; exponent < degree; exponent++) {
    const next = new Array<number>(result.length + 1).fill(0);
    for (let index = 0; index < result.length; index++) {
      next[index] = next[index]! ^ result[index]!;
      next[index + 1] = next[index + 1]! ^ multiply(result[index]!, EXP[exponent]!);
    }
    result = next;
  }
  return result;
}

function errorCorrection(data: number[]): number[] {
  const coefficients = generator(ECC_CODEWORDS);
  const remainder = new Array<number>(ECC_CODEWORDS).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.shift();
    remainder.push(0);
    for (let index = 0; index < remainder.length; index++) {
      remainder[index] = remainder[index]! ^ multiply(coefficients[index + 1]!, factor);
    }
  }
  return remainder;
}

function appendBits(target: number[], number: number, length: number): void {
  for (let shift = length - 1; shift >= 0; shift--) target.push((number >>> shift) & 1);
}

function encodeData(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  if (bytes.length > URL_QR_MAX_BYTES) throw new Error("链接过长，无法生成内置二维码");
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4); // Byte mode
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);
  for (let index = 0; index < Math.min(4, DATA_CODEWORDS * 8 - bits.length); index++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset++) byte = (byte << 1) | bits[index + offset]!;
    data.push(byte);
  }
  for (let index = 0; data.length < DATA_CODEWORDS; index++) data.push(index % 2 === 0 ? 0xec : 0x11);
  return [...data, ...errorCorrection(data)];
}

function bchDigit(number: number): number {
  let digit = 0;
  while (number !== 0) { digit++; number >>>= 1; }
  return digit;
}

export function formatBitsForLowCorrection(mask = 0): number {
  const data = (1 << 3) | mask; // QR error correction level L is encoded as 01.
  let valueWithRemainder = data << 10;
  const generatorBits = 0x537;
  while (bchDigit(valueWithRemainder) - bchDigit(generatorBits) >= 0) {
    valueWithRemainder ^= generatorBits << (bchDigit(valueWithRemainder) - bchDigit(generatorBits));
  }
  return ((data << 10) | valueWithRemainder) ^ 0x5412;
}

function placeFinder(modules: Array<Array<boolean | null>>, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const y = row + r;
      const x = col + c;
      if (y < 0 || y >= SIZE || x < 0 || x >= SIZE) continue;
      modules[y]![x] = r >= 0 && r <= 6 && c >= 0 && c <= 6
        && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
    }
  }
}

function placeFormat(modules: Array<Array<boolean | null>>, mask: number): void {
  const bits = formatBitsForLowCorrection(mask);
  for (let index = 0; index < 15; index++) {
    const dark = ((bits >>> index) & 1) === 1;
    if (index < 6) modules[index]![8] = dark;
    else if (index < 8) modules[index + 1]![8] = dark;
    else modules[SIZE - 15 + index]![8] = dark;

    if (index < 8) modules[8]![SIZE - index - 1] = dark;
    else if (index === 8) modules[8]![7] = dark;
    else modules[8]![15 - index - 1] = dark;
  }
  modules[SIZE - 8]![8] = true;
}

export function buildUrlQrMatrix(text: string): boolean[][] {
  const codewords = encodeData(text);
  const modules = Array.from({ length: SIZE }, () => new Array<boolean | null>(SIZE).fill(null));
  placeFinder(modules, 0, 0);
  placeFinder(modules, SIZE - 7, 0);
  placeFinder(modules, 0, SIZE - 7);

  // Version 5 alignment centres are 6 and 30; occupied centres are already covered by finder patterns.
  for (const row of [6, 30]) for (const col of [6, 30]) {
    if (modules[row]![col] !== null) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
      modules[row + r]![col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
    }
  }
  for (let index = 8; index < SIZE - 8; index++) {
    if (modules[index]![6] === null) modules[index]![6] = index % 2 === 0;
    if (modules[6]![index] === null) modules[6]![index] = index % 2 === 0;
  }
  const mask = 0;
  placeFormat(modules, mask);

  let row = SIZE - 1;
  let direction = -1;
  let byteIndex = 0;
  let bitIndex = 7;
  for (let col = SIZE - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    while (true) {
      for (let offset = 0; offset < 2; offset++) {
        const x = col - offset;
        if (modules[row]![x] !== null) continue;
        const source = byteIndex < codewords.length && (((codewords[byteIndex]! >>> bitIndex) & 1) === 1);
        modules[row]![x] = ((row + x) % 2 === 0) ? !source : source;
        if (--bitIndex < 0) { byteIndex++; bitIndex = 7; }
      }
      row += direction;
      if (row >= 0 && row < SIZE) continue;
      row -= direction;
      direction = -direction;
      break;
    }
  }
  return modules.map((line) => line.map(Boolean));
}

export function UrlQrCode({ value, size = 112 }: { value: string; size?: number }) {
  const matrix = useMemo(() => buildUrlQrMatrix(value), [value]);
  const path = useMemo(() => matrix.flatMap((line, row) => line.map((dark, col) => (
    dark ? `M${col + 4} ${row + 4}h1v1h-1z` : ""
  ))).join(""), [matrix]);
  return (
    <svg
      data-wl-custom-graphic="generated-qr-code"
      viewBox={`0 0 ${SIZE + 8} ${SIZE + 8}`}
      width={size}
      height={size}
      role="img"
      aria-label="客户服务前台二维码"
      shapeRendering="crispEdges"
      className="shrink-0 rounded border border-line bg-white"
    >
      <rect width={SIZE + 8} height={SIZE + 8} fill="#fff" />
      <path d={path} fill="#05070b" />
    </svg>
  );
}
