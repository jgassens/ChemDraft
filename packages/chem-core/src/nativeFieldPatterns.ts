import { z } from "zod";
import { ownNativeValue } from "./nativeCompatibilityState";

// The same paths as field: schema-inventory tokens, without the prefix. A star matches
// one array element only, never an arbitrary field or a subtree. Discriminators are optional.
const segmentPattern = /^(\*|\d+|[A-Za-z_$][\w$-]*)(?:\[([A-Za-z_$][\w$-]*)=([\w$-]+)\])?$/;

export const NativeFieldPatternSchema = z.string().refine((pattern) => {
  const segments = pattern.split(".");
  return segments.every((segment) => segmentPattern.test(segment) && !/^\d/.test(segment))
    && !segments[0]!.startsWith("*") && !segments.at(-1)!.startsWith("*");
}, "Expected a dot-separated field path, with * for array elements and optional [key=value] discriminators.");

function segments(pattern: string) {
  return pattern.split(".").map((segment) => {
    const [, key, discriminator, variant] = segmentPattern.exec(segment)!;
    return { key: key!, discriminator, variant };
  });
}

/** Values actually present at a field pattern. Undefined/absent fields are not used. */
export function nativeFieldPatternValues(root: unknown, pattern: string): unknown[] {
  let values = [root];
  for (const { key, discriminator, variant } of segments(pattern)) {
    values = values.flatMap((value) => key === "*" ? Array.isArray(value) ? value : [] : [ownNativeValue(value, key)])
      .filter((value) => value !== undefined && (!discriminator || ownNativeValue(value, discriminator) === variant));
  }
  return values;
}

/** Match one concrete Zod issue path, retaining runtime discriminators and array boundaries. */
export function nativeFieldPatternMatches(root: unknown, path: (string | number)[], pattern: string): boolean {
  const parts = segments(pattern);
  if (parts.length !== path.length) return false;
  let value = root;
  return parts.every(({ key, discriminator, variant }, index) => {
    const actual = path[index]!;
    if (key === "*" ? !Array.isArray(value) || typeof actual !== "number" : key !== actual) return false;
    value = ownNativeValue(value, actual);
    return !discriminator || ownNativeValue(value, discriminator) === variant;
  });
}

/** Could a header pattern name this known schema field, even with omitted discriminators? */
export function nativeFieldPatternsOverlap(left: string, right: string): boolean {
  const a = segments(left);
  const b = segments(right);
  return a.length === b.length && a.every((part, index) => {
    const other = b[index]!;
    return (part.key === other.key || part.key === "*" && /^\d+$/.test(other.key)) && (!part.discriminator || !other.discriminator
      || part.discriminator !== other.discriminator || part.variant === other.variant);
  });
}
