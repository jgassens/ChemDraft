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
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const start = /^\s{0,3}(`{3,}|~{3,})[^`~]*$/.exec(line);
    if (!fence && start) { fence = start[1]!; lines = []; }
    else if (fence && new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) {
      blocks.push(lines.join("\n")); fence = undefined;
    } else if (fence) lines.push(line);
  }
  if (fence) throw new Error("Unclosed Markdown code fence");
  return blocks;
}

/** Keep quotes for shell-safety checks; never evaluate documented commands. */
function shellTokens(line: string): string[] {
  return line.match(/"[^"\n]*"|'(?:''|[^'])*'|<[^>\n]+>|&&|\|\||[|;<>]|[^\s|;<>]+/g) ?? [];
}

function shellSafetyErrors(block: string): string[] {
  const errors: string[] = [];
  for (const line of block.replace(/\r\n?/g, "\n").replace(/(?:\\|`|\^)\s*\n/g, " ").split("\n")) {
    const tokens = shellTokens(line);
    for (const [index, token] of tokens.entries()) {
      const serverName = token === "chemdraft" && tokens[index + 1] === "--" &&
        tokens[0] !== undefined && ["claude", "codex"].includes(tokens[0]) &&
        tokens[1] === "mcp" && tokens[2] === "add";
      if (token === "chemdraft" && !serverName) {
        // MCP registrations use chemdraft as the server name, before the -- separator.
        const launcher = tokens.slice(index - 5, index);
        if (launcher.length !== 5 || launcher[0] !== "pnpm" || launcher[1] !== "-s" ||
          launcher[2] !== "--config.shell-emulator=true" || launcher[3] !== "--dir" ||
          !launcher[4] || launcher[4].startsWith("--")) {
          errors.push(`Use pnpm -s --config.shell-emulator=true --dir <checkout>: ${line}`);
        }
      }
      if (!token.startsWith("--") || token === "--") continue;
      const equals = token.indexOf("=");
      const value = equals < 0 ? tokens[index + 1] : token.slice(equals + 1);
      if (value?.includes(",") && !/^'(?:''|[^'])*'$/.test(value)) {
        errors.push(`Single-quote comma-separated flag value ${value}: ${line}`);
      }
    }
  }
  return errors;
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
      if (tokens[index + 1] === "--" && ["claude", "codex"].includes(tokens[0] ?? "") &&
        tokens[1] === "mcp" && tokens[2] === "add") continue;
      const command = tokens[index + 1];
      if (command === "--help") continue;
      const flags = command && commands.get(command);
      if (!flags) { errors.push(`Unknown subcommand ${command ?? "(missing)"}: ${line}`); continue; }
      for (let cursor = index + 2; cursor < tokens.length; cursor++) {
        const token = tokens[cursor]!;
        if (["|", "||", "&&", ";", ">", "<"].includes(token) || token.startsWith("#")) break;
        if (token !== "--" && token.startsWith("--") && !flags.has(token)) errors.push(`Unknown ${command} flag ${token}: ${line}`);
      }
    }
  }
  return errors;
}

/** Long options only: bare -- is a separator, and -s belongs to pnpm. */
function mentionedFlags(text: string): string[] {
  return [...text.matchAll(/(?<![\w-])--[a-zA-Z][\w-]*/g)].map((match) => match[0]);
}

function singleCommand(text: string, commands: ReadonlyMap<string, ReadonlySet<string>>): string | null | undefined {
  // An option such as --render is not a mention of the render subcommand.
  const words = new Set(text.replace(/--[a-zA-Z][\w-]*/g, "").toLowerCase().match(/\b[a-z]+\b/g));
  const names = [...commands.keys()].filter((name) => words.has(name));
  return names.length === 1 ? names[0] : names.length ? null : undefined;
}

/** Remove other tools' options only within their own invocation/configuration.
 * pnpm's --dir/--filter precede the script; git/node and client registration
 * have their own options. Never exempt these flag names in ChemDraft prose.
 */
function cliOptionText(text: string): string {
  return text
    .replace(/\b(?:claude|codex)\s+mcp\s+add\b[^\n`]*?(?=\s+--\s+|$)/g, "")
    .replace(/\b(?:git|node)\s+[^\n`|;]+/g, "")
    // Exempt only this exact pnpm setting before the script, never CLI flags or prose.
    .replace(/\bpnpm\s+(?:(?:-s|--config\.shell-emulator=true|--(?:dir|filter)\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s`|;]+))\s+)*/g, "")
    // This is the repository packaging script, not a headless subcommand.
    .replace(/\bplugin:package\s+[^\n`|;]+/g, "")
    // MCP launch arrays document pnpm options, not ChemDraft CLI options.
    .replace(/\[\s*(?:"\/d"\s*,\s*"\/c"\s*,\s*"pnpm"\s*,\s*)?"-s"\s*,\s*"--dir"\s*,[^\]\n]*"chemdraft-mcp"\s*\]/g, "");
}

/** Check every option mention, with headings/table rows providing command scope.
 * Unscoped or ambiguous mentions must exist on at least one dispatched command.
 */
function documentedFlagErrors(markdown: string, commands: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const errors: string[] = [];
  const headings: { level: number; command: string | null | undefined }[] = [];
  let fence: string | undefined;
  let tableCommand: string | null | undefined;
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})[^`~]*$/.exec(line);
    if (!fence && marker) { fence = marker[1]!; continue; }
    if (fence && new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) {
      fence = undefined; continue;
    }
    const heading = !fence && /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
      headings.push({ level, command: singleCommand(heading[2]!, commands) });
    }
    const text = cliOptionText(line);
    const isRow = !fence && /^\s*\|/.test(line);
    if (!isRow) tableCommand = undefined;
    else {
      // Only explicit command cells count; {name, smiles} and "same as render"
      // describe data, not the command whose options this table documents.
      const cells = [...text.matchAll(/`([a-z]+)`/g)].map((match) => match[1]!);
      const names = new Set(cells.filter((name) => commands.has(name)));
      if (names.size) tableCommand = names.size === 1 ? [...names][0] : null;
    }
    // Hyphenated subcommands (render-document) are one name, not "render".
    const invocation = /\bchemdraft\s+([a-z][a-z-]*)\b/.exec(text);
    const scope = tableCommand !== undefined ? tableCommand :
      [...headings].reverse().find((entry) => entry.command !== undefined)?.command;
    const command = invocation?.[1] ?? scope ?? undefined;
    for (const flag of mentionedFlags(text)) {
      const accepted = command ? commands.get(command)?.has(flag) :
        [...commands.values()].some((options) => options.has(flag));
      if (!accepted) errors.push(`Line ${index + 1}: Unknown ${command ?? "CLI"} flag ${flag}: ${line}`);
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

  it("uses only source-accepted flags everywhere in the skill", () => {
    const errors = markdownFiles(skillRoot).flatMap((path) =>
      documentedFlagErrors(read(path), flags).map((error) => `${path}: ${error}`)
    );
    expect(errors).toEqual([]);
  });

  it("uses the shared launcher and single-quotes comma lists in fenced examples", () => {
    const errors = markdownFiles(skillRoot).flatMap((path) =>
      codeBlocks(read(path)).flatMap((block) => shellSafetyErrors(block).map((error) => `${path}: ${error}`))
    );
    expect(errors).toEqual([]);
  });

  it("detects unsafe launchers and lists across shells without spawning processes", () => {
    for (const checkout of ["checkout", '"path with spaces"', "'$checkout'", "<checkout>", '"<checkout>"']) {
      const launch = `pnpm -s --config.shell-emulator=true --dir ${checkout} chemdraft`;
      expect(shellSafetyErrors(`${launch} analyze --methods 'rdkit.composition,rdkit.tpsa'`)).toEqual([]);
      expect(shellSafetyErrors(`${launch} nmr --nuclei 1H,13C`)).toHaveLength(1);
      expect(shellSafetyErrors(`${launch} nmr --nuclei=1H,13C`)).toHaveLength(1);
      expect(shellSafetyErrors(`${launch} nmr --nuclei "1H,13C"`)).toHaveLength(1);
      expect(shellSafetyErrors(`${launch} nmr --nuclei='1H,13C'`)).toEqual([]);
      expect(shellSafetyErrors(`${launch.replace("--config.shell-emulator=true ", "")} render --help`)).toHaveLength(1);
      expect(documentedFlagErrors(`${launch} render --width 600`, flags)).toEqual([]);
      expect(documentedFlagErrors(`${launch} render --config.shell-emulator=true`, flags)).toHaveLength(1);
    }
    expect(shellSafetyErrors("chemdraft render --help")).toHaveLength(1);
    expect(documentedFlagErrors("Use `--config.shell-emulator=true` here.", flags)).toHaveLength(1);
    expect(documentedFlagErrors("pnpm -s --config.shell-emulator=false --dir checkout chemdraft render", flags).length).toBeGreaterThan(0);
    for (const continuation of ["\\", "`", "^"]) {
      expect(shellSafetyErrors(`pnpm -s --config.shell-emulator=true ${continuation}\r\n--dir "$checkout" chemdraft nmr --nuclei '1H,13C'`)).toEqual([]);
    }
    expect(shellSafetyErrors("claude mcp add --scope user chemdraft -- pnpm -s --dir checkout chemdraft-mcp")).toEqual([]);
    expect(shellSafetyErrors("codex mcp add chemdraft -- pnpm -s --dir checkout chemdraft-mcp")).toEqual([]);
    expect(codeBlocks("```sh\r\nchemdraft render --help\r\n```\r\n")).toEqual(["chemdraft render --help"]);
  });

  it("routes appearance requests to the art reference", () => {
    expect(entrypoint).toMatch(/\]\(references\/art\.md\)/);
    expect(entrypoint).toMatch(/Never tell a user ChemDraft cannot produce a visual style/);
    // Text objects read fontSizePx; fontSize as a key is silently ignored by the renderer.
    const textStyleDocs = [...markdownFiles(skillRoot),
      join(root, "packages", "chemdraft-cli", "README.md"),
      join(root, "packages", "chemdraft-mcp", "README.md")];
    const unread = textStyleDocs.filter((path) => /\bfontSize(?!Px)\s*:/.test(read(path)));
    expect(unread).toEqual([]);
  });

  it("keeps setup's CLI and MCP counts aligned with source registrations", () => {
    const setup = read(join(skillRoot, "references", "setup.md"));
    expect(setup).toContain(`CLI help lists ${flags.size} commands`);
    expect(setup).toContain(`all ${tools.length} tools`);
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

  it("detects table/inline drift, scopes options, and narrowly excludes other tools", () => {
    expect(documentedFlagErrors("## Grid\n| `--gutterx` | spacing |", flags)).toHaveLength(1);
    expect(documentedFlagErrors("## Render\nUse `--gutter`.", flags)).toHaveLength(1);
    expect(documentedFlagErrors("## Grid\n### Options\nUse --gutter.\n## Render\nUse `--gutter`.", flags)).toHaveLength(1);
    expect(documentedFlagErrors("## Render and grid\nUse `--gutter`.", flags)).toEqual([]);
    expect(documentedFlagErrors("# Render\n## Render and grid\nUse `--gutter`.", flags)).toEqual([]);
    expect(documentedFlagErrors("| Command | Option |\n| `grid` | `--gutter` |\n| | `--gutterx` |", flags)).toHaveLength(1);
    expect(documentedFlagErrors("## Render\n| `render` / `grid` | `--gutter` |", flags)).toEqual([]);
    expect(documentedFlagErrors("Use `--gutterx` without a heading.", flags)).toHaveLength(1);
    for (const [command, flag] of [["grid", "--gutter"], ["nmr", "--name"], ["render", "--bond-length"]] as const) {
      const removed = new Map(flags);
      removed.set(command, new Set([...flags.get(command)!].filter((option) => option !== flag)));
      expect(documentedFlagErrors(`## ${command}\n| \`${flag}\` | option |`, removed)).toHaveLength(1);
    }
    const examples = [
      "```sh", "git clone --depth 1 repo", "node --version",
      "claude mcp add --transport stdio chemdraft -- pnpm -s --dir checkout chemdraft-mcp",
      "codex mcp add chemdraft -- pnpm -s --dir checkout chemdraft-mcp",
      'pnpm -s --filter package --dir "path with spaces" chemdraft render --width 600', "```",
      '`["-s", "--dir", "checkout", "chemdraft-mcp"]`', "Use `--` as a separator."
    ].join("\r\n");
    expect(documentedFlagErrors(examples, flags)).toEqual([]);
    expect(documentedFlagErrors("## Render\n`pnpm -s --dir checkout chemdraft render --dir bad`", flags)).toHaveLength(1);
    expect(documentedFlagErrors("Use `--dir` here.", flags)).toHaveLength(1);
    expect(documentedFlagErrors("## Grid\r\n| `--gutterx` | spacing |", flags)).toHaveLength(1);
    expect(documentedFlagErrors("`pnpm -s --config.shell-emulator=true --dir checkout chemdraft render-document --document doc.json --out a.png`", flags)).toEqual([]);
    expect(documentedFlagErrors("`pnpm -s --config.shell-emulator=true --dir checkout chemdraft render --document doc.json`", flags)).toHaveLength(1);
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
    expect(invocationErrors("pnpm -s chemdraft render --", testCommands)).toEqual([]);
    expect(invocationErrors("codex mcp add chemdraft -- pnpm -s --dir checkout chemdraft-mcp", testCommands)).toEqual([]);
    expect(codeBlocks("~~~sh\nchemdraft render --help\n~~~\n")).toEqual(["chemdraft render --help"]);
    expect(frontmatter("---\r\nname: chemdraft\r\ndescription: hello\r\n---\r\n".replace(/\r\n/g, "\n"))).toEqual({ name: "chemdraft", description: "hello" });
  });
});
