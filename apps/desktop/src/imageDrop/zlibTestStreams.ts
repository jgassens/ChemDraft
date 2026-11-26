/** Hand-built zlib streams for the inflater and PNG tests: a bit writer and canonical codes. Tests only. */

export class BitWriter {
  private out = new Uint8Array(1024);
  private length = 0;
  private current = 0;
  private used = 0;

  /** `count` bits (at most 16) of `value`, least significant first (header fields and extra bits). */
  bits(value: number, count: number): this {
    this.current |= (value & ((1 << count) - 1)) << this.used;
    this.used += count;
    while (this.used >= 8) {
      this.push(this.current & 255);
      this.current >>>= 8;
      this.used -= 8;
    }
    return this;
  }

  /** A Huffman code, most significant bit first. */
  code(code: number, length: number): this {
    return this.bits(reverseBits(code, length), length);
  }

  align(): this {
    if (this.used) this.push(this.current);
    this.current = 0;
    this.used = 0;
    return this;
  }

  bytes(values: ArrayLike<number>): this {
    this.align();
    for (let index = 0; index < values.length; index += 1) this.bits(values[index], 8);
    return this;
  }

  finish(): Uint8Array {
    this.align();
    return this.out.slice(0, this.length);
  }

  private push(byte: number): void {
    if (this.length === this.out.length) {
      const grown = new Uint8Array(this.out.length * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.length++] = byte;
  }
}

function reverseBits(code: number, length: number): number {
  let reversed = 0;
  for (let bit = 0; bit < length; bit += 1) reversed |= ((code >>> bit) & 1) << (length - 1 - bit);
  return reversed;
}

/** CMF 0x78 (deflate, 32 KiB window) and an FLG whose FCHECK makes it valid. */
export const ZLIB_HEADER = [0x78, 0x01] as const;

export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return (b * 65536 + a) >>> 0;
}

export function adlerBytes(value: number): number[] {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

/** Canonical codes for a list of code lengths (RFC 1951 section 3.2.2); 0 for unused symbols. */
export function canonicalCodes(lengths: readonly number[]): number[] {
  const counts = new Array<number>(16).fill(0);
  for (const length of lengths) if (length) counts[length] += 1;
  const next = new Array<number>(16).fill(0);
  let code = 0;
  for (let length = 1; length < 16; length += 1) {
    code = (code + counts[length - 1]) << 1;
    next[length] = code;
  }
  return lengths.map(length => length ? next[length]++ : 0);
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** The length symbol (257-285) for a match length, with its extra bits. */
export function lengthSymbol(length: number): { symbol: number; extra: number; bits: number } {
  let index = LENGTH_BASE.length - 1;
  while (LENGTH_BASE[index] > length) index -= 1;
  return { symbol: 257 + index, extra: length - LENGTH_BASE[index], bits: LENGTH_EXTRA[index] };
}

export function distanceSymbol(distance: number): { symbol: number; extra: number; bits: number } {
  let index = DISTANCE_BASE.length - 1;
  while (DISTANCE_BASE[index] > distance) index -= 1;
  return { symbol: index, extra: distance - DISTANCE_BASE[index], bits: DISTANCE_EXTRA[index] };
}

/** A literal/length symbol in the fixed code (section 3.2.6). */
export function fixedLiteral(writer: BitWriter, symbol: number): BitWriter {
  if (symbol < 144) return writer.code(0x30 + symbol, 8);
  if (symbol < 256) return writer.code(0x190 + symbol - 144, 9);
  if (symbol < 280) return writer.code(symbol - 256, 7);
  return writer.code(0xc0 + symbol - 280, 8);
}

/** A match in the fixed code: the length symbol, its extra bits, the distance code and its extra bits. */
export function fixedMatch(writer: BitWriter, length: number, distance: number): BitWriter {
  const lengthCode = lengthSymbol(length);
  fixedLiteral(writer, lengthCode.symbol).bits(lengthCode.extra, lengthCode.bits);
  const distanceCode = distanceSymbol(distance);
  return writer.code(distanceCode.symbol, 5).bits(distanceCode.extra, distanceCode.bits);
}

/** A complete code-length code: symbols 0-12 four bits long, 13-18 five bits. */
export const CODE_LENGTH_LENGTHS = Array.from({ length: 19 }, (_, symbol) => symbol < 13 ? 4 : 5);
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export interface DynamicHeader {
  literalLengths: readonly number[];
  distanceLengths: readonly number[];
  /** Written instead of the true HLIT / HDIST fields. */
  hlitField?: number;
  hdistField?: number;
  /** The code-length code's lengths, by symbol (default `CODE_LENGTH_LENGTHS`). */
  codeLengthLengths?: readonly number[];
  /** The code-length symbols as sent, `[symbol, extra]`; by default each length on its own. */
  sequence?: ReadonlyArray<readonly [number, number?]>;
}

/** Block header bits for a dynamic block and its code-length sections; the codes to write data with. */
export function writeDynamicHeader(writer: BitWriter, final: boolean, header: DynamicHeader) {
  const { literalLengths, distanceLengths } = header;
  const codeLengthLengths = header.codeLengthLengths ?? CODE_LENGTH_LENGTHS;
  writer.bits(final ? 1 : 0, 1).bits(2, 2);
  writer.bits(header.hlitField ?? literalLengths.length - 257, 5);
  writer.bits(header.hdistField ?? distanceLengths.length - 1, 5);
  writer.bits(19 - 4, 4);
  for (const symbol of CODE_LENGTH_ORDER) writer.bits(codeLengthLengths[symbol], 3);
  const codeLengthCodes = canonicalCodes(codeLengthLengths);
  const sequence = header.sequence ?? [...literalLengths, ...distanceLengths].map(length => [length] as const);
  for (const [symbol, extra = 0] of sequence) {
    writer.code(codeLengthCodes[symbol], codeLengthLengths[symbol]);
    if (symbol === 16) writer.bits(extra, 2);
    else if (symbol === 17) writer.bits(extra, 3);
    else if (symbol === 18) writer.bits(extra, 7);
  }
  return { literals: canonicalCodes(literalLengths), distances: canonicalCodes(distanceLengths) };
}

/**
 * A valid zlib stream of `count` zero bytes in one fixed block: a literal, then matches at distance 1.
 * Cheap to build at any size, so the PNG tests can make large pictures quickly.
 */
export function zlibOfZeros(count: number): Uint8Array {
  const writer = new BitWriter().bytes(ZLIB_HEADER).bits(1, 1).bits(1, 2);
  let left = count;
  if (left > 0) {
    fixedLiteral(writer, 0);
    left -= 1;
  }
  // Length 258 (symbol 285, code 11000101) at distance 1 (code 00000): 13 bits, written at once.
  const longest = reverseBits(0xc5, 8);
  while (left >= 258 + 3) {
    writer.bits(longest, 13);
    left -= 258;
  }
  if (left >= 3) {
    fixedMatch(writer, left, 1);
    left = 0;
  }
  for (; left > 0; left -= 1) fixedLiteral(writer, 0);
  fixedLiteral(writer, 256);
  // The Adler-32 of zeros: a stays 1, b adds 1 per byte.
  return writer.bytes(adlerBytes((count % 65521) * 65536 + 1)).finish();
}
