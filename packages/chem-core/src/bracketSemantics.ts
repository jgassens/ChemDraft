import type { BracketObject } from "./schemas";
import { isNativeRecord } from "./nativeCompatibilityState";

const cdxmlNames = { sru: "SRU", multiple: "MultipleGroup" } as const;

/** Classify the source name after interchange resolves the group and glyph declarations. */
export function importedBracketUsage(cdxmlUsage: string | undefined) {
  return cdxmlUsage === undefined ? "generic" : cdxmlUsage === cdxmlNames.sru ? "sru" :
    cdxmlUsage === cdxmlNames.multiple ? "multiple" : "unknown";
}

/** Resolve legacy native usage values in page order. */
export function bracketPairUsage(pair: readonly BracketObject[]): NonNullable<BracketObject["bracketUsage"]> {
  return pair.find(object => object.bracketUsage && object.bracketUsage !== "generic")?.bracketUsage ??
    (pair.some(object => object.repeatUnit || object.bracketKind === "polymer") ? "sru" : "generic");
}

export function bracketUsageSemantics(pair: readonly BracketObject[], sourceUsage?: string) {
  const usage = bracketPairUsage(pair);
  const cdxmlUsage = usage === "unknown" ? sourceUsage ?? "Unspecified" :
    usage === "generic" ? undefined : cdxmlNames[usage];
  return { usage, cdxmlUsage };
}

export function bracketPairSemantics(pair: readonly BracketObject[]) {
  const closing = pair.find(object => object.side === "close")!;
  // Visible CDXML carries the closing glyph's retained group attribute verbatim.
  const group = closing.compatibility?.unknown.bracketedGroup;
  const attributes = isNativeRecord(group) ? group.attributes : undefined;
  const pattern = isNativeRecord(attributes) && Object.prototype.propertyIsEnumerable.call(attributes, "PolymerRepeatPattern")
    ? attributes.PolymerRepeatPattern : undefined;
  const cdxmlRepeatPattern = typeof pattern === "string" ? pattern : undefined;
  return { ...bracketUsageSemantics(pair), closing, label: closing.label ?? "n",
    count: pair.find(object => object.repeatCount !== undefined)?.repeatCount, cdxmlRepeatPattern };
}
