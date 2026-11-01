import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const rustSourceRoot = fileURLToPath(new URL("../../src-tauri/src/", import.meta.url));
export const signatureSnapshot = new URL("./commandSignatures.json", import.meta.url);

/** Fail on an unrecognised declaration instead of silently dropping a command from the guard. */
export function commandSignatures(text: string) {
  const declarations = [...text.matchAll(/^[ \t]*#\[\s*tauri::command\b[^\]]*\]\s*/gm)];
  return declarations.map(declaration => {
    const tail = text.slice(declaration.index! + declaration[0].length);
    const match = tail.match(/^(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(async\s+)?fn\s+(\w+)\s*(<[^{}]*?>)?\s*\(/);
    if (!match) throw new Error(`Cannot scan Tauri command: ${tail.slice(0, 160)}`);
    const parametersStart = match[0].length;
    let end = parametersStart, depth = 1;
    for (; end < tail.length && depth; end++) {
      if (tail[end] === "(") depth++;
      if (tail[end] === ")") depth--;
    }
    const result = depth === 0 && tail.slice(end).match(/^\s*(->\s*[^{}]+)?\{/);
    if (!result) throw new Error(`Cannot scan Tauri command return type: ${match[2]}`);
    const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
    return { name: match[2], async: Boolean(match[1]), generics: normalize(match[3] ?? ""), parameters: normalize(tail.slice(parametersStart, end - 1)),
      returnType: result[1] ? normalize(result[1].slice(2)) : "()" };
  });
}

export function collectCommandSignatures(root = rustSourceRoot) {
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.name.endsWith(".rs") && entry.name !== "perf_log.rs" ? [path] : [];
  });
  return walk(root).sort().flatMap(path => commandSignatures(readFileSync(path, "utf8"))
    .map(signature => ({ file: relative(root, path).replaceAll("\\", "/"), ...signature })));
}

// Regenerate deliberately with Node 24+: node apps/desktop/src/perf/commandSignatures.ts
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(signatureSnapshot, `${JSON.stringify(collectCommandSignatures(), null, 2)}\n`);
}
