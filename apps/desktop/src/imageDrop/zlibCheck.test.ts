import { constants, deflateSync, inflateSync, type ZlibOptions } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkZlibStream, zlibInputOf, type ZlibCheckResult, type ZlibDamage, type ZlibYielder } from "./zlibCheck";
import {
  BitWriter, adler32, adlerBytes, fixedLiteral, fixedMatch, writeDynamicHeader, zlibOfZeros, ZLIB_HEADER, type DynamicHeader
} from "./zlibTestStreams";

/**
 * For the tests that inflate megabytes or run thousands of cases: pure work that scales with the
 * machine's speed (about a second each here, idle), so a busy or slow runner gets room rather than vitest's 5 s.
 */
const HEAVY_TIMEOUT_MS = 30_000;

/** A seeded generator, so a failure names a case that can be run again. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Inflate through the checker, collecting the output it hands over. */
async function inflate(chunks: readonly Uint8Array[], maxOutput = 64 * 1024 * 1024) {
  const parts: Uint8Array[] = [];
  let expectedOffset = 0;
  const result = await checkZlibStream(zlibInputOf(chunks), {
    maxOutput,
    output(block, offset) {
      expect(offset).toBe(expectedOffset);
      expect(block.length).toBeLessThanOrEqual(32 * 1024);
      expectedOffset += block.length;
      parts.push(block.slice());
      return true;
    }
  });
  return { result, output: Buffer.concat(parts) };
}

/** What node's zlib says: the output and the stream's length, or a refusal. */
function nodeVerdict(stream: Uint8Array): { ok: true; output: Buffer; streamBytes: number } | { ok: false } {
  try {
    const { buffer, engine } = inflateSync(stream, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    return { ok: true, output: buffer, streamBytes: engine.bytesWritten };
  } catch {
    return { ok: false };
  }
}

async function expectSameAsNode(label: string, stream: Uint8Array, chunks: readonly Uint8Array[] = [stream]) {
  const expected = nodeVerdict(stream);
  const { result, output } = await inflate(chunks);
  expect(result.ok, label).toBe(expected.ok);
  if (expected.ok && result.ok) {
    expect(result.outputBytes, label).toBe(expected.output.length);
    expect(result.streamBytes, label).toBe(expected.streamBytes);
    expect(output.equals(expected.output), label).toBe(true);
  }
}

function splitAt(stream: Uint8Array, cuts: number[]): Uint8Array[] {
  const sorted = [0, ...cuts.sort((a, b) => a - b), stream.length];
  return sorted.slice(1).map((end, index) => stream.subarray(sorted[index], end));
}

/** Inputs that exercise literals, short and long matches, and the window's edge. */
function sampleInputs(): Array<[string, Uint8Array]> {
  const next = random(1);
  const randomBytes = (length: number) => Uint8Array.from({ length }, () => next() * 256);
  const text = new TextEncoder().encode("the quick brown fox jumps over the lazy dog; ".repeat(400));
  const longDistance = new Uint8Array(80_000);
  const block = randomBytes(300);
  // The same 300 bytes 32 KiB apart, just inside and outside the window.
  for (const at of [0, 32_768 - 300, 32_768, 65_200]) longDistance.set(block, at);
  const inputs: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array()],
    ["one byte", Uint8Array.of(7)],
    ["text", text],
    ["long distance", longDistance],
    ["runs", Uint8Array.from({ length: 70_000 }, (_, index) => (index >> 9) & 3)]
  ];
  for (const size of [32_767, 32_768, 32_769, 65_535, 65_536, 65_537, 100_000]) {
    inputs.push([`random ${size}`, randomBytes(size)]);
    inputs.push([`smooth ${size}`, Uint8Array.from({ length: size }, (_, index) => (index * 7 + (next() * 4)) & 255)]);
  }
  return inputs;
}

