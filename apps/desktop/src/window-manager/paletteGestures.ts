// Epoch microseconds from the monotonic browser clock are comparable across the two webviews.
// Stamp both control lifetimes and pointer presses: a close can fence an unseen sender, and a
// failed Esc round trip can fence unseen presses without rejecting the user's next drag.
const clock = () => Math.floor((performance.timeOrigin + performance.now()) * 1000);
let sequence = Math.floor(performance.timeOrigin * 1000);
let latestGestureId: string | undefined;
const nextOrdinal = () => (sequence = Math.max(sequence + 1, clock()));
export function nextPaletteGestureGeneration(): number { return nextOrdinal(); }
export function nextPaletteGestureId(generation?: number): string {
  latestGestureId = `wave:${nextOrdinal()}${generation ? `:${generation}` : ""}`;
  return latestGestureId;
}
export function latestPaletteGestureId(): string | undefined { return latestGestureId; }

export const PALETTE_GESTURE_CANCEL_REQUEST = "palette.wave.cancel-request:";
export const PALETTE_GESTURE_CANCEL_ACK = "palette.wave.cancel-ack:";
export const PALETTE_GESTURE_CANCEL_TIMEOUT_MS = 1_000;
type Phase = "preview" | "commit";
const ordinal = (id?: string) => id?.startsWith("wave:") ? Number(id.split(":")[1]) : 0;

/** Expired requests and requests sent to a destroyed generation cannot disarm a replacement. */
export function paletteGestureCancellationApplies(commandId: string, generation: number): boolean {
  const [, deadline, throughGeneration] = commandId.slice(PALETTE_GESTURE_CANCEL_REQUEST.length).split(":");
  return (!deadline || clock() < Number(deadline)) && (!throughGeneration || generation <= Number(throughGeneration));
}

/** Document-side ownership, terminal watermark and an Esc round trip. Constant space, per toolbar. */
export class PaletteGestureReceiver {
  private watermark = 0;
  private terminal = false;
  private barrier = 0;
  private closedGeneration = 0;
  private waiting: { token: string; timer: ReturnType<typeof setTimeout>; failed: (discarded: boolean) => void } | undefined;
  // While Esc crosses to the toolbar, retain only the newest drag's latest preview and release.
  private pending: { id: string; preview?: () => void; commit?: () => void } | undefined;

  beginCancellation(failed: (discarded: boolean) => void = () => undefined): string {
    this.clearWait();
    const now = clock();
    const token = `${++this.barrier}:${now + PALETTE_GESTURE_CANCEL_TIMEOUT_MS * 1000}:${now}`;
    const request = `${PALETTE_GESTURE_CANCEL_REQUEST}${token}`;
    const timer = setTimeout(() => this.failCancellation(request), PALETTE_GESTURE_CANCEL_TIMEOUT_MS);
    this.waiting = { token, timer, failed };
    return request;
  }

  private clearWait(): void {
    if (this.waiting) clearTimeout(this.waiting.timer);
    this.waiting = undefined;
  }

  /** No reply can be required of a destroyed window. Drop its buffered work and fence its lifetime. */
  senderClosed(): void {
    this.closedGeneration = Math.max(this.closedGeneration, clock());
    this.discardPending();
    this.clearWait();
  }

  private discardPending(): void {
    this.retire(`wave:${clock()}`);
    this.retire(this.pending?.id);
    this.pending = undefined;
  }

  /** A missing/failed reply cancels all presses up to recovery, including unseen queued messages. */
  private failCancellation(request: string): void {
    if (!this.waiting || request !== `${PALETTE_GESTURE_CANCEL_REQUEST}${this.waiting.token}`) return;
    const failed = this.waiting.failed;
    const discarded = Boolean(this.pending);
    this.discardPending();
    this.clearWait();
    failed(discarded);
  }

  dispose(): void {
    this.clearWait();
    this.pending = undefined;
  }

  acknowledge(commandId: string, throughId?: string): boolean {
    if (!commandId.startsWith(PALETTE_GESTURE_CANCEL_ACK)) return false;
    if (!this.waiting || commandId.slice(PALETTE_GESTURE_CANCEL_ACK.length) !== this.waiting.token) return true;
    this.retire(throughId);
    this.clearWait();
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      if (pending.preview) this.receive("preview", pending.id, pending.preview);
      if (pending.commit) this.receive("commit", pending.id, pending.commit);
    }
    return true;
  }

  retire(id?: string): void {
    const value = ordinal(id);
    if (Number.isSafeInteger(value) && value >= this.watermark && value > 0) {
      this.watermark = value;
      this.terminal = true;
    }
  }

  receive(phase: Phase, id: string | undefined, apply: () => void): void {
    if (!id) { apply(); return; }
    const value = ordinal(id);
    if (!Number.isSafeInteger(value) || value <= 0) return;
    const generation = Number(id.split(":")[2]);
    if (generation > 0 && generation <= this.closedGeneration) return;
    if (value < this.watermark || (value === this.watermark && this.terminal)) return;
    if (this.waiting) {
      if (!this.pending || value > ordinal(this.pending.id)) this.pending = { id };
      if (this.pending.id === id) this.pending[phase] = apply;
      return;
    }
    this.watermark = value;
    this.terminal = phase !== "preview";
    apply();
  }
}
