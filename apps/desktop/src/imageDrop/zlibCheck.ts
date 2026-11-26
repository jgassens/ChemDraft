/**
 * A checking zlib inflater (RFC 1950 around RFC 1951), written for the PNG image-data check: it
 * inflates a stream once, hands the output to the caller in blocks and keeps none of it. Memory is
 * fixed whatever the input: a 64 KiB ring (the 32 KiB window plus the half being handed over) and
 * typed-array Huffman tables. It refuses what zlib's own inflater refuses, so its verdict does not
 * depend on the webview: some have no `DecompressionStream`, and those that do inflate a whole input
 * write before any output is seen and differ on bytes after the stream. The stream's own end decides
 * where its Adler-32 is; anything after that is not read. Input is pulled one chunk at a time (a
 * PNG's IDAT data, never joined).
 */

/** Why a stream was refused. */
export type ZlibDamage =
  | "header" // CMF/FLG: not deflate, a window over 32 KiB, or FCHECK wrong
  | "dictionary" // FDICT set: a preset dictionary nobody supplies
  | "stored-length" // a stored block whose LEN and NLEN do not match
  | "block-type" // block type 3
  | "code-lengths" // a code set that is over-subscribed, or incomplete where zlib refuses that
  | "too-many-codes" // HLIT over 286 or HDIST over 30
  | "repeat" // a repeat with no previous length, or past the end of the lengths
  | "end-of-block" // a literal/length code set without the end-of-block code
  | "code" // a bit sequence that is no code of an incomplete set
  | "length-symbol" // length symbol 286 or 287
  | "distance-symbol" // distance symbol 30 or 31
  | "distance" // further back than the output so far
  | "truncated" // the input ends before the stream does
  | "adler" // the Adler-32 does not match the output
  | "too-long" // more output than `maxOutput`
  | "output-refused"; // the caller's `output` refused a block

export type ZlibCheckResult =
  | { ok: true; outputBytes: number; streamBytes: number }
  | { ok: false; damage: ZlibDamage };

/** When to give the event loop a turn. */
export interface ZlibYielder {
  /** Cheap: is a turn due? */
  due(): boolean;
  /** Gives the turn; rejects when the work should stop. */
  pause(): Promise<void>;
}

export interface ZlibCheckOptions {
  /** The most output accepted; one byte more ends the check with "too-long". */
  maxOutput: number;
  /**
   * Receives the output in order, in blocks of up to 32 KiB: `block` is a view of the ring, valid
   * only during the call, and `offset` is where its first byte is in the whole output. False stops
   * the check ("output-refused").
   */
  output?(block: Uint8Array, offset: number): boolean;
  /** Asked after every 32 KiB of output and every 16 blocks. */
  yielder?: ZlibYielder;
}

/** The next input chunk, or undefined when there is none. Empty chunks are skipped. */
export type ZlibInput = () => Uint8Array | undefined;

export function zlibInputOf(chunks: readonly Uint8Array[]): ZlibInput {
  let next = 0;
  return () => chunks[next++];
}

const RING_SIZE = 1 << 16;
const RING_MASK = RING_SIZE - 1;
/** Output is handed over a ring half at a time; the other half keeps the 32 KiB window. */
const HALF = RING_SIZE >>> 1;
const MAX_BITS = 15;
/** Codes up to this long decode in one table lookup; longer ones canonically. */
const LITERAL_FAST_BITS = 10;
const DISTANCE_FAST_BITS = 8;
const ADLER_MOD = 65521;
/** zlib's NMAX: bytes that can be summed before `b` must be reduced. */
const ADLER_BLOCK = 5552;

// RFC 1951 section 3.2.5: length symbols 257-285 and distance symbols 0-29.
const LENGTH_BASE = Uint16Array.of(3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258);
const LENGTH_EXTRA = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0);
const DISTANCE_BASE = Uint16Array.of(1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577);
const DISTANCE_EXTRA = Uint8Array.of(0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13);
/** The order code-length code lengths are sent in (section 3.2.7). */
const CODE_LENGTH_ORDER = Uint8Array.of(16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15);

class Damage extends Error {
  constructor(readonly damage: ZlibDamage) {
    super(damage);
  }
}

/**
 * A canonical Huffman code. `fast` maps the next `fastBits` stream bits to `symbol << 4 | length`
 * for codes that short, 0 otherwise; `counts` and `symbols` decode the rest bit by bit.
 */
