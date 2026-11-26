// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { DAMAGED_PNG_IMAGE_DATA, EventLoopTurns, PNG_SURPLUS_IMAGE_DATA_BYTES, pngImageDataError } from "./pngIntegrity";
import { bytesToBase64, prepareDroppedImage } from "./prepareDroppedImage";
import type { DecodeCheck, DroppedImageDecoders } from "./rasterDecode";
import { damagedDropFixture, testPng, writeTestPng, type TestPngChunk, type TestPngOptions } from "./pngTestImages";
import { zlibOfZeros } from "./zlibTestStreams";

const DAMAGED = "the PNG could not be decoded: its image data is damaged.";
const NS = 'xmlns="http://www.w3.org/2000/svg"';

/** Like WebKit's: every PNG decodes, whatever its image data. */
const acceptsEverything: DecodeCheck = async () => ({ width: 4, height: 4 });
const decoders: DroppedImageDecoders = {
  decodeCheck: acceptsEverything,
  rasterToPng: async () => { throw new Error("not used"); }
};

const prepare = (bytes: Uint8Array, name = "picture.png") => prepareDroppedImage(name, bytes, decoders);

async function expectKept(label: string, bytes: Uint8Array) {
  expect(await prepare(bytes), label).toEqual({
    ok: true, image: { name: "picture.png", mimeType: "image/png", dataBase64: bytesToBase64(bytes), notes: [] }
  });
}

async function expectRefused(label: string, bytes: Uint8Array) {
  expect(await prepare(bytes), label).toEqual({ ok: false, reason: DAMAGED });
}

const withChunks = (options: TestPngOptions, change: (chunks: TestPngChunk[]) => TestPngChunk[]) => testPng({ ...options, chunks: change });
const swapLastAdler = (stream: Uint8Array) => {
  const copy = stream.slice();
  copy[copy.length - 1] ^= 0x01;
  return copy;
};

/**
 * An RGBA picture whose image data is all zeros (filter 0, black transparent pixels), with `extra`
 * zero bytes more: built from a hand-made stream, so a large one costs nothing to make.
 */
function zeroPng(width: number, height: number, extra = 0, change = (stream: Uint8Array) => stream): Uint8Array {
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const stream = change(zlibOfZeros((1 + width * 4) * height + extra));
  return writeTestPng([{ type: "IHDR", data: header }, { type: "IDAT", data: stream }, { type: "IEND", data: new Uint8Array() }]);
}

/**
 * A check pauses at every chance it gives, however fast the machine: a turn is always due. Each
 * chance is a 1 MiB CRC piece or 32 KiB of output, so a small picture gives a known number of them.
 * Returns the spy, whose calls are the chances asked about.
 */
const pauseAtEveryChance = () => vi.spyOn(EventLoopTurns.prototype, "due").mockReturnValue(true);

/**
 * A clock that moves 20 ms at every read: longer than a timer turn waits for its timer (16 ms), so
 * every pause posts exactly one message, on any machine, and the count of messages is the count of pauses.
 */
function steppingClock() {
  let now = 0;
  return vi.spyOn(performance, "now").mockImplementation(() => (now += 20));
}

/**
 * Aborts `controller` during the pause that posts message number `at`, once that pause is waiting.
 * Unless `deliver`, that message never comes, as in a hidden window: only the abort can settle it.
 * Returns the spy, whose instances are the ports that posted.
 */
