/**
 * Prove a PNG's image data is intact before it becomes a picture. Engines draw a damaged PNG rather
 * than refuse it: WebKit's `createImageBitmap` and `Image.decode` both resolve for image data that
 * cannot be inflated (the picture is invisible) and for data that inflates to the wrong bytes (half of
 * it is black), so the webview decoder proves nothing here. This walks the chunks, checks the critical
 * CRCs and header values, then inflates the image data once with its own checking inflater
 * (`zlibCheck.ts`, the same in every webview), without keeping it, to check its size, every row's
 * filter byte and the zlib Adler-32. Pixels are never reconstructed. Both passes give the event loop a
 * turn every ~12 ms, so a large picture does not freeze the window, and stop at the file's deadline,
 * which is always reported as the deadline, never as damage.
 */

import { crc32 } from "../crc32";
import { abortReason } from "./rasterDecode";
import { checkZlibStream, type ZlibInput, type ZlibYielder } from "./zlibCheck";

/** The clause after "could not be decoded: ". */
export const DAMAGED_PNG_IMAGE_DATA = "its image data is damaged.";

/** Some encoders write a little more image data than the picture uses; decoders ignore it. */
export const PNG_SURPLUS_IMAGE_DATA_BYTES = 64 * 1024;

export interface PngIntegrityOptions {
  signal?: AbortSignal;
}

/** Work this long, then give the event loop a turn. */
const TURN_MS = 12;
/** A chunk longer than this has its CRC computed in pieces this long, with a turn between when due. */
const CRC_PIECE = 1024 * 1024;
/** How often a turn also lets timers run, and how long it waits for them at most. */
const TIMER_TURN_EVERY_MS = 100;
const TIMER_TURN_WAIT_MS = 16;
/** Chunks walked between looks at the clock. */
const CHUNKS_PER_CLOCK = 1024;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Bit depths each colour type allows. */
const BIT_DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** Adam7: x start, y start, x step, y step. */
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;

const TYPE_IHDR = 0x49484452;
const TYPE_PLTE = 0x504c5445;
const TYPE_IDAT = 0x49444154;
const TYPE_IEND = 0x49454e44;

interface PngLayout {
  /** Where the first IDAT chunk starts; the rest follow it, since IDATs must be consecutive. */
  firstData: number;
  /** Rows as the decoder reads them: a row count and a stride (filter byte included) per pass. */
  passes: { rows: number; stride: number }[];
  expectedSize: number;
}

/**
 * A macrotask turn for the event loop (a resolved promise would only let microtasks run) once about
 * `TURN_MS` of work have passed since the last, then the deadline. A small PNG never waits for one.
 * Turns are MessageChannel messages: a hidden or covered webview slows `setTimeout(0)` to about one
 * a second, which would stretch a large check past the file's deadline, but not messages. Messages
 * alone can starve timers and painting in some engines, so every `TIMER_TURN_EVERY_MS` a turn also
 * waits for a `setTimeout(0)`, for at most `TIMER_TURN_WAIT_MS` (it is slow only where hidden). Where
 * there is no MessageChannel, every turn is a `setTimeout(0)`. `close()` must end every check.
 */
export class EventLoopTurns implements ZlibYielder {
  private last = performance.now();
  private lastTimerTurn = Number.NEGATIVE_INFINITY;
  private channel: MessageChannel | undefined;
  private delivered: (() => void) | undefined;

  constructor(private readonly signal: AbortSignal | undefined) {}

  due(): boolean {
    return performance.now() - this.last >= TURN_MS;
  }

  async pause(): Promise<void> {
    if (this.signal?.aborted) throw abortReason(this.signal);
    if (typeof MessageChannel === "undefined") {
      await this.untilAborted(resolve => {
        const timer = setTimeout(resolve, 0);
        return () => clearTimeout(timer);
      });
    } else if (performance.now() - this.lastTimerTurn >= TIMER_TURN_EVERY_MS) {
      await this.timerTurn();
      this.lastTimerTurn = performance.now();
    } else {
      await this.message();
    }
    this.last = performance.now();
  }

  /** Closes the channel; the check is over. */
  close(): void {
    this.channel?.port1.close();
    this.channel?.port2.close();
    this.channel = undefined;
    this.delivered = undefined;
  }

