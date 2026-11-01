// Original test-only implementation of the worker message protocol.
let sequence = 0;
const pending = new Map();
addEventListener("message", async ({ data }) => {
  if (data.kind === "capabilityResult") {
    const request = pending.get(data.requestId);
    pending.delete(data.requestId);
    if (data.ok) request.resolve(data.value);
    else request.reject(new Error(data.error.message));
  }
  if (data.kind !== "invokeCommand") return;
  const call = (namespace, method, ...args) => new Promise((resolve, reject) => {
    const requestId = ++sequence;
    pending.set(requestId, { resolve, reject });
    postMessage({ kind: "capabilityRequest", requestId, commandRequestId: data.commandRequestId, namespace, method, args });
  });
  try {
    await execute(data, call);
    postMessage({ kind: "commandSettled", commandRequestId: data.commandRequestId, ok: true });
  } catch (error) {
    postMessage({ kind: "commandSettled", commandRequestId: data.commandRequestId, ok: false,
      error: { code: "TEST_PLUGIN_ERROR", message: error.message } });
  }
});
postMessage({ kind: "ready", protocolVersion: 1, apiVersion: "^0.1.14" });
async function execute(_message, call) {
  await call("panels", "showReport", "panel.paneltest.chat", {
    title: "Panel Test Plugin", sections: [
      { kind: "text", body: "Using local test mode" },
      { kind: "prompt", id: "paneltest.message", commandId: "plugin.paneltest.submit",
        select: { id: "mode", label: "Mode", value: "local", options: [{ value: "local", label: "Local" }] } },
      { kind: "actions", id: "paneltest.readiness", buttons: [{ id: "refresh", label: "Refresh", commandId: "plugin.paneltest.open" }] }
    ]
  });
}