function abortDuringPause(controller: AbortController, reason: Error, at: number, deliver = true) {
  const post = MessagePort.prototype.postMessage;
  let posted = 0;
  return vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (this: MessagePort, message: unknown) {
    if (++posted === at) {
      queueMicrotask(() => controller.abort(reason));
      if (!deliver) return;
    }
    post.call(this, message);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the dropped PNGs from the hands-on pass", () => {
  it("refuses image data that cannot be inflated and image data that inflates to the wrong bytes", async () => {
    // Their chunk framing and CRCs are good, and the webview decodes both.
    await expectRefused("r8-damaged.png", damagedDropFixture("r8-damaged.png"));
    await expectRefused("r9-midcorrupt.png", damagedDropFixture("r9-midcorrupt.png"));
  });

  it("refuses an SVG that embeds either one, naming the embedded PNG", async () => {
    for (const name of ["r8-damaged.png", "r9-midcorrupt.png"] as const) {
      const href = `data:image/png;base64,${bytesToBase64(damagedDropFixture(name))}`;
      const svg = new TextEncoder().encode(`<svg ${NS} width="200" height="200"><image href="${href}" width="100" height="80"/></svg>`);
      expect(await prepareDroppedImage("wrap.svg", svg, decoders), name)
        .toEqual({ ok: false, reason: "an embedded PNG picture could not be decoded: its image data is damaged." });
    }
    const good = `data:image/png;base64,${bytesToBase64(testPng({ width: 5, height: 4 }))}`;
    const svg = new TextEncoder().encode(`<svg ${NS} width="20" height="20"><image href="${good}" width="5" height="4"/></svg>`);
    expect((await prepareDroppedImage("good.svg", svg, decoders)).ok).toBe(true);
  });
});

describe("pngImageDataError accepts every valid PNG, byte for byte", () => {
  it("accepts each colour type at each bit depth it allows", async () => {
    const kinds: Array<[number, number[]]> = [[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]];
    for (const [colourType, depths] of kinds) {
      for (const bitDepth of depths) {
        // Odd widths leave sub-byte rows to round up.
        await expectKept(`type ${colourType} depth ${bitDepth}`, testPng({ width: 13, height: 7, colourType, bitDepth }));
      }
    }
  });

  it("accepts Adam7, including pictures too small to fill every pass", async () => {
    for (const [width, height] of [[1, 1], [3, 5], [8, 8], [9, 1], [1, 9], [37, 23]]) {
      for (const [colourType, bitDepth] of [[0, 1], [3, 4], [2, 8], [6, 16]]) {
        await expectKept(`${width} × ${height} type ${colourType} depth ${bitDepth}`,
          testPng({ width, height, colourType, bitDepth, interlace: true }));
      }
    }
  });

  it("accepts image data split over many IDAT chunks, empty ones among them", async () => {
    await expectKept("one-byte chunks", testPng({ width: 20, height: 20, idatSizes: Array(300).fill(1) }));
    await expectKept("an empty IDAT first and in the middle", testPng({ width: 20, height: 20, idatSizes: [0, 10, 0, 0, 7] }));
    await expectKept("an empty IDAT last", withChunks({ width: 20, height: 20 }, chunks =>
      chunks.flatMap(chunk => chunk.type === "IEND" ? [{ type: "IDAT", data: new Uint8Array() }, chunk] : [chunk])));
  });

  it("accepts an Adler-32 that an IDAT boundary splits", async () => {
    for (const keep of [1, 2, 3]) {
      const stream = testPngStream(testPng({ width: 30, height: 9 }));
      await expectKept(`last IDAT holds ${keep}`, testPng({ width: 30, height: 9, idatSizes: [stream.length - keep] }));
    }
  });

  it("ignores a bad CRC on an ancillary chunk, and anything after IEND", async () => {
    await expectKept("ancillary CRC", withChunks({ width: 6, height: 6 }, chunks => [chunks[0],
      { type: "tEXt", data: new TextEncoder().encode("Comment\0hello"), crc: 0x12345678 }, ...chunks.slice(1)]));
    await expectKept("trailing bytes", testPng({ width: 6, height: 6, trailing: new Uint8Array([1, 2, 3, 0, 0, 0, 0]) }));
  });

  it("ignores bytes after the zlib stream, in its last IDAT or in an IDAT of their own", async () => {
    // libpng and the webviews read no further than the stream's end.
    for (const padding of [[0], [0, 0, 0, 0], [0xff, 0x13, 0x37, 0, 1, 2, 3, 4, 5]]) {
      await expectKept(`${padding.length} bytes in the last IDAT`,
        testPng({ width: 20, height: 9, zlib: stream => concat(stream, Uint8Array.from(padding)) }));
      await expectKept(`${padding.length} bytes in an IDAT after it`, withChunks({ width: 20, height: 9 }, chunks =>
        chunks.flatMap(chunk => chunk.type === "IEND" ? [{ type: "IDAT", data: Uint8Array.from(padding) }, chunk] : [chunk])));
    }
    // The Adler-32 is where the stream ends, not the last four bytes of the image data.
    await expectRefused("wrong Adler-32 before padding",
      testPng({ width: 20, height: 9, zlib: stream => concat(swapLastAdler(stream), Uint8Array.of(0, 0, 0, 0)) }));
  });

  it("tolerates up to 64 KiB of surplus image data and no more", async () => {
    const surplus = (extra: number) => testPng({ width: 10, height: 10, imageData: data => concat(data, new Uint8Array(extra)) });
    await expectKept("1000 bytes", surplus(1000));
    await expectKept("64 KiB", surplus(PNG_SURPLUS_IMAGE_DATA_BYTES));
    await expectRefused("64 KiB and one", surplus(PNG_SURPLUS_IMAGE_DATA_BYTES + 1));
  });
});