  /** Messages until a `setTimeout(0)` has run or `TIMER_TURN_WAIT_MS` have passed. */
  private async timerTurn(): Promise<void> {
    let fired = false;
    const timer = setTimeout(() => { fired = true; }, 0);
    const start = performance.now();
    try {
      do await this.message(); while (!fired && performance.now() - start < TIMER_TURN_WAIT_MS);
    } finally {
      clearTimeout(timer);
    }
  }

  private message(): Promise<void> {
    if (!this.channel) {
      this.channel = new MessageChannel();
      this.channel.port1.onmessage = () => {
        const delivered = this.delivered;
        this.delivered = undefined;
        delivered?.();
      };
    }
    const channel = this.channel;
    return this.untilAborted(resolve => {
      this.delivered = resolve;
      channel.port2.postMessage(undefined);
      return () => { if (this.delivered === resolve) this.delivered = undefined; };
    });
  }

  /** Waits for `start`'s callback; rejects with the abort reason as soon as the signal aborts. */
  private untilAborted(start: (resolve: () => void) => () => void): Promise<void> {
    const { signal } = this;
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cancel();
        reject(abortReason(signal!));
      };
      const cancel = start(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    }).then(() => {
      if (this.signal?.aborted) throw abortReason(this.signal);
    });
  }
}

/** Rows of `width` pixels: a filter byte, then the pixels packed into whole bytes. */
function rowStride(width: number, bitsPerPixel: number): number {
  return 1 + Math.ceil(width * bitsPerPixel / 8);
}

/** CRC-32 of `bytes[start, end)`, in pieces with turns between when it is long. */
async function chunkCrc(bytes: Uint8Array, start: number, end: number, turns: EventLoopTurns): Promise<number> {
  let crc = 0;
  for (let at = start; at < end; at += CRC_PIECE) {
    crc = crc32(bytes.subarray(at, Math.min(end, at + CRC_PIECE)), crc);
    if (turns.due()) await turns.pause();
  }
  return crc;
}

/** The chunks, critical CRCs and header; undefined when any of them is damaged. */
async function readPngLayout(bytes: Uint8Array, turns: EventLoopTurns): Promise<PngLayout | undefined> {
  if (bytes.length < 8 || !SIGNATURE.every((value, index) => bytes[index] === value)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let firstData = -1;
  let header: { width: number; height: number; colourType: number; bitDepth: number; interlaced: boolean } | undefined;
  let palette = false;
  let inData = false;
  let afterData = false;
  // Bytes CRC'd since the clock was last looked at for them: the clock is looked at before a chunk
  // that would take them past `CRC_PIECE`, so many chunks just under it cannot run without a turn.
  let crcBytes = 0;
  for (let offset = 8, chunks = 1; ; chunks += 1) {
    if (offset + 12 > bytes.length) return undefined;
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return undefined;
    const type = view.getUint32(offset + 4);
    const body = offset + 8;
    const end = body + length;
    // Decoders ignore a bad CRC on an ancillary chunk, so only the critical ones are checked.
    const critical = type === TYPE_IHDR || type === TYPE_PLTE || type === TYPE_IDAT || type === TYPE_IEND;
    if (critical) {
      if (length <= CRC_PIECE && (crcBytes += length) > CRC_PIECE) {
        crcBytes = length;
        if (turns.due()) await turns.pause();
      }
      const crc = length > CRC_PIECE ? await chunkCrc(bytes, offset + 4, end, turns) : crc32(bytes.subarray(offset + 4, end));
      if (crc !== view.getUint32(end)) return undefined;
    }
    if (chunks % CHUNKS_PER_CLOCK === 0 && turns.due()) await turns.pause();
    if ((offset === 8) !== (type === TYPE_IHDR)) return undefined;
    if (type !== TYPE_IDAT && inData) { inData = false; afterData = true; }
    if (type === TYPE_IHDR) {
      if (length !== 13) return undefined;
      const width = view.getUint32(body);
      const height = view.getUint32(body + 4);
      const bitDepth = bytes[body + 8];
      const colourType = bytes[body + 9];
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) return undefined;
      if (!BIT_DEPTHS[colourType]?.includes(bitDepth)) return undefined;
      // Compression and filter method 0; interlace none or Adam7.
      if (bytes[body + 10] !== 0 || bytes[body + 11] !== 0 || bytes[body + 12] > 1) return undefined;
      header = { width, height, colourType, bitDepth, interlaced: bytes[body + 12] === 1 };
    } else if (type === TYPE_PLTE) {
      if (palette || inData || afterData) return undefined;
      if (header?.colourType === 3 && (length === 0 || length % 3 !== 0 || length > 3 * 256)) return undefined;
      palette = true;
    } else if (type === TYPE_IDAT) {
      if (afterData) return undefined;
      if (!inData) firstData = offset;
      inData = true;
    } else if (type === TYPE_IEND) {
      // Whatever follows IEND is not part of the picture.
      break;
    }
    offset = end + 4;
  }
  if (!header || firstData < 0 || (header.colourType === 3 && !palette)) return undefined;
  const bitsPerPixel = CHANNELS[header.colourType] * header.bitDepth;
  const passes = header.interlaced
    ? ADAM7.map(([x, y, stepX, stepY]) => ({ columns: Math.ceil((header.width - x) / stepX), rows: Math.ceil((header.height - y) / stepY) }))
      // A pass with no pixels has no rows at all, not even filter bytes.
      .filter(pass => pass.columns > 0 && pass.rows > 0)
      .map(pass => ({ rows: pass.rows, stride: rowStride(pass.columns, bitsPerPixel) }))
    : [{ rows: header.height, stride: rowStride(header.width, bitsPerPixel) }];
  return { firstData, passes, expectedSize: passes.reduce((total, pass) => total + pass.rows * pass.stride, 0) };
}