describe("checkZlibStream agrees with node's zlib on valid streams", () => {
  const inputs = sampleInputs();

  it("inflates every level with the default strategy", async () => {
    for (const [name, data] of inputs) {
      for (let level = 0; level <= 9; level += 1) {
        await expectSameAsNode(`${name} level ${level}`, deflateSync(data, { level }));
      }
    }
  }, HEAVY_TIMEOUT_MS);

  it("inflates every strategy and window size", async () => {
    const strategies: Array<[string, ZlibOptions]> = [
      ["filtered", { strategy: constants.Z_FILTERED }],
      ["huffman only", { strategy: constants.Z_HUFFMAN_ONLY }],
      ["rle", { strategy: constants.Z_RLE }],
      ["fixed", { strategy: constants.Z_FIXED }]
    ];
    for (const [name, data] of inputs) {
      for (const [strategy, options] of strategies) await expectSameAsNode(`${name} ${strategy}`, deflateSync(data, options));
      for (let windowBits = 9; windowBits <= 15; windowBits += 1) {
        await expectSameAsNode(`${name} window ${windowBits}`, deflateSync(data, { windowBits, level: 9 }));
      }
    }
  }, HEAVY_TIMEOUT_MS);

  it("gives the same result wherever the input is split", async () => {
    const small = deflateSync(new TextEncoder().encode("abracadabra, abracadabra! ".repeat(20)), { level: 9 });
    for (let cut = 0; cut <= small.length; cut += 1) {
      await expectSameAsNode(`cut at ${cut}`, small, splitAt(small, [cut]));
    }
    await expectSameAsNode("one byte per chunk", small, Array.from(small, (_, index) => small.subarray(index, index + 1)));
    const next = random(2);
    for (const [name, data] of inputs.filter(([, data]) => data.length > 30_000).slice(0, 6)) {
      for (const level of [0, 1, 6, 9]) {
        const stream = deflateSync(data, { level });
        const cuts = Array.from({ length: 1 + Math.floor(next() * 40) }, () => Math.floor(next() * stream.length));
        // Empty chunks among them.
        await expectSameAsNode(`${name} level ${level} split`, stream, splitAt(stream, [...cuts, cuts[0]]));
      }
    }
  });

  it("stops at the stream's own end and reports its length, whatever follows", async () => {
    const stream = deflateSync(new TextEncoder().encode("padding follows this"));
    for (const padding of [[0], [0, 0, 0, 0], [0xff, 1, 2, 3, 4, 5, 6, 7, 8]]) {
      const padded = Uint8Array.from([...stream, ...padding]);
      await expectSameAsNode(`padding ${padding.length}`, padded);
      const { result } = await inflate([padded]);
      expect(result).toEqual({ ok: true, outputBytes: 20, streamBytes: stream.length });
    }
  });
});

/** The verdict for a hand-built stream; node must agree with it. */
async function verdictOf(stream: Uint8Array): Promise<ZlibCheckResult> {
  const { result } = await inflate([stream]);
  expect(result.ok, "node agrees").toBe(nodeVerdict(stream).ok);
  return result;
}

async function expectDamage(label: string, stream: Uint8Array, damage: ZlibDamage) {
  expect(await verdictOf(stream), label).toEqual({ ok: false, damage });
}

/** A fixed block holding `body`, then the Adler-32 of `data`. */
function fixedStream(body: (writer: BitWriter) => void, data: Uint8Array, header: readonly number[] = ZLIB_HEADER): Uint8Array {
  const writer = new BitWriter().bytes(header).bits(1, 1).bits(1, 2);
  body(writer);
  return writer.bytes(adlerBytes(adler32(data))).finish();
}

/** One dynamic block (final) with `header`, then `body` written with its codes, then an Adler-32. */
function dynamicStream(header: DynamicHeader, body: (writer: BitWriter, codes: ReturnType<typeof writeDynamicHeader>) => void, data = new Uint8Array()) {
  const writer = new BitWriter().bytes(ZLIB_HEADER);
  const codes = writeDynamicHeader(writer, true, header);
  body(writer, codes);
  return writer.bytes(adlerBytes(adler32(data))).finish();
}

/** A complete literal/length code: symbols 0-225 eight bits long, 226-285 nine (226/256 + 60/512 = 1). */
const completeLiteralLengths = (): number[] => Array.from({ length: 286 }, (_, symbol) => symbol < 226 ? 8 : 9);

/** Write symbol `symbol` with the dynamic literal code. */
const literal = (writer: BitWriter, lengths: readonly number[], codes: number[], symbol: number) => writer.code(codes[symbol], lengths[symbol]);

