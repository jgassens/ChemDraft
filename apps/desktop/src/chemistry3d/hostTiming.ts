import type { Chemistry3dTimingSink } from "./timing";

// Keep these helpers free of engine imports: host instrumentation must not load RDKit.
// With no sink, neither helper reads the clock.
export function timeHost3d<T>(sink: Chemistry3dTimingSink | undefined, stage: string, run: () => T): T {
  if (!sink) return run();
  const start = performance.now();
  try { return run(); }
  finally { sink({ stage, ms: performance.now() - start }); }
}

export function timeHost3dAsync<T>(sink: Chemistry3dTimingSink | undefined, stage: string, run: () => Promise<T>): Promise<T> {
  if (!sink) return run();
  const start = performance.now();
  return (async () => {
    try { return await run(); }
    finally { sink({ stage, ms: performance.now() - start }); }
  })();
}