/** The IDAT data in order, walked again from the first IDAT (already checked) to the chunk after the last. */
function imageDataInput(bytes: Uint8Array, firstData: number): ZlibInput {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = firstData;
  return () => {
    // Empty IDATs (up to ~1.7 million in a 20 MB file, already walked with turns) are passed over
    // here without making a view of each: a run of them is a few milliseconds of reads.
    for (;;) {
      if (view.getUint32(offset + 4) !== TYPE_IDAT) return undefined;
      const body = offset + 8;
      const end = body + view.getUint32(offset);
      offset = end + 4;
      if (end > body) return bytes.subarray(body, end);
    }
  };
}

/** False at the first row whose filter byte is not 0-4, pass by pass; surplus after the last row is not read. */
function filterByteCheck(passes: PngLayout["passes"]): (block: Uint8Array, offset: number) => boolean {
  let pass = 0;
  let rowsLeft = passes[0]?.rows ?? 0;
  /** Where the next row's filter byte is, in the whole output. */
  let rowStart = 0;
  return (block, offset) => {
    const blockEnd = offset + block.length;
    while (pass < passes.length && rowStart < blockEnd) {
      if (block[rowStart - offset] > 4) return false;
      rowStart += passes[pass].stride;
      if (--rowsLeft === 0) {
        pass += 1;
        rowsLeft = passes[pass]?.rows ?? 0;
      }
    }
    return true;
  };
}

/**
 * Why the PNG's image data cannot be drawn as it stands (the clause after "could not be decoded: "),
 * or undefined when it is intact: the zlib stream is whole and as strict as zlib reads it, at least
 * the picture's size and no more than 64 KiB over it, and every row starts with a filter byte of 0-4.
 * Bytes after the stream's end are ignored, as decoders ignore them. Rejects only when
 * `options.signal` aborts, with its reason.
 */
export async function pngImageDataError(bytes: Uint8Array, options: PngIntegrityOptions = {}): Promise<string | undefined> {
  const { signal } = options;
  if (signal?.aborted) throw abortReason(signal);
  const turns = new EventLoopTurns(signal);
  try {
    const layout = await readPngLayout(bytes, turns);
    // A check the deadline stopped proves nothing about the image data: its reason, never "damaged".
    if (signal?.aborted) throw abortReason(signal);
    if (!layout) return DAMAGED_PNG_IMAGE_DATA;
    const result = await checkZlibStream(imageDataInput(bytes, layout.firstData), {
      maxOutput: layout.expectedSize + PNG_SURPLUS_IMAGE_DATA_BYTES,
      output: filterByteCheck(layout.passes),
      yielder: turns
    });
    if (signal?.aborted) throw abortReason(signal);
    return result.ok && result.outputBytes >= layout.expectedSize ? undefined : DAMAGED_PNG_IMAGE_DATA;
  } finally {
    turns.close();
  }
}
