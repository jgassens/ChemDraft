import { RequestWriteError } from "@chemdraft/plugin-host";
import type { ToolDeadlineClass } from "./transport";

const nativeSeconds = { readCompute: 120, naming: 45, render: 60, requestWrite: 480 } as const;

/** Only a trusted host operation can pause preparation to wait for consent or a drawing gesture.
 * Account cumulative time in each phase across repeated writes in the same call. */
export function toolDeadline(deadline: ToolDeadlineClass, abort: AbortController) {
  const ceiling = nativeSeconds[deadline] * 1000;
  const remaining = { preparation: deadline === "requestWrite" ? 60_000 : ceiling, human: 300_000, gesture: 61_000 };
  let phase: keyof typeof remaining = "preparation";
  let since = performance.now();
  let stopped = false;
  const expire = () => abort.abort(new RequestWriteError("cancelled", "ChemDraft tool deadline exceeded."));
  const hardTimer = setTimeout(expire, ceiling);
  let timer = setTimeout(expire, remaining.preparation);
  let phaseTimeout: () => void = expire;
  function switchTo(next: keyof typeof remaining, onTimeout: () => void = expire) {
    clearTimeout(timer);
    const now = performance.now();
    remaining[phase] -= now - since;
    if (remaining[phase] <= 0) phaseTimeout();
    since = now;
    phase = next;
    phaseTimeout = onTimeout;
    if (remaining[phase] <= 0) phaseTimeout();
    else if (!stopped && !abort.signal.aborted) timer = setTimeout(onTimeout, remaining[phase]);
  }
  return {
    enterWait(next: "human" | "gesture", onTimeout?: () => void) {
      abort.signal.throwIfAborted();
      if (deadline !== "requestWrite" || phase !== "preparation") throw new RequestWriteError("busy", "A tool cannot enter this wait.");
      switchTo(next, onTimeout);
      let finished = false;
      return () => {
        if (!finished && !stopped) switchTo("preparation");
        finished = true;
      };
    },
    stop() { stopped = true; clearTimeout(timer); clearTimeout(hardTimer); }
  };
}