class HuffmanCode {
  readonly fast: Uint16Array;
  private readonly counts = new Uint16Array(MAX_BITS + 1);
  private readonly symbols: Uint16Array;
  private readonly offsets = new Uint16Array(MAX_BITS + 2);
  private readonly nextCode = new Uint16Array(MAX_BITS + 1);

  constructor(readonly fastBits: number, maxSymbols: number) {
    this.fast = new Uint16Array(1 << fastBits);
    this.symbols = new Uint16Array(maxSymbols);
  }

  /**
   * Build from code lengths (section 3.2.2), refusing what zlib refuses: an over-subscribed set, and
   * an incomplete one unless `allowSingle` and its only code is one bit long. A set with no codes at
   * all builds when `allowSingle` (every lookup then fails, as in zlib, where an unused distance code
   * is no error).
   */
  build(lengths: Uint8Array, start: number, count: number, allowSingle: boolean): void {
    const counts = this.counts;
    counts.fill(0);
    for (let index = 0; index < count; index += 1) counts[lengths[start + index]] += 1;
    counts[0] = 0;
    let longest = MAX_BITS;
    while (longest > 0 && counts[longest] === 0) longest -= 1;
    let left = 1;
    for (let length = 1; length <= MAX_BITS; length += 1) {
      left = (left << 1) - counts[length];
      if (left < 0) throw new Damage("code-lengths");
    }
    if (left > 0 && !(allowSingle && longest <= 1)) throw new Damage("code-lengths");
    // Symbols sorted by code length, then by value: the canonical order.
    const offsets = this.offsets;
    offsets[1] = 0;
    for (let length = 1; length < MAX_BITS; length += 1) offsets[length + 1] = offsets[length] + counts[length];
    for (let symbol = 0; symbol < count; symbol += 1) {
      const length = lengths[start + symbol];
      if (length) this.symbols[offsets[length]++] = symbol;
    }
    // The first code of each length, then each short code bit-reversed into every entry it prefixes.
    const fast = this.fast;
    fast.fill(0);
    const nextCode = this.nextCode;
    let code = 0;
    for (let length = 1; length <= MAX_BITS; length += 1) {
      code = (code + counts[length - 1]) << 1;
      nextCode[length] = code;
    }
    const fastBits = this.fastBits;
    for (let symbol = 0; symbol < count; symbol += 1) {
      const length = lengths[start + symbol];
      if (!length) continue;
      const assigned = nextCode[length]++;
      if (length > fastBits) continue;
      let reversed = 0;
      for (let bit = 0; bit < length; bit += 1) reversed |= ((assigned >>> bit) & 1) << (length - 1 - bit);
      const entry = (symbol << 4) | length;
      for (let index = reversed; index < fast.length; index += 1 << length) fast[index] = entry;
    }
  }

  /** A code longer than the fast table, from at least 15 stream bits: `symbol << 4 | length`. */
  slow(bits: number): number {
    const counts = this.counts;
    let code = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length <= MAX_BITS; length += 1) {
      code |= (bits >>> (length - 1)) & 1;
      const count = counts[length];
      if (code - first < count) return (this.symbols[index + code - first] << 4) | length;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Damage("code");
  }
}

let fixedCodes: { literals: HuffmanCode; distances: HuffmanCode } | undefined;

/** The fixed codes of section 3.2.6, built once. Symbols 286, 287, 30 and 31 decode, then are refused. */
function fixedHuffmanCodes() {
  if (fixedCodes) return fixedCodes;
  const lengths = new Uint8Array(288 + 32);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  lengths.fill(5, 288);
  const literals = new HuffmanCode(LITERAL_FAST_BITS, 288);
  literals.build(lengths, 0, 288, false);
  const distances = new HuffmanCode(DISTANCE_FAST_BITS, 32);
  distances.build(lengths, 288, 32, false);
  fixedCodes = { literals, distances };
  return fixedCodes;
}

/** What `decodeCodes` stopped for. */
const END_OF_BLOCK = 0;
const HALF_FULL = 1;
const EMPTY = new Uint8Array(0);

