import { isNetworkDownloadFailure, redactUrls } from "../plugins/pluginUpdates";

/** Native download diagnostics are host-only; still redact at the display boundary. */
export function engineNetworkErrorMessage(message: string | undefined, engine: "recognition" | "naming"): string {
  return message && isNetworkDownloadFailure(message)
    ? redactUrls(message)
    : `The ${engine} engine could not be downloaded. Check your connection and try again.`;
}

/** Decimal gigabytes (10⁹ bytes), consistently to one decimal place. */
function formatGigabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0.0 GB";
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** Whether the disk has less room than the install needs while it runs (0 means unknown). */
export function isShortOfSpace(requiredBytes: number, freeBytes: number): boolean {
  return requiredBytes > 0 && freeBytes < requiredBytes;
}

/** Space needed while installing and the free space available now. */
export function installSpaceStatement(requiredBytes: number, freeBytes: number): string {
  const needs = `Needs about ${formatGigabytes(requiredBytes)} free while installing`;
  return isShortOfSpace(requiredBytes, freeBytes)
    ? `${needs}; only ${formatGigabytes(freeBytes)} is free.`
    : `${needs}. Free now: ${formatGigabytes(freeBytes)}.`;
}
