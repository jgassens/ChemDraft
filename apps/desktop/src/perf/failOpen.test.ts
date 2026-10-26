import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { scanPerfHooks } from "./scanPerfHooks";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path)
      : /\.[cm]?[jt]sx?$/.test(path) && !/\.(test|spec)\./.test(path) ? [path] : [];
  });
}
it("isolates probe calls throughout desktop src (behavioural suites exercise the actions)", () => {
  const results = sources("apps/desktop/src").map(file => scanPerfHooks(file, readFileSync(file, "utf8")));
  expect(results.flatMap(result => result.errors)).toEqual([]);
  expect(results.flatMap(result => result.hooks).length).toBeGreaterThan(50);
});
it.each([
  "perfProbe.signal('frame')", "perfProbe!.signal('frame')", "perfProbe?.signal('frame')",
  "const { signal } = perfProbe!; signal('frame')",
  "const { perfProbe: p } = runtime; p!.signal('frame')",
  "const { nativeWindowOpening: open } = runtime; open('preferences')",
  "perfHook(() => setTimeout(() => perfProbe!.signal('frame'), 0))",
  "perfHook(() => Promise.resolve().then(() => perfProbe?.signal('frame')))",
  "const result = perfHook(() => perfProbe?.signal('frame')); await result",
  "const result = perfHook(() => perfProbe?.signal('frame')); const alias = result; await alias",
  "await perfHook(() => perfProbe?.signal('frame'))",
  "const result = perfHook(() => perfProbe?.signal('frame')); await Promise.resolve(result)",
  "let result; result = perfHook(() => perfProbe?.signal('frame')); await result",
  "const result = perfHook(() => perfProbe?.signal('frame')); await result.then(() => {})",
  "const emit = perfProbe!.signal; emit('frame')",
  "perfProbe!['signal']('frame')",
  "perfHook(() => ({ method() { perfProbe?.signal('frame') } }))",
  "perfHook(() => ({ get value() { perfProbe?.signal('frame'); return 1 } }))",
  "perfHook(() => class { value = perfProbe?.signal('frame') })",
  "perfHook(() => class { static value = perfProbe?.signal('frame') })",
  "perfHook(() => class { constructor() { perfProbe?.signal('frame') } })",
  "perfHook(() => class { set value(v: number) { perfProbe?.signal('frame') } })",
])("rejects unsafe probe syntax: %s", code => {
  const result = scanPerfHooks("new/surface.tsx", `import { perfProbe, perfHook } from './perf/runtime';\n${code}`);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors.every(error => error.startsWith("new/surface.tsx:2:"))).toBe(true);
});
it.each(["windows", "macos"] as const)("recognises runtime isolation with %s paths", platform => {
  const path = (platform === "windows" ? win32 : posix).join("apps", "desktop", "src", "perf", "runtime.ts");
  expect(scanPerfHooks(path, readFileSync("apps/desktop/src/perf/runtime.ts", "utf8")).errors).toEqual([]);
});
it("recognises aliased and destructured imports, optional and non-null calls inside isolation", () => {
  const result = scanPerfHooks("surface.ts", `import { perfProbe as p, nativeWindowOpening as open, perfHook as safe } from './perf/runtime';
    safe(() => p!.signal('frame')); safe(() => p?.signal('frame'));
    const { signal: emit } = p!; safe(() => emit('frame')); safe(() => open('preferences'));`);
  expect(result.errors).toEqual([]);
  expect(result.hooks).toHaveLength(4);
});

it("requires a class field initializer to isolate its own probe call", () => {
  expect(scanPerfHooks("surface.ts", "perfHook(() => class { value = perfHook(() => perfProbe?.signal('frame')) })").errors).toEqual([]);
});