describe("pngImageDataError refuses damaged image data", () => {
  it("refuses short, truncated and corrupted image data", async () => {
    await expectRefused("a row short", testPng({ width: 10, height: 10, imageData: data => data.subarray(0, data.length - 11) }));
    await expectRefused("a byte short", testPng({ width: 10, height: 10, imageData: data => data.subarray(0, data.length - 1) }));
    await expectRefused("a byte short, interlaced", testPng({ width: 10, height: 10, interlace: true, imageData: data => data.subarray(0, data.length - 1) }));
    await expectRefused("truncated stream", testPng({ width: 40, height: 40, zlib: stream => stream.subarray(0, stream.length - 9) }));
    await expectRefused("wrong Adler-32", testPng({ width: 40, height: 40, zlib: swapLastAdler }));
    // The framing check before this one already refuses a PNG with no IDAT at all.
    expect(await pngImageDataError(withChunks({ width: 4, height: 4 }, chunks => chunks.filter(chunk => chunk.type !== "IDAT"))))
      .toBe(DAMAGED_PNG_IMAGE_DATA);
  });

  it("refuses a filter byte above 4 at any row start, pass by pass", async () => {
    const badFilter = (row: number, options: Partial<TestPngOptions> = {}) => testPng({
      width: 300, height: 300, colourType: 6, ...options,
      imageData: (data, rowStarts) => { const copy = data.slice(); copy[rowStarts.at(row)!] = 5; return copy; }
    });
    for (const row of [0, 1, 150, -1]) await expectRefused(`row ${row}`, badFilter(row));
    // The first row of the last Adam7 pass, and the very last row.
    for (const row of [-150, -1]) await expectRefused(`interlaced row ${row}`, badFilter(row, { interlace: true }));
    // A byte above 4 inside a row is only a pixel.
    await expectKept("pixel bytes", testPng({ width: 300, height: 20, colourType: 6,
      imageData: data => data.map((byte, index) => index % 1201 === 0 ? byte : 0xff) }));
  });

  it("refuses a bad CRC on IHDR, PLTE, IDAT or IEND", async () => {
    for (const type of ["IHDR", "PLTE", "IDAT", "IEND"]) {
      await expectRefused(`${type} CRC`, withChunks({ width: 4, height: 4, colourType: 3 }, chunks =>
        chunks.map(chunk => chunk.type === type ? { ...chunk, crc: 0 } : chunk)));
    }
  });

  it("refuses a missing palette, invalid header values and IDAT chunks that are not consecutive", async () => {
    await expectRefused("no PLTE", withChunks({ width: 4, height: 4, colourType: 3 }, chunks => chunks.filter(chunk => chunk.type !== "PLTE")));
    const header = (index: number, value: number) => withChunks({ width: 4, height: 4 }, chunks => chunks.map(chunk => {
      if (chunk.type !== "IHDR") return chunk;
      const data = chunk.data.slice();
      data[index] = value;
      return { ...chunk, data };
    }));
    await expectRefused("RGB at depth 4", header(8, 4));
    await expectRefused("depth 3", header(8, 3));
    await expectRefused("colour type 5", header(9, 5));
    await expectRefused("compression method 1", header(10, 1));
    await expectRefused("filter method 1", header(11, 1));
    await expectRefused("interlace method 2", header(12, 2));
    await expectRefused("split IDAT", withChunks({ width: 20, height: 20, idatSizes: [10] }, chunks =>
      [chunks[0], chunks[1], { type: "tEXt", data: new TextEncoder().encode("a\0b") }, ...chunks.slice(2)]));
  });

  it("stops inflating far too much image data rather than reading it all", async () => {
    // 64 MiB of zeros behind a 10 × 10 picture. Counted in chances to pause (one per 32 KiB of
    // output), not in time: reading it all would be 2048 of them; the check stops within 64 KiB of the picture.
    const chances = pauseAtEveryChance();
    expect(await pngImageDataError(zeroPng(10, 10, 64 * 1024 * 1024))).toBe(DAMAGED_PNG_IMAGE_DATA);
    expect(chances.mock.calls.length).toBeLessThanOrEqual(3);
    expect(await pngImageDataError(zeroPng(10, 10, PNG_SURPLUS_IMAGE_DATA_BYTES))).toBeUndefined();
  });
});

