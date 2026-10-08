import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillRoot = join(root, "skills", "chemdraft");
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n?/g, "\n");

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith(".md") ? [path] : [];
  });
}

function syntax(path: string): ts.SourceFile {
  return ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression {
  const entry = object.properties.find((candidate): candidate is ts.PropertyAssignment =>
    ts.isPropertyAssignment(candidate) &&
    (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) && candidate.name.text === name
  );
  if (!entry) throw new Error(`Source shape changed: missing ${name}`);
  return unwrap(entry.initializer);
}

/** Read the dispatch array, not filenames, help prose or a copied list. */
function commandSources(): Map<string, ts.SourceFile> {
  const directory = join(root, "packages", "chemdraft-cli", "src", "commands");
  const source = syntax(join(directory, "index.ts"));
  let table: ts.ArrayLiteralExpression | undefined;
  visit(source, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === "commands" && node.initializer) {
      const value = unwrap(node.initializer);
      if (!ts.isArrayLiteralExpression(value)) throw new Error("CLI dispatch is no longer a literal array");
      table = value;
    }
  });
  if (!table) throw new Error("CLI command table not found");
  const result = new Map<string, ts.SourceFile>();
  for (const element of table.elements) {
    if (!ts.isObjectLiteralExpression(element)) throw new Error("Unknown CLI dispatch entry shape");
    const name = property(element, "name");
    if (!ts.isStringLiteral(name)) throw new Error("CLI command name must be resolved statically");
    let module: string | undefined;
    visit(property(element, "load"), (node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0])) module = node.arguments[0].text;
    });
    if (!module) throw new Error(`No source module for ${name.text}`);
    if (result.has(name.text)) throw new Error(`Duplicate CLI command ${name.text}`);
    result.set(name.text, syntax(resolve(directory, `${module}.ts`)));
  }
  if (!result.size) throw new Error("CLI dispatch is empty");
  return result;
}

/** Follow parseOptions' actual second argument, including inline objects. */
function acceptedFlags(source: ts.SourceFile): Set<string> {
  const declarations = new Map<string, ts.Expression>();
  visit(source, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, unwrap(node.initializer));
    }
  });
  const flags = new Set<string>();
  let parsers = 0;
  visit(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) ||
      node.expression.text !== "parseOptions") return;
    parsers++;
    let definition: ts.Expression | undefined = node.arguments[1] && unwrap(node.arguments[1]);
    if (definition && ts.isIdentifier(definition)) definition = declarations.get(definition.text);
    if (!definition || !ts.isObjectLiteralExpression(definition)) {
      throw new Error(`Cannot resolve option definitions in ${source.fileName}`);
    }
    for (const entry of definition.properties) {
      if (!ts.isPropertyAssignment(entry) || !ts.isStringLiteral(entry.name) ||
        !entry.name.text.startsWith("--")) throw new Error("Unresolved CLI option definition");
      flags.add(entry.name.text);
    }
  });
  if (parsers !== 1 || flags.size === 0) throw new Error(`CLI parser shape changed: ${source.fileName}`);
  return flags;
}

function toolNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  visit(source, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "registerTool") {
      const name = node.arguments[0];
      if (!name || !ts.isStringLiteral(name)) throw new Error("Cannot statically resolve MCP registration");
      names.push(name.text);
    }
  });
  if (!names.length) throw new Error("No MCP tools found");
  return names;
}

/** Parse the deliberately small YAML mapping without adding a runtime dependency.
 * Accept plain/quoted strings and folded/literal block scalars; reject other YAML.
 */
function frontmatter(markdown: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown);
  if (!match) throw new Error("Missing YAML frontmatter");
  const lines = match[1]!.split("\n");
  const fields: Record<string, string> = {};
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim() || line.startsWith("#")) continue;
    const entry = /^([a-zA-Z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!entry || fields[entry[1]!] !== undefined) throw new Error(`Invalid/duplicate YAML entry: ${line}`);
    let value = entry[2]!;
    if (/^[>|]-?$/.test(value)) {
      const block: string[] = [];
      while (lines[index + 1]?.startsWith("  ")) block.push(lines[++index]!.slice(2));
      value = block.join(value.startsWith(">") ? " " : "\n");
    } else if (value.startsWith('"')) {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error("YAML value must be a string");
      value = parsed;
    } else if (value.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(value)) throw new Error("Invalid YAML quoted scalar");
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (!value || /:\s|\s#|^[\[\]{}&*!|>%@`]/.test(value) ||
      /^(?:true|false|null|~|[-+]?\d+(?:\.\d+)?)$/i.test(value)) {
      throw new Error(`Unsupported YAML scalar: ${value}`);
    }
    fields[entry[1]!] = value;
  }
  return fields;
}

function codeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let fence: string | undefined;
  let lines: string[] = [];
  for (const line of markdown.split("\n")) {
    const start = /^\s{0,3}(`{3,}|~{3,})[^`~]*$/.exec(line);
    if (!fence && start) { fence = start[1]!; lines = []; }
    else if (fence && new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) {
      blocks.push(lines.join("\n")); fence = undefined;
    } else if (fence) lines.push(line);
  }
  if (fence) throw new Error("Unclosed Markdown code fence");
  return blocks;
}

