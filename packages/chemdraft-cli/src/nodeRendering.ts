import { createRequire } from "node:module";

/** tsx's Node CJS loader wraps RoughJS's ESM default one extra time. The shared renderer has
 * already loaded that module; repair only its cached export facade, forwarding the original
 * functions unchanged. Vite/browser and bundled builds already expose generator directly.
 */
export function installNodeRendering(): void {
  const requireFromArt = createRequire(new URL("../../art-engine/package.json", import.meta.url));
  const entry = requireFromArt.resolve("roughjs/bin/rough");
  const cached: unknown = requireFromArt.cache[entry]?.exports;
  if (!cached || typeof cached !== "object") return;
  const facade = cached as Record<string, unknown>;
  if (typeof facade.generator === "function") return;
  const implementation = facade.default;
  if (implementation && typeof implementation === "object" &&
      typeof (implementation as Record<string, unknown>).generator === "function") {
    Object.assign(facade, implementation);
  }
}