describe("pngImageDataError keeps the window responsive and honours the file's deadline", () => {
  it("lets a timer run during a large check, and makes a small one wait for none", async () => {
    // Large enough to pause: 16 chances, every one taken, the first a timer turn. The clock stands
    // still, so that turn waits until a timer has run rather than giving up after 16 ms of a busy machine.
    const chances = pauseAtEveryChance();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    let fired = false;
    setTimeout(() => { fired = true; }, 0);
    expect(await pngImageDataError(zeroPng(512, 256))).toBeUndefined();
    expect(chances.mock.calls.length).toBeGreaterThanOrEqual(16);
    expect(fired).toBe(true);
    // 16 KiB of output and one 16 KiB chunk: no chance to pause at all, so no turn however slow the machine.
    chances.mockClear();
    clock.mockRestore();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const posts = vi.spyOn(MessagePort.prototype, "postMessage");
    expect(await pngImageDataError(testPng({ width: 64, height: 64, colourType: 6 }))).toBeUndefined();
    expect(chances).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(posts).not.toHaveBeenCalled();
  });

  it("gives turns between IDAT chunks just under 1 MiB, each CRC'd in one piece", async () => {
    // Twenty of them, then a bad IEND CRC, so every chance to pause comes from walking the chunks.
    const header = zeroPng(1, 1).subarray(16, 29);
    const data = Array.from({ length: 20 }, (): TestPngChunk => ({ type: "IDAT", data: new Uint8Array(1024 * 1024 - 1) }));
    const png = writeTestPng([{ type: "IHDR", data: header }, ...data, { type: "IEND", data: new Uint8Array(), crc: 0 }]);
    steppingClock();
    const chances = pauseAtEveryChance();
    const posts = vi.spyOn(MessagePort.prototype, "postMessage");
    expect(await pngImageDataError(png)).toBe(DAMAGED_PNG_IMAGE_DATA);
    expect(chances.mock.calls.length).toBeGreaterThanOrEqual(19);
    expect(posts).toHaveBeenCalledTimes(chances.mock.calls.length);
  });

  it("rejects with the abort reason when the deadline passes mid-check", async () => {
    const controller = new AbortController();
    const reason = new Error("reading it took longer than 30 seconds.");
    const png = zeroPng(8000, 4000);
    setTimeout(() => controller.abort(reason), 5);
    await expect(pngImageDataError(png, { signal: controller.signal })).rejects.toBe(reason);
    await expect(pngImageDataError(png, { signal: controller.signal })).rejects.toBe(reason);
  });

  it("refuses through prepareDroppedImage with the deadline wording", async () => {
    const controller = new AbortController();
    const reason = new Error("reading it took longer than 30 seconds.");
    controller.abort(reason);
    await expect(prepareDroppedImage("late.png", testPng({ width: 4, height: 4 }), decoders, { signal: controller.signal })).rejects.toBe(reason);
  });

  it("is not held up by a hidden window's throttled timers: none fires while the check runs", async () => {
    pauseAtEveryChance();
    const realSetTimeout = globalThis.setTimeout;
    // So late that none fires before the check ends: a timer turn that waited for its timer would never end.
    const throttled = vi.fn((callback: () => void, ms?: number) => realSetTimeout(callback, Math.max(ms ?? 0, 60_000)));
    vi.stubGlobal("setTimeout", throttled);
    expect(await pngImageDataError(zeroPng(512, 256))).toBeUndefined();
    vi.unstubAllGlobals();
    // Timer turns did run (the first pause is one); each gave up after 16 ms.
    expect(throttled.mock.calls.filter(call => call[1] === 0).length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to setTimeout(0) turns where there is no MessageChannel", async () => {
    vi.stubGlobal("MessageChannel", undefined);
    const chances = pauseAtEveryChance();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    expect(await pngImageDataError(zeroPng(512, 256))).toBeUndefined();
    expect(chances.mock.calls.length).toBeGreaterThanOrEqual(16);
    expect(setTimeoutSpy.mock.calls.filter(call => call[1] === 0).length).toBeGreaterThanOrEqual(chances.mock.calls.length);
  });

  it("lets the real deadline timer fire during a long check, with the deadline's wording", async () => {
    const controller = new AbortController();
    const reason = new Error("reading it took longer than 30 seconds.");
    const timer = setTimeout(() => controller.abort(reason), 30);
    await expect(prepareDroppedImage("big.png", zeroPng(8000, 8000), decoders, { signal: controller.signal })).rejects.toBe(reason);
    clearTimeout(timer);
  });

  it("settles a pause at once when the signal aborts during it, and closes the channel", async () => {
    const closeSpy = vi.spyOn(MessagePort.prototype, "close");
    const controller = new AbortController();
    const reason = new Error("reading it took longer than 30 seconds.");
    const turns = new EventLoopTurns(controller.signal);
    await turns.pause();
    // From here the messages never come, as in a hidden window: only the abort can settle the pause.
    const posts = vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(() => undefined);
    const paused = turns.pause();
    controller.abort(reason);
    await expect(paused).rejects.toBe(reason);
    expect(posts).toHaveBeenCalledTimes(1);
    await expect(turns.pause()).rejects.toBe(reason);
    turns.close();
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });

  it("closes its channel at the end of every check: passed, refused, aborted", async () => {
    pauseAtEveryChance();
    const closeSpy = vi.spyOn(MessagePort.prototype, "close");
    const large = zeroPng(512, 256);
    expect(await pngImageDataError(large)).toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(2);
    const damaged = zeroPng(512, 256, 0, swapLastAdler);
    expect(await pngImageDataError(damaged)).toBe(DAMAGED_PNG_IMAGE_DATA);
    expect(closeSpy).toHaveBeenCalledTimes(4);
    const controller = new AbortController();
    const reason = new Error("reading it took longer than 30 seconds.");
    abortDuringPause(controller, reason, 3, false);
    await expect(pngImageDataError(large, { signal: controller.signal })).rejects.toBe(reason);
    expect(closeSpy).toHaveBeenCalledTimes(6);
  });

  it("runs several checks at once, each on its own channel", async () => {
    pauseAtEveryChance();
    const posts = vi.spyOn(MessagePort.prototype, "postMessage");
    const results = await Promise.all([zeroPng(512, 256), zeroPng(256, 512), zeroPng(512, 128, 0, swapLastAdler)].map(png => pngImageDataError(png)));
    expect(results).toEqual([undefined, undefined, DAMAGED_PNG_IMAGE_DATA]);
    expect(new Set(posts.mock.instances).size).toBe(3);
  });

  it("reports an abort as the deadline wherever it lands, never as damage", async () => {
    const reason = new Error("reading it took longer than 30 seconds.");
    // Before the first turn: a check too small to pause, aborted as it starts.
    const small = new AbortController();
    const smallCheck = pngImageDataError(testPng({ width: 64, height: 64, colourType: 6 }), { signal: small.signal });
    small.abort(reason);
    await expect(smallCheck).rejects.toBe(reason);
    // Mid-CRC (4 MiB of IDAT, CRC'd in 1 MiB pieces, then a bad IEND CRC) and mid-inflate (512 KiB of
    // output, 32 KiB at a time, then a bad Adler-32). Each check pauses at every chance, so the
    // abort is put at every one of them in turn, counted rather than timed: whatever the machine's speed.
    const badCrc = zeroPng(64, 64, 0, stream => concat(stream, new Uint8Array(4 * 1024 * 1024)));
    badCrc[badCrc.length - 1] ^= 1;
    const badAdler = zeroPng(512, 256, 0, swapLastAdler);
    for (const [label, png, least] of [["bad CRC", badCrc, 4], ["bad Adler-32", badAdler, 16]] as const) {
      steppingClock();
      const asked = pauseAtEveryChance();
      const posted = vi.spyOn(MessagePort.prototype, "postMessage");
      expect(await pngImageDataError(png), label).toBe(DAMAGED_PNG_IMAGE_DATA);
      const chances = asked.mock.calls.length;
      expect(chances, `${label}: chances to pause`).toBeGreaterThanOrEqual(least);
      expect(posted, `${label}: a pause at each`).toHaveBeenCalledTimes(chances);
      vi.restoreAllMocks();
      for (let at = 1; at <= chances; at += 1) {
        // Between turns: the deadline passes as chance `at` is asked about, and no turn is due then.
        // The next pause must refuse to start; after the last chance, nothing pauses again, and the
        // finished check must still report the deadline rather than the damage it found.
        steppingClock();
        const between = new AbortController();
        let asks = 0;
        vi.spyOn(EventLoopTurns.prototype, "due").mockImplementation(() => {
          if (++asks !== at) return true;
          between.abort(reason);
          return false;
        });
        const betweenPosts = vi.spyOn(MessagePort.prototype, "postMessage");
        await expect(pngImageDataError(png, { signal: between.signal }), `${label}, abort at chance ${at}`).rejects.toBe(reason);
        expect(betweenPosts, `${label}, abort at chance ${at}: no pause after it`).toHaveBeenCalledTimes(at - 1);
        vi.restoreAllMocks();
        // During pause `at`, whose message never comes: the abort alone must settle it.
        steppingClock();
        pauseAtEveryChance();
        const during = new AbortController();
        const duringPosts = abortDuringPause(during, reason, at, false);
        await expect(pngImageDataError(png, { signal: during.signal }), `${label}, abort in pause ${at}`).rejects.toBe(reason);
        expect(duringPosts, `${label}, abort in pause ${at}: none after it`).toHaveBeenCalledTimes(at);
        vi.restoreAllMocks();
      }
    }
  });

  it("needs nothing from the webview: the same verdicts where it has no DecompressionStream (macOS 11)", async () => {
    vi.stubGlobal("DecompressionStream", undefined);
    await expectKept("good", testPng({ width: 13, height: 7, colourType: 6, interlace: true }));
    await expectRefused("r8-damaged.png", damagedDropFixture("r8-damaged.png"));
    await expectRefused("r9-midcorrupt.png", damagedDropFixture("r9-midcorrupt.png"));
  });
});

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(first.length + second.length);
  out.set(first);
  out.set(second, first.length);
  return out;
}

/** The zlib stream of a PNG with a single IDAT. */
function testPngStream(png: Uint8Array): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let offset = 8; offset < png.length;) {
    const length = view.getUint32(offset);
    if (String.fromCharCode(...png.subarray(offset + 4, offset + 8)) === "IDAT") return png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
  }
  throw new Error("no IDAT");
}
