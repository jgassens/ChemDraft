// Bootstrap before importing the host, so module/asset failures still produce a native JSON report.
type NativeHandlers = { report?: { postMessage(value: unknown): void }; progress?: { postMessage(value: unknown): void } };
const handlers = (window as Window & { webkit?: { messageHandlers?: NativeHandlers } }).webkit?.messageHandlers;
const bootedAt = performance.now();
let delivered = false;
let latestProgress: unknown = { stage: "importing-profile-module" };

function report(value: unknown): void {
  if (delivered) return;
  delivered = true;
  document.title = `ChemDraft WKWebView profile: ${(value as { status?: string }).status ?? "finished"}`;
  document.querySelector("#report")!.textContent = JSON.stringify(value, null, 2);
  if (handlers?.report) handlers.report.postMessage(JSON.parse(JSON.stringify(value)));
  else console.log(JSON.stringify(value));
}

function failed(error: unknown): void {
  report({ schemaVersion: 1, status: "error", elapsedMs: performance.now() - bootedAt, latestProgress,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) },
    environment: { userAgent: navigator.userAgent, url: location.href, secureContext: isSecureContext } });
}

window.addEventListener("error", event => failed(event.error ?? event.message));
window.addEventListener("unhandledrejection", event => failed(event.reason));

void import("./profile").then(async ({ runProfile }) => {
  const result = await runProfile(value => {
    latestProgress = value;
    handlers?.progress?.postMessage(JSON.parse(JSON.stringify(value)));
  });
  report(result);
}).catch(failed);
