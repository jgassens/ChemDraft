import { RequestWriteError } from "./requestWrites";

// Leave room below the 8 MiB result ceiling for response framing and other fields.
const SNAPSHOT_LIMIT_MIB = 4;

/** Charge a complete JSON value and any framing bytes while building a request snapshot. */
export type RequestSnapshotBudget = (value: unknown, framingBytes?: number) => void;

/** Count compact UTF-8 JSON without making a copy. */
export function createRequestSnapshotBudget(): RequestSnapshotBudget {
  let remaining = SNAPSHOT_LIMIT_MIB * 1024 * 1024;
  const ancestors = new Set<object>();
  const invalid = () => new RequestWriteError("invalid", "The request snapshot must contain acyclic JSON data.");
  const charge = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) {
      throw new RequestWriteError("limit",
        `Request snapshots are limited to ${SNAPSHOT_LIMIT_MIB} MiB. Use documents.readRequest to paginate the document.`);
    }
  };
  const chargeString = (value: string) => {
    // Charge one byte per UTF-16 code unit first so huge values fail without scanning or encoding.
    charge(value.length + 2);
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit < 0x20) {
        charge(unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13 ? 1 : 5);
      } else if (unit === 0x22 || unit === 0x5c || (unit >= 0x80 && unit < 0x800)) {
        charge(1);
      } else if (unit >= 0xd800 && unit <= 0xdfff) {
        const next = value.charCodeAt(i + 1);
        if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          charge(2);
          i++;
        } else {
          charge(5); // JSON escapes a lone surrogate.
        }
      } else if (unit >= 0x800) {
        charge(2);
      }
    }
  };
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      chargeString(value);
    } else if (value === null || value === undefined) {
      charge(4); // Undefined array entries serialize as null. Object fields are omitted below.
    } else if (typeof value === "boolean") {
      charge(value ? 4 : 5);
    } else if (typeof value === "number") {
      charge(Number.isFinite(value) ? String(value).length : 4);
    } else if (typeof value === "object") {
      if (ancestors.has(value)) throw invalid();
      ancestors.add(value);
      charge(2);
      if (Array.isArray(value)) {
        charge(Math.max(0, value.length - 1));
        for (let i = 0; i < value.length; i++) visit(value[i]);
      } else {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) throw invalid();
        const record = value as Record<string, unknown>;
        let first = true;
        for (const key in record) {
          if (!Object.hasOwn(record, key)) continue;
          const field = record[key];
          if (field === undefined) continue;
          charge(first ? 1 : 2);
          first = false;
          chargeString(key);
          visit(field);
        }
      }
      ancestors.delete(value);
    } else {
      throw invalid();
    }
  };
  return (value, framingBytes = 0) => {
    charge(framingBytes);
    if (value !== undefined) visit(value);
  };
}

export function assertRequestSnapshotSize(snapshot: unknown): void {
  createRequestSnapshotBudget()(snapshot);
}