class Inflater {
  private readonly ring = new Uint8Array(RING_SIZE);
  /** Output so far; the ring holds its last 64 KiB. */
  private written = 0;
  /** Output handed to the caller so far: a multiple of a ring half until the end. */
  private flushed = 0;
  private bitBuffer = 0;
  private bitCount = 0;
  /** Zero bits added past the end of the input, at the top of the bit buffer. */
  private padBits = 0;
  private chunk: Uint8Array = EMPTY;
  private position = 0;
  /** Input bytes in chunks before the current one. */
  private consumedBefore = 0;
  private exhausted = false;
  private adlerA = 1;
  private adlerB = 0;
  private readonly lengths = new Uint8Array(286 + 30);
  private readonly codeLengthCode = new HuffmanCode(7, 19);
  private readonly dynamicLiterals = new HuffmanCode(LITERAL_FAST_BITS, 288);
  private readonly dynamicDistances = new HuffmanCode(DISTANCE_FAST_BITS, 32);
  private literals!: HuffmanCode;
  private distances!: HuffmanCode;

  constructor(private readonly input: ZlibInput, private readonly options: ZlibCheckOptions) {}

  async run(): Promise<ZlibCheckResult> {
    try {
      return await this.inflate();
    } catch (error) {
      if (error instanceof Damage) return { ok: false, damage: error.damage };
      throw error;
    }
  }

  private async inflate(): Promise<ZlibCheckResult> {
    const { yielder } = this.options;
    const cmf = this.bits(8);
    const flg = this.bits(8);
    // Method 8 (deflate), a window of at most 32 KiB, and FCHECK.
    if (((cmf << 8) | flg) % 31 !== 0 || (cmf & 15) !== 8 || cmf >>> 4 > 7) throw new Damage("header");
    if (flg & 0x20) throw new Damage("dictionary");
    let blocks = 0;
    for (let final = false; !final;) {
      if (yielder && (++blocks & 15) === 0 && yielder.due()) await yielder.pause();
      final = this.bits(1) === 1;
      const type = this.bits(2);
      if (type === 0) {
        await this.storedBlock();
        continue;
      }
      if (type === 3) throw new Damage("block-type");
      if (type === 1) {
        ({ literals: this.literals, distances: this.distances } = fixedHuffmanCodes());
      } else {
        this.readDynamicCodes();
      }
      for (;;) {
        const stopped = this.decodeCodes(this.flushed + HALF);
        if (this.written - this.flushed >= HALF) {
          this.flush(HALF);
          if (yielder?.due()) await yielder.pause();
        }
        if (stopped === END_OF_BLOCK) break;
      }
    }
    this.flush(this.written - this.flushed);
    // The Adler-32 starts at the next byte boundary, most significant byte first.
    this.bits(this.bitCount & 7);
    let stored = 0;
    for (let index = 0; index < 4; index += 1) stored = stored * 256 + this.bits(8);
    if (stored !== this.adlerB * 65536 + this.adlerA) throw new Damage("adler");
    // Whole bytes the bit buffer holds beyond the stream were read from the input but are not part of it.
    const streamBytes = this.consumedBefore + this.position - ((this.bitCount - this.padBits) >>> 3);
    return { ok: true, outputBytes: this.written, streamBytes };
  }

  /** The next chunk with bytes in it; false when the input is used up. */
  private nextChunk(): boolean {
    if (this.exhausted) return false;
    for (;;) {
      const chunk = this.input();
      if (!chunk) {
        this.exhausted = true;
        return false;
      }
      this.consumedBefore += this.chunk.length;
      this.chunk = chunk;
      this.position = 0;
      if (chunk.length) return true;
    }
  }

  /** Adds a byte to the bit buffer: the next input byte, or zeros once there is none. */
  private refillByte(): void {
    if (this.position >= this.chunk.length && !this.nextChunk()) {
      this.padBits += 8;
    } else {
      this.bitBuffer |= this.chunk[this.position++] << this.bitCount;
    }
    this.bitCount += 8;
  }

  /** The next `count` bits (at most 16). Taking any bit past the end of the input is truncation. */
  private bits(count: number): number {
    while (this.bitCount < count) this.refillByte();
    const value = this.bitBuffer & ((1 << count) - 1);
    this.bitBuffer >>>= count;
    this.bitCount -= count;
    if (this.bitCount < this.padBits) throw new Damage("truncated");
    return value;
  }