describe("checkZlibStream refuses what zlib refuses", () => {
  it("checks the zlib header", async () => {
    const empty = (cmf: number, flg: number) => fixedStream(writer => fixedLiteral(writer, 256), new Uint8Array(), [cmf, flg]);
    /** FLG with `flags` (level, FDICT) and the FCHECK that makes CMF and FLG a multiple of 31. */
    const flg = (cmf: number, flags: number) => flags + (31 - ((cmf * 256 + flags) % 31)) % 31;
    await expect(verdictOf(empty(0x78, 0x9c))).resolves.toMatchObject({ ok: true });
    await expect(verdictOf(empty(0x08, flg(0x08, 0)))).resolves.toMatchObject({ ok: true });
    await expectDamage("method 7", empty(0x77, flg(0x77, 0)), "header");
    await expectDamage("method 15", empty(0x7f, flg(0x7f, 0)), "header");
    await expectDamage("window 64 KiB", empty(0x88, flg(0x88, 0)), "header");
    await expectDamage("FCHECK", empty(0x78, 0x02), "header");
    await expectDamage("preset dictionary", empty(0x78, flg(0x78, 0x20)), "dictionary");
  });

  it("checks stored blocks and block types", async () => {
    const stored = (length: number, notLength: number) => new BitWriter().bytes(ZLIB_HEADER).bits(1, 1).bits(0, 2).align()
      .bits(length, 16).bits(notLength, 16).bytes([1, 2]).bytes(adlerBytes(adler32(Uint8Array.of(1, 2)))).finish();
    await expect(verdictOf(stored(2, 0xfffd))).resolves.toMatchObject({ ok: true, outputBytes: 2 });
    await expectDamage("LEN and NLEN", stored(2, 0xfffc), "stored-length");
    const typeThree = new BitWriter().bytes(ZLIB_HEADER).bits(1, 1).bits(3, 2).bytes([0, 0, 0, 0, 0, 0]).finish();
    await expectDamage("block type 3", typeThree, "block-type");
  });

  it("refuses length symbols 286 and 287 and distance symbols 30 and 31", async () => {
    for (const symbol of [286, 287]) {
      await expectDamage(`length ${symbol}`, fixedStream(writer => { fixedLiteral(writer, 1); fixedLiteral(writer, symbol).code(0, 5); fixedLiteral(writer, 256); }, Uint8Array.of(1)), "length-symbol");
    }
    for (const symbol of [30, 31]) {
      await expectDamage(`distance ${symbol}`, fixedStream(writer => { fixedLiteral(writer, 1); fixedLiteral(writer, 257).code(symbol, 5); fixedLiteral(writer, 256); }, Uint8Array.of(1)), "distance-symbol");
    }
  });

  it("refuses a distance further back than the output, but reaches back the whole window", async () => {
    await expectDamage("before the start", fixedStream(writer => { fixedLiteral(writer, 1); fixedMatch(writer, 3, 2); fixedLiteral(writer, 256); }, new Uint8Array()), "distance");
    const window = (before: number) => {
      const data = new Uint8Array(before + 3).fill(5);
      return fixedStream(writer => {
        for (let index = 0; index < before; index += 1) fixedLiteral(writer, 5);
        fixedMatch(writer, 3, 32_768);
        fixedLiteral(writer, 256);
      }, data);
    };
    await expect(verdictOf(window(32_768))).resolves.toMatchObject({ ok: true, outputBytes: 32_771 });
    await expectDamage("a byte short of the window", window(32_767), "distance");
  });

  it("checks dynamic code lengths as zlib does", async () => {
    const lengths = (literalBits: number[], distanceBits: number[]) => ({ literalLengths: literalBits, distanceLengths: distanceBits });
    const literalLengths = completeLiteralLengths();
    const distanceLengths = Array.from({ length: 30 }, (_, symbol) => symbol < 2 ? 4 : 5);
    expect(literalLengths.reduce((sum, length) => sum + 2 ** -length, 0)).toBe(1);
    expect(distanceLengths.reduce((sum, length) => sum + 2 ** -length, 0)).toBe(1);
    const body = (header: DynamicHeader) => (writer: BitWriter, codes: ReturnType<typeof writeDynamicHeader>) => {
      literal(writer, header.literalLengths, codes.literals, 65);
      literal(writer, header.literalLengths, codes.literals, 256);
    };
    const stream = (header: DynamicHeader) => dynamicStream(header, body(header), Uint8Array.of(65));
    await expect(verdictOf(stream(lengths(literalLengths, distanceLengths)))).resolves.toMatchObject({ ok: true, outputBytes: 1 });

    const overLiterals = literalLengths.slice();
    overLiterals[285] = 8;
    await expectDamage("over-subscribed literals", stream(lengths(overLiterals, distanceLengths)), "code-lengths");
    const shortLiterals = literalLengths.slice();
    shortLiterals[285] = 0;
    await expectDamage("incomplete literals", stream(lengths(shortLiterals, distanceLengths)), "code-lengths");
    const overDistances = distanceLengths.slice();
    overDistances[29] = 4;
    await expectDamage("over-subscribed distances", stream(lengths(literalLengths, overDistances)), "code-lengths");
    await expectDamage("incomplete distances", stream(lengths(literalLengths, [2, 2, 2])), "code-lengths");
    await expectDamage("over-subscribed code-length code", stream({ ...lengths(literalLengths, distanceLengths), codeLengthLengths: Array(19).fill(4) }), "code-lengths");
    const incompleteCodeLengths = Array.from({ length: 19 }, (_, symbol) => symbol < 13 ? 4 : symbol < 18 ? 5 : 0);
    await expectDamage("incomplete code-length code", stream({ ...lengths(literalLengths, distanceLengths), codeLengthLengths: incompleteCodeLengths }), "code-lengths");

    await expectDamage("HLIT 287", stream({ ...lengths(literalLengths, distanceLengths), hlitField: 30 }), "too-many-codes");
    await expectDamage("HDIST 31", stream({ ...lengths(literalLengths, distanceLengths), hdistField: 30 }), "too-many-codes");

    const noEnd = literalLengths.slice();
    noEnd[256] = 0;
    noEnd[285] = 8;
    expect(noEnd.reduce((sum, length) => sum + (length ? 2 ** -length : 0), 0)).toBe(1);
    await expectDamage("no end-of-block code", stream(lengths(noEnd, distanceLengths)), "end-of-block");
  });

  it("checks repeats in the code lengths", async () => {
    const literalLengths = completeLiteralLengths();
    const distanceLengths = Array.from({ length: 30 }, (_, symbol) => symbol < 2 ? 4 : 5);
    const all = [...literalLengths, ...distanceLengths];
    const send = (sequence: DynamicHeader["sequence"]) => dynamicStream({ literalLengths, distanceLengths, sequence }, (writer, codes) => {
      literal(writer, literalLengths, codes.literals, 256);
    });
    // 8 × 226 as an 8 then repeats of six; the rest as they are.
    const repeated: Array<[number, number?]> = [[8]];
    for (let left = 225; left > 0;) {
      const run = Math.min(6, left);
      if (run >= 3) { repeated.push([16, run - 3]); left -= run; } else { repeated.push([8]); left -= 1; }
    }
    for (const length of all.slice(226)) repeated.push([length]);
    await expect(verdictOf(send(repeated))).resolves.toMatchObject({ ok: true, outputBytes: 0 });
    await expectDamage("repeat with nothing before it", send([[16, 0], ...all.map(length => [length] as [number])]), "repeat");
    // The zeros of 17 and 18 run past the last distance length.
    await expectDamage("16 past the end", send([...all.slice(0, -2).map(length => [length] as [number]), [16, 0]]), "repeat");
    await expectDamage("17 past the end", send([...all.slice(0, -2).map(length => [length] as [number]), [17, 0]]), "repeat");
    await expectDamage("18 past the end", send([...all.slice(0, -2).map(length => [length] as [number]), [18, 0]]), "repeat");
  });

  it("allows zlib's incomplete codes: one distance code of one bit, and no distance codes at all", async () => {
    const literalLengths = completeLiteralLengths();
    const data = Uint8Array.of(65, 65, 65, 65);
    const oneDistance = { literalLengths, distanceLengths: [1] };
    const withMatch = (distanceCode: number) => dynamicStream(oneDistance, (writer, codes) => {
      literal(writer, literalLengths, codes.literals, 65);
      literal(writer, literalLengths, codes.literals, 257);
      writer.code(distanceCode, 1);
      literal(writer, literalLengths, codes.literals, 256);
    }, data);
    await expect(verdictOf(withMatch(0))).resolves.toMatchObject({ ok: true, outputBytes: 4 });
    // The one-bit code's other half is no code.
    await expectDamage("the missing distance code", withMatch(1), "code");
    const noDistances = { literalLengths, distanceLengths: [0] };
    const literalsOnly = dynamicStream(noDistances, (writer, codes) => {
      for (const byte of data) literal(writer, literalLengths, codes.literals, byte);
      literal(writer, literalLengths, codes.literals, 256);
    }, data);
    await expect(verdictOf(literalsOnly)).resolves.toMatchObject({ ok: true, outputBytes: 4 });
    const usesMissing = dynamicStream(noDistances, (writer, codes) => {
      literal(writer, literalLengths, codes.literals, 65);
      literal(writer, literalLengths, codes.literals, 257);
      writer.bits(0, 8);
    }, data);
    await expectDamage("a match with no distance code", usesMissing, "code");
    // Two distance codes of one bit and another of two: over-subscribed even here.
    await expectDamage("three distance codes", dynamicStream({ literalLengths, distanceLengths: [1, 1, 2] }, () => undefined), "code-lengths");
    // A single literal/length code (the end of block, one bit) is complete enough for zlib too.
    const endOnly = Array.from({ length: 257 }, (_, symbol) => symbol === 256 ? 1 : 0);
    await expect(verdictOf(dynamicStream({ literalLengths: endOnly, distanceLengths: [0] }, writer => writer.code(0, 1))))
      .resolves.toMatchObject({ ok: true, outputBytes: 0 });
  });

  it("refuses every truncation and a wrong Adler-32", async () => {
    const stream = deflateSync(new TextEncoder().encode("truncate me at every byte, truncate me".repeat(30)));
    for (let length = 0; length < stream.length; length += 1) {
      await expectDamage(`${length} bytes`, stream.subarray(0, length), "truncated");
    }
    for (let index = stream.length - 4; index < stream.length; index += 1) {
      // A copy: a Buffer's slice() shares its bytes, so damaging it would damage `stream` too.
      const wrong = new Uint8Array(stream);
      wrong[index] ^= 0x10;
      await expectDamage(`Adler byte ${index}`, wrong, "adler");
    }
    await expect(verdictOf(stream)).resolves.toMatchObject({ ok: true });
    // Zero bits past the end are not data: here an all-zero code is literal 0, which must not run on to the cap.
    const literalLengths = completeLiteralLengths();
    const writer = new BitWriter().bytes(ZLIB_HEADER);
    const codes = writeDynamicHeader(writer, true, { literalLengths, distanceLengths: [0] });
    for (let index = 0; index < 10; index += 1) literal(writer, literalLengths, codes.literals, 65);
    const cut = await inflate([writer.finish()]);
    expect(cut.result).toEqual({ ok: false, damage: "truncated" });
    expect(cut.output.length).toBeLessThanOrEqual(10);
    // Truncated inside a stored block's data.
    const stored = deflateSync(new Uint8Array(1000).fill(9), { level: 0 });
    await expectDamage("stored", stored.subarray(0, 500), "truncated");
  });
});

