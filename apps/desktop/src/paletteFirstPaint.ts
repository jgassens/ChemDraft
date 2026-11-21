import { ackFirstPaint } from "./firstPaint";

// Palettes, their popovers and the palette tooltip report their first paint (firstPaint.ts). On
// Windows a palette is built hidden and shown by that report (src-tauri/src/palette_first_paint.rs);
// popovers and the tooltip keep their own reveal, so for them, and on macOS and Linux, the host
// ignores it.

let acknowledged = false;

/** Sends this page's first-paint acknowledgement once, however often React runs the effect. */
export function acknowledgeFirstPaintOnce(ack: () => Promise<void> = ackFirstPaint): void {
  if (acknowledged) return;
  acknowledged = true;
  void ack();
}