/** Tokenize shell examples without evaluating them; quoted values stay together. */
function invocationErrors(block: string, commands: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const errors: string[] = [];
  const logicalLines = block.replace(/(?:\\|`|\^)\s*\n/g, " ").split("\n");
  for (const line of logicalLines) {
    const tokens = (line.match(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|&&|\|\||[|;<>]|[^\s|;<>]+/g) ?? [])
      .map((token) => /^(['"])[\s\S]*\1$/.test(token) ? token.slice(1, -1) : token);
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] !== "chemdraft") continue;
      // In client registration this token is a server name, not an executable/script.
      if (tokens[index - 1] === "add" && tokens[index - 2] === "mcp") continue;
      const command = tokens[index + 1];
      if (command === "--help") continue;
      const flags = command && commands.get(command);
      if (!flags) { errors.push(`Unknown subcommand ${command ?? "(missing)"}: ${line}`); continue; }
      for (let cursor = index + 2; cursor < tokens.length; cursor++) {
        const token = tokens[cursor]!;
        if (["|", "||", "&&", ";", ">", "<"].includes(token) || token.startsWith("#")) break;
        if (token.startsWith("--") && !flags.has(token)) errors.push(`Unknown ${command} flag ${token}: ${line}`);
      }
    }
  }
  return errors;
}

const commandFiles = commandSources();
const flags = new Map([...commandFiles].map(([name, source]) => [name, acceptedFlags(source)]));
const tools = toolNames(syntax(join(root, "packages", "chemdraft-mcp", "src", "server.ts")));
const entrypoint = read(join(skillRoot, "SKILL.md"));

describe("ChemDraft agent skill drift guard", () => {
  it("has valid Agent Skills frontmatter", () => {
    const metadata = frontmatter(entrypoint);
    expect(metadata.name).toBe("chemdraft");
    expect(metadata.name).toBe(basename(skillRoot));
    expect(metadata.name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(metadata.description?.length).toBeGreaterThan(0);
    expect(metadata.description?.length).toBeLessThanOrEqual(1024);
    expect(metadata.description).not.toMatch(/[<>]/);
  });

  it("mentions every dispatched CLI command and registered MCP tool", () => {
    for (const name of [...flags.keys(), ...tools]) {
      expect(entrypoint, `Missing ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
    // Exact table coverage catches removals as well as additions/renames.
    const rows = [...entrypoint.matchAll(/\|[^|\n]+\| `([a-z0-9-]+)` \| `([a-z0-9_]+)` \|/g)];
    expect(rows.map((row) => row[1]!).sort()).toEqual([...flags.keys()].sort());
    expect(rows.map((row) => row[2]!).sort()).toEqual([...tools].sort());
  });

  it("uses only source-accepted subcommands and flags in all fenced examples", () => {
    const errors = markdownFiles(skillRoot).flatMap((path) =>
      codeBlocks(read(path)).flatMap((block) => invocationErrors(block, flags).map((error) => `${path}: ${error}`))
    );
    expect(errors).toEqual([]);
  });

  it("resolves every relative Markdown link", () => {
    for (const path of markdownFiles(skillRoot)) {
      // Markdown prose only; example code may legitimately contain brackets and parentheses.
      const prose = read(path).replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, "$1");
      const targets = [
        ...[...prose.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)].map((match) => match[1]!),
        ...[...prose.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)].map((match) => match[1]!)
      ];
      for (let target of targets) {
        target = target.replace(/^<|>$/g, "");
        if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(target)) continue;
        const pathname = decodeURIComponent(target.split(/[?#]/, 1)[0]!);
        expect(existsSync(resolve(dirname(path), pathname)), `${path}: broken link ${target}`).toBe(true);
      }
    }
  });

  it("detects drift and continuations without executing examples", () => {
    const renderFlags = flags.get("render")!;
    const testCommands = new Map([["render", renderFlags]]);
    expect(invocationErrors("pnpm -s chemdraft missing --help", testCommands)).toHaveLength(1);
    expect(invocationErrors("pnpm -s chemdraft render --removed-flag 3", testCommands)).toHaveLength(1);
    expect(invocationErrors("pnpm -s chemdraft render '--removed-flag' 3", testCommands)).toHaveLength(1);
    for (const continuation of ["\\", "`", "^"]) {
      expect(invocationErrors(`pnpm -s chemdraft render ${continuation}\n --removed-flag 3`, testCommands)).toHaveLength(1);
    }
    const removed = new Map([["render", new Set([...renderFlags].filter((flag) => flag !== "--width"))]]);
    expect(invocationErrors("pnpm -s chemdraft render --width 600", removed)).toHaveLength(1);
    expect(invocationErrors("pnpm -s --dir \"path with spaces\" chemdraft render --smiles 'C#N' --width 600", testCommands)).toEqual([]);
    expect(invocationErrors("codex mcp add chemdraft -- pnpm -s --dir checkout chemdraft-mcp", testCommands)).toEqual([]);
    expect(codeBlocks("~~~sh\nchemdraft render --help\n~~~\n")).toEqual(["chemdraft render --help"]);
    expect(frontmatter("---\r\nname: chemdraft\r\ndescription: hello\r\n---\r\n".replace(/\r\n/g, "\n"))).toEqual({ name: "chemdraft", description: "hello" });
  });
});
