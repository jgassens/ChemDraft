export const stableIsoDate = "2026-05-29T00:00:00.000Z";

export function unreachable(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
