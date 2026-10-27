import type { GetManualChunk, GetModuleInfo, OutputBundle, OutputChunk, Plugin } from "rollup";
import { parseAst } from "rollup/parseAst";

/** Pin the entry's STATIC dependencies to a separate chunk. Dynamic-only engines stay lazy.
 * Vite builds each worker separately; cache by graph, never by a module id shared across builds. */
export function workerRuntimeChunks(): GetManualChunk {
  const graphs = new WeakMap<GetModuleInfo, Set<string>>();
  return (id, { getModuleIds, getModuleInfo }) => {
    if (getModuleInfo(id)?.isEntry) return;
    let dependencies = graphs.get(getModuleInfo);
    if (!dependencies) {
      const collected = new Set<string>();
      const visit = (moduleId: string) => {
        if (collected.has(moduleId)) return;
        collected.add(moduleId);
        for (const imported of getModuleInfo(moduleId)?.importedIds ?? []) visit(imported);
      };
      for (const moduleId of getModuleIds()) {
        if (getModuleInfo(moduleId)?.isEntry) visit(moduleId);
      }
      dependencies = collected;
      graphs.set(getModuleInfo, dependencies);
    }
    return dependencies.has(id) ? "worker-runtime" : undefined;
  };
}

/** Runs inside EACH Vite worker build, while Rollup still knows which chunks are entries.
 * No filename heuristics: hashes, renamed entries and ?worker imports are covered too. */
export function assertWorkerEntriesAreNotImported(bundle: OutputBundle): OutputChunk[] {
  const chunks = Object.values(bundle).filter((item): item is OutputChunk => item.type === "chunk");
  const entries = new Set(chunks.filter(chunk => chunk.isEntry).map(chunk => chunk.fileName));
  for (const chunk of chunks) {
    for (const [kind, imports] of [["static", chunk.imports], ["dynamic", chunk.dynamicImports]] as const) {
      for (const imported of imports) {
        if (entries.has(imported)) {
          throw new Error(`Worker chunk ${chunk.fileName} has a ${kind} import of worker entry ${imported}. ` +
            "Move shared bindings behind a separate runtime module; worker entries must only bootstrap.");
        }
      }
    }
  }
  return chunks;
}

/** Inspect emitted JavaScript, not source text: imports can introduce TLA transitively.
 * Skip function bodies so async job handlers may still load engines after a listener exists. */
export function assertWorkerEntriesStartSynchronously(bundle: OutputBundle): void {
  const visited = new Set<string>();
  const visitChunk = (chunk: OutputChunk) => {
    if (visited.has(chunk.fileName)) return;
    visited.add(chunk.fileName);
    const visitNode = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visitNode); return; }
      const node = value as Record<string, unknown>;
      if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(String(node.type))) return;
      if (node.type === "AwaitExpression" || (node.type === "ForOfStatement" && node.await)) {
        throw new Error(`Worker startup chunk ${chunk.fileName} contains top-level await. ` +
          "Register message listeners synchronously; await engine loading only inside a handler or startup function.");
      }
      if (node.type === "ImportExpression") {
        throw new Error(`Worker startup chunk ${chunk.fileName} executes a top-level dynamic import. ` +
          "Statically import the runtime and register listeners synchronously before loading engines.");
      }
      Object.values(node).forEach(visitNode);
    };
    visitNode(parseAst(chunk.code));
    for (const imported of chunk.imports) {
      const dependency = bundle[imported];
      if (dependency?.type === "chunk") visitChunk(dependency);
    }
  };
  for (const item of Object.values(bundle)) {
    if (item.type === "chunk" && item.isEntry) visitChunk(item);
  }
}

export function workerChunksGuard(): Plugin {
  return {
    name: "chemdraft-worker-chunks-guard",
    generateBundle(_options, bundle) {
      assertWorkerEntriesStartSynchronously(bundle);
      const chunks = assertWorkerEntriesAreNotImported(bundle);
      // Keep cheap, inspectable evidence alongside each production worker (ordinary and profile builds).
      for (const entry of chunks.filter(chunk => chunk.isEntry)) {
        this.emitFile({ type: "asset", fileName: `worker-chunks/${entry.name}.json`, source: JSON.stringify({
          entry: entry.fileName,
          chunks: chunks.map(chunk => ({ fileName: chunk.fileName, isEntry: chunk.isEntry,
            imports: chunk.imports, dynamicImports: chunk.dynamicImports, exports: chunk.exports }))
        }, null, 2) });
      }
    }
  };
}