  private async storedBlock(): Promise<void> {
    this.bits(this.bitCount & 7);
    const length = this.bits(16);
    if (length !== (~this.bits(16) & 0xffff)) throw new Damage("stored-length");
    let left = length;
    // Whole bytes already in the bit buffer come first.
    while (left > 0 && this.bitCount >= 8) {
      this.ring[this.written & RING_MASK] = this.bits(8);
      this.written += 1;
      left -= 1;
    }
    const { yielder } = this.options;
    for (;;) {
      if (this.written - this.flushed >= HALF) {
        this.flush(HALF);
        if (yielder?.due()) await yielder.pause();
      }
      if (left === 0) return;
      if (this.position >= this.chunk.length && !this.nextChunk()) throw new Damage("truncated");
      // Up to the end of the chunk, the block, and the ring half being filled.
      const take = Math.min(left, this.chunk.length - this.position, this.flushed + HALF - this.written);
      this.ring.set(this.chunk.subarray(this.position, this.position + take), this.written & RING_MASK);
      this.position += take;
      this.written += take;
      left -= take;
    }
  }

  /** Section 3.2.7: the code-length code, then the literal/length and distance code lengths. */
  private readDynamicCodes(): void {
    const literalCount = this.bits(5) + 257;
    const distanceCount = this.bits(5) + 1;
    const codeLengthCount = this.bits(4) + 4;
    if (literalCount > 286 || distanceCount > 30) throw new Damage("too-many-codes");
    const lengths = this.lengths;
    lengths.fill(0, 0, 19);
    for (let index = 0; index < codeLengthCount; index += 1) lengths[CODE_LENGTH_ORDER[index]] = this.bits(3);
    const codeLengthCode = this.codeLengthCode;
    codeLengthCode.build(lengths, 0, 19, false);
    const total = literalCount + distanceCount;
    for (let index = 0; index < total;) {
      while (this.bitCount < 7) this.refillByte();
      // A complete code-length code, the only kind built, has every code in its 7-bit table.
      const entry = codeLengthCode.fast[this.bitBuffer & 0x7f];
      const symbol = entry >>> 4;
      this.bits(entry & 15);
      if (symbol < 16) {
        lengths[index++] = symbol;
        continue;
      }
      let repeat: number;
      let value = 0;
      if (symbol === 16) {
        if (index === 0) throw new Damage("repeat");
        value = lengths[index - 1];
        repeat = 3 + this.bits(2);
      } else if (symbol === 17) {
        repeat = 3 + this.bits(3);
      } else {
        repeat = 11 + this.bits(7);
      }
      if (index + repeat > total) throw new Damage("repeat");
      lengths.fill(value, index, index + repeat);
      index += repeat;
    }
    if (lengths[256] === 0) throw new Damage("end-of-block");
    this.dynamicLiterals.build(lengths, 0, literalCount, true);
    this.dynamicDistances.build(lengths, literalCount, distanceCount, true);
    this.literals = this.dynamicLiterals;
    this.distances = this.dynamicDistances;
  }

