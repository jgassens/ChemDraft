import { CliUsageError } from "./output";

export interface OptionDefinition {
  kind: "value" | "boolean";
  repeated?: boolean;
}

export type OptionDefinitions = Readonly<Record<string, OptionDefinition>>;
export type ParsedOptionValue = string | readonly string[] | boolean;

export interface ParsedOptions {
  options: Readonly<Record<string, ParsedOptionValue>>;
  positionals: readonly string[];
}

/**
 * Parse long options without dependencies. Value flags consume one following token, boolean flags
 * become `true`, and definitions marked `repeated` collect their values in encounter order.
 */
export function parseOptions(
  argv: readonly string[],
  definitions: OptionDefinitions
): ParsedOptions {
  const options: Record<string, ParsedOptionValue> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!flag.startsWith("--")) {
      positionals.push(flag);
      continue;
    }

    const definition = definitions[flag];
    if (!definition) throw new CliUsageError(`Unknown argument "${flag}".`);
    if (definition.kind === "boolean") {
      options[flag] = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`${flag} requires a value.`);
    }
    index += 1;
    if (definition.repeated) {
      const previous = options[flag];
      options[flag] = previous === undefined
        ? [value]
        : [...previous as readonly string[], value];
    } else {
      options[flag] = value;
    }
  }

  return { options, positionals };
}

/** Read a single value option from a parsed option record. */
export function stringOption(parsed: ParsedOptions, flag: string): string | undefined {
  const value = parsed.options[flag];
  return typeof value === "string" ? value : undefined;
}

/** Read a boolean option from a parsed option record. */
export function booleanOption(parsed: ParsedOptions, flag: string): boolean {
  return parsed.options[flag] === true;
}

/** Read all values supplied for a repeated value option. */
export function repeatedOption(parsed: ParsedOptions, flag: string): readonly string[] {
  const value = parsed.options[flag];
  return Array.isArray(value) ? value : [];
}

/** Parse a finite CLI number, optionally allowing zero. */
export function numericOption(
  value: string | undefined,
  flag: string,
  allowZero = false
): number {
  if (value === undefined) throw new CliUsageError(`${flag} requires a value.`);
  // `Number` accepts JavaScript syntax (hexadecimal, exponents, whitespace, and even an empty
  // string). CLI numeric flags deliberately accept only ordinary unsigned decimal notation.
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
    throw new CliUsageError(
      allowZero
        ? `${flag} must be a finite, non-negative number.`
        : `${flag} must be a finite number greater than zero.`
    );
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new CliUsageError(
      allowZero
        ? `${flag} must be a finite, non-negative number.`
        : `${flag} must be a finite number greater than zero.`
    );
  }
  return parsed;
}

/** Parse a positive integer CLI option. */
export function integerOption(value: string | undefined, flag: string): number {
  const parsed = numericOption(value, flag);
  if (!Number.isInteger(parsed)) throw new CliUsageError(`${flag} must be a positive integer.`);
  return parsed;
}