describe("checkZlibStream under hostile input", () => {
  it("returns the same verdict as node's zlib for damaged streams, and never throws, hangs or overruns", async () => {
    const next = random(3);
    const inputs = sampleInputs().filter(([, data]) => data.length < 40_000);
    const bases: Uint8Array[] = [];
    for (const [, data] of inputs) {
      const slice = data.subarray(0, 200 + Math.floor(next() * 3000));
      for (const options of [{ level: 0 }, { level: 1 }, { level: 9 }, { strategy: constants.Z_FIXED }, { strategy: constants.Z_HUFFMAN_ONLY }]) {
        bases.push(deflateSync(slice, options));
      }
    }
    // Each trial damages a copy (a Buffer's slice() would share the base's bytes), so every one starts undamaged.
    const pristine = bases.map(base => new Uint8Array(base));
    for (const base of bases) await expectSameAsNode("undamaged base", base);
    const cap = 1024 * 1024;
    for (let trial = 0; trial < 1500; trial += 1) {
      const base = bases[trial % bases.length];
      let damaged = new Uint8Array(base);
      const kind = next();
      const flips = 1 + Math.floor(next() * 3);
      if (kind < 0.7 || kind >= 0.9) {
        for (let flip = 0; flip < flips; flip += 1) {
          const at = Math.floor(next() * damaged.length);
          damaged[at] = next() < 0.5 ? damaged[at] ^ (1 << Math.floor(next() * 8)) : Math.floor(next() * 256);
        }
      }
      if (kind >= 0.7) damaged = damaged.subarray(0, Math.floor(next() * damaged.length));
      const expected = nodeVerdict(damaged);
      let total = 0;
      const result = await checkZlibStream(zlibInputOf(splitAt(damaged, [Math.floor(next() * damaged.length)])), {
        maxOutput: cap,
        output: block => { total += block.length; return true; }
      });
      const label = `trial ${trial}`;
      expect(total, label).toBeLessThanOrEqual(cap);
      if (expected.ok && expected.output.length <= cap) {
        expect(result, label).toEqual({ ok: true, outputBytes: expected.output.length, streamBytes: expected.streamBytes });
      } else {
        expect(result.ok, label).toBe(false);
      }
    }
    bases.forEach((base, index) => expect(new Uint8Array(base), `base ${index} untouched`).toEqual(pristine[index]));
  }, HEAVY_TIMEOUT_MS);

  it("stops a bomb at the cap, with fixed memory", async () => {
    const bomb = zlibOfZeros(200 * 1024 * 1024);
    let handed = 0;
    const result = await checkZlibStream(zlibInputOf([bomb]), { maxOutput: 1_000_000, output: block => { handed += block.length; return true; } });
    expect(result).toEqual({ ok: false, damage: "too-long" });
    expect(handed).toBeLessThanOrEqual(1_000_000);
    expect(handed).toBeGreaterThan(1_000_000 - 32 * 1024);

    // 64 MiB inflated: nothing it allocates grows with the output.
    const before = process.memoryUsage().arrayBuffers;
    let most = 0;
    const big = await checkZlibStream(zlibInputOf([zlibOfZeros(64 * 1024 * 1024)]), {
      maxOutput: 64 * 1024 * 1024,
      output: (_block, offset) => {
        if (offset % (4 * 1024 * 1024) === 0) most = Math.max(most, process.memoryUsage().arrayBuffers - before);
        return true;
      }
    });
    expect(big).toMatchObject({ ok: true, outputBytes: 64 * 1024 * 1024 });
    expect(most).toBeLessThan(4 * 1024 * 1024);
  }, HEAVY_TIMEOUT_MS);

  it("stops when the caller refuses a block", async () => {
    const stream = deflateSync(new Uint8Array(100_000));
    let calls = 0;
    const result = await checkZlibStream(zlibInputOf([stream]), { maxOutput: 1e6, output: () => ++calls < 2 });
    expect(result).toEqual({ ok: false, damage: "output-refused" });
    expect(calls).toBe(2);
  });

  it("asks the yielder as it goes, and rejects when it does", async () => {
    let asked = 0;
    let paused = 0;
    const yielder: ZlibYielder = { due: () => { asked += 1; return true; }, pause: async () => { paused += 1; } };
    const stream = deflateSync(new Uint8Array(300_000).map((_, index) => index * 31 & 255), { level: 1 });
    expect(await checkZlibStream(zlibInputOf([stream]), { maxOutput: 1e6, yielder })).toMatchObject({ ok: true, outputBytes: 300_000 });
    expect(paused).toBeGreaterThanOrEqual(9);
    expect(asked).toBe(paused);
    // Many tiny blocks: asked every 16.
    const blocks = new BitWriter().bytes(ZLIB_HEADER);
    for (let index = 0; index < 100; index += 1) fixedLiteral(blocks.bits(index === 99 ? 1 : 0, 1).bits(1, 2), 256);
    asked = 0;
    expect(await checkZlibStream(zlibInputOf([blocks.bytes(adlerBytes(1)).finish()]), { maxOutput: 10, yielder })).toMatchObject({ ok: true });
    expect(asked).toBe(6);
    const stop = new Error("stopped");
    const stopping: ZlibYielder = { due: () => true, pause: () => Promise.reject(stop) };
    await expect(checkZlibStream(zlibInputOf([stream]), { maxOutput: 1e6, yielder: stopping })).rejects.toBe(stop);
  });
});