  /**
   * Literal/length and distance codes until the block ends, or until the output reaches `stopAt` (a
   * match may run up to 257 bytes past it). The hot loop: its state lives in locals, written back to
   * the fields around `refillByte`, the only call that moves to the next chunk, and before returning.
   * The bit buffer is topped up to 24-31 bits (never bit 31, so it stays a small integer) only when
   * it holds less than the next field needs.
   */
  private decodeCodes(stopAt: number): number {
    const ring = this.ring;
    const literals = this.literals;
    const distances = this.distances;
    const literalFast = literals.fast;
    const distanceFast = distances.fast;
    const literalMask = literalFast.length - 1;
    const distanceMask = distanceFast.length - 1;
    let written = this.written;
    let buffer = this.bitBuffer;
    let count = this.bitCount;
    let chunk = this.chunk;
    let position = this.position;
    let end = chunk.length;
    let pad = this.padBits;
    while (written < stopAt) {
      // A literal/length code is at most 15 bits.
      if (count < MAX_BITS) {
        while (count < 24 && position < end) {
          buffer |= chunk[position++] << count;
          count += 8;
        }
        if (count < MAX_BITS) {
          this.bitBuffer = buffer; this.bitCount = count; this.position = position;
          while (this.bitCount < MAX_BITS) this.refillByte();
          buffer = this.bitBuffer; count = this.bitCount; chunk = this.chunk; position = this.position; end = chunk.length; pad = this.padBits;
        }
      }
      let entry = literalFast[buffer & literalMask];
      if (entry === 0) entry = literals.slow(buffer);
      const codeLength = entry & 15;
      buffer >>>= codeLength;
      count -= codeLength;
      if (count < pad) throw new Damage("truncated");
      let symbol = entry >>> 4;
      if (symbol < 256) {
        ring[written & RING_MASK] = symbol;
        written += 1;
        continue;
      }
      if (symbol === 256) {
        this.written = written; this.bitBuffer = buffer; this.bitCount = count; this.position = position;
        return END_OF_BLOCK;
      }
      symbol -= 257;
      if (symbol >= 29) throw new Damage("length-symbol");
      let length = LENGTH_BASE[symbol];
      const lengthExtra = LENGTH_EXTRA[symbol];
      // Length extra bits (at most 5) and a distance code (at most 15) together.
      if (count < lengthExtra + MAX_BITS) {
        while (count < 24 && position < end) {
          buffer |= chunk[position++] << count;
          count += 8;
        }
        if (count < lengthExtra + MAX_BITS) {
          this.bitBuffer = buffer; this.bitCount = count; this.position = position;
          while (this.bitCount < lengthExtra + MAX_BITS) this.refillByte();
          buffer = this.bitBuffer; count = this.bitCount; chunk = this.chunk; position = this.position; end = chunk.length; pad = this.padBits;
        }
      }
      if (lengthExtra) {
        length += buffer & ((1 << lengthExtra) - 1);
        buffer >>>= lengthExtra;
        count -= lengthExtra;
      }
      entry = distanceFast[buffer & distanceMask];
      if (entry === 0) entry = distances.slow(buffer);
      const distanceLength = entry & 15;
      buffer >>>= distanceLength;
      count -= distanceLength;
      const distanceSymbol = entry >>> 4;
      if (distanceSymbol >= 30) throw new Damage("distance-symbol");
      let distance = DISTANCE_BASE[distanceSymbol];
      const distanceExtra = DISTANCE_EXTRA[distanceSymbol];
      if (distanceExtra) {
        if (count < distanceExtra) {
          while (count < 24 && position < end) {
            buffer |= chunk[position++] << count;
            count += 8;
          }
          if (count < distanceExtra) {
            this.bitBuffer = buffer; this.bitCount = count; this.position = position;
            while (this.bitCount < distanceExtra) this.refillByte();
            buffer = this.bitBuffer; count = this.bitCount; chunk = this.chunk; position = this.position; end = chunk.length; pad = this.padBits;
          }
        }
        distance += buffer & ((1 << distanceExtra) - 1);
        buffer >>>= distanceExtra;
        count -= distanceExtra;
      }
      if (count < pad) throw new Damage("truncated");
      // Distances reach at most 32 KiB, which the ring always keeps, so only the output so far limits one.
      if (distance > written) throw new Damage("distance");
      for (let from = written - distance, until = written + length; written < until; from += 1, written += 1) {
        ring[written & RING_MASK] = ring[from & RING_MASK];
      }
    }
    this.written = written; this.bitBuffer = buffer; this.bitCount = count; this.position = position;
    return HALF_FULL;
  }

  /** Hand over the next `length` bytes (at most a ring half): the cap, Adler-32, then the caller. */
  private flush(length: number): void {
    if (length <= 0) return;
    const offset = this.flushed;
    if (offset + length > this.options.maxOutput) throw new Damage("too-long");
    const start = offset & RING_MASK;
    const block = this.ring.subarray(start, start + length);
    let a = this.adlerA;
    let b = this.adlerB;
    for (let index = 0; index < length;) {
      const blockEnd = Math.min(length, index + ADLER_BLOCK);
      for (; index < blockEnd; index += 1) {
        a += block[index];
        b += a;
      }
      a %= ADLER_MOD;
      b %= ADLER_MOD;
    }
    this.adlerA = a;
    this.adlerB = b;
    this.flushed += length;
    if (this.options.output && !this.options.output(block, offset)) throw new Damage("output-refused");
  }
}

/**
 * Inflate a zlib stream from `input`, checking it as strictly as zlib does, and hand its output to
 * `options.output` without keeping any. Resolves to the verdict; rejects only when
 * `options.yielder` does (an abort).
 */
export function checkZlibStream(input: ZlibInput, options: ZlibCheckOptions): Promise<ZlibCheckResult> {
  return new Inflater(input, options).run();
}
