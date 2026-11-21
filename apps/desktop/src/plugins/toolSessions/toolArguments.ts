import type { PluginRequestJson, PluginToolInputSchema } from "@chemdraft/plugin-api";
import { RequestWriteError } from "@chemdraft/plugin-host";

function equalJson(left: PluginRequestJson, right: PluginRequestJson): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, i) => equalJson(value, right[i]!));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.hasOwn(right, key) && equalJson(left[key]!, right[key]!));
}

function within(value: number, low?: number, high?: number): boolean {
  return (low === undefined || value >= low) && (high === undefined || value <= high);
}

/** Both arguments have already crossed the bounded JSON boundary. */
export function validateToolArguments(schema: PluginToolInputSchema, value: PluginRequestJson, path = "arguments"): void {
  const fail = (detail: string): never => { throw new RequestWriteError("invalid", `${path}: ${detail}`); };
  if (schema.enum && !schema.enum.some(item => equalJson(item, value))) fail("value is outside the declared enum.");
  switch (schema.type) {
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("expected an object.");
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing required property "${key}".`);
      for (const [key, field] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) validateToolArguments(properties[key]!, field, `${path}.${key}`);
        else if (schema.additionalProperties === false) fail(`unknown property "${key}".`);
      }
      return;
    }
    case "array":
      if (!Array.isArray(value) || !within(value.length, schema.minItems, schema.maxItems)) return fail("invalid array or item count.");
      value.forEach((item, index) => validateToolArguments(schema.items, item, `${path}[${index}]`));
      return;
    case "string":
      if (typeof value !== "string") return fail("expected a string.");
      if (schema.minLength !== undefined || schema.maxLength !== undefined) {
        if (!within(Array.from(value).length, schema.minLength, schema.maxLength)) fail("invalid string length.");
      }
      return;
    case "integer":
    case "number":
      if (typeof value !== "number" || (schema.type === "integer" && !Number.isInteger(value)) ||
          !within(value, schema.minimum, schema.maximum)) fail(`expected a ${schema.type} within the declared bounds.`);
      return;
    case "boolean":
      if (typeof value !== "boolean") fail("expected a boolean.");
      return;
    case "null":
      if (value !== null) fail("expected null.");
  }
}
