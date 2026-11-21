import { z } from "zod";

export type ObjectLink = readonly [objectId: string, ...qualifiers: (string | undefined)[]];
type ReadLinks = (value: unknown) => readonly ObjectLink[];
const referenceFields = new WeakMap<z.ZodTypeAny, ReadLinks>();

/** Declare a live page-object reference alongside its native schema. Qualifiers distinguish
 * uses of the same object ID, such as reaction roles or anchors on different atoms. */
export function objectReferenceField<S extends z.ZodTypeAny>(schema: S,
  read: (value: z.output<S>) => readonly ObjectLink[]): S {
  referenceFields.set(schema, value => value == null ? [] : read(value as z.output<S>));
  return schema;
}

type CompareFields = (before: unknown, after: unknown, check: (id: string) => void) => void;
type ReferenceFields = { read: ReadLinks } | { compare: CompareFields };

function compareLinks(read: ReadLinks): CompareFields {
  return (before, after, check) => {
    if (before === after) return;
    const previous = read(before), next = read(after);
    if (next.length === previous.length && next.every((link, index) => {
      const old = previous[index]!;
      return link.length === old.length && link.every((value, part) => value === old[part]);
    })) return;
    next.forEach(([id]) => check(id));
  };
}

function compareFields(fields: ReferenceFields): CompareFields {
  return "read" in fields ? compareLinks(fields.read) : fields.compare;
}

/** Compile a schema into a walk of just its reference-bearing fields. Arrays of reference
 * records (such as reaction components) are one field. Ordinary arrays of nested objects
 * (such as superatoms) contain independently checked fields. */
function referenceFieldsOf(schema: z.ZodTypeAny): ReferenceFields | undefined {
  const read = referenceFields.get(schema);
  if (read && !(schema instanceof z.ZodObject)) return { read };
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return referenceFieldsOf(schema.unwrap());
  if (schema instanceof z.ZodDefault) return referenceFieldsOf(schema.removeDefault());
  if (schema instanceof z.ZodEffects) return referenceFieldsOf(schema.innerType());
  if (schema instanceof z.ZodArray) {
    const element = referenceFieldsOf(schema.element);
    if (!element) return undefined;
    if ("read" in element) return { read: value => Array.isArray(value) ? value.flatMap(element.read) : [] };
    return { compare: (before, after, check) => {
      if (before === after || !Array.isArray(after)) return;
      after.forEach((item, index) => element.compare(Array.isArray(before) ? before[index] : undefined, item, check));
    } };
  }
  if (schema instanceof z.ZodObject) {
    const fields = Object.entries(schema.shape as z.ZodRawShape).flatMap(([key, child]) => {
      const field = referenceFieldsOf(child);
      return field ? [{ key, compare: compareFields(field) }] : [];
    });
    if (!fields.length) return read && { read };
    const compareOwn = read && compareLinks(read);
    return { compare: (before, after, check) => {
      if (before === after || !after) return;
      const previous = before as Record<string, unknown> | undefined;
      const next = after as Record<string, unknown>;
      compareOwn?.(previous, next, check);
      fields.forEach(({ key, compare }) => compare(previous?.[key], next[key], check));
    } };
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const variants = new Map<unknown, CompareFields>([...schema.optionsMap].flatMap(([tag, option]) => {
      const fields = referenceFieldsOf(option);
      return fields ? [[tag, compareFields(fields)] as const] : [];
    }));
    return { compare: (before, after, check) => {
      const tag = (after as Record<string, unknown> | undefined)?.[schema.discriminator];
      const previousTag = (before as Record<string, unknown> | undefined)?.[schema.discriminator];
      variants.get(tag)?.(tag === previousTag ? before : undefined, after, check);
    } };
  }
  return undefined;
}

export function compileObjectReferenceCheck(schema: z.ZodTypeAny): CompareFields {
  const fields = referenceFieldsOf(schema);
  if (!fields) throw new Error("The native schema must declare object reference fields.");
  return compareFields(fields);
}
