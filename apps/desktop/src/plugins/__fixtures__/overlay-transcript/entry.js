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
const overlayId = "overlay.transcript.chat";
async function execute({ commandId, input }, call) {
  if (commandId === "plugin.transcript.open") return;
  const run = await call("tools", "run", { tool: "codex", conversationId: "testreplay01", prompt: input.text, systemPrompt: "Test replay only" });
  const result = await call("tools", "poll", { runId: run.runId, cursor: 0 });
  const reply = result.lines.map(line => JSON.parse(line.text)).find(record => record.kind === "reply").text;
  await call("overlays", "setTranscript", { overlayId, entries: [{ role: "user", text: input.text }, { role: "assistant", text: reply }] });
  await call("panels", "showReport", "panel.transcript.chat", { title: "Panel Test Plugin", sections: [
    { kind: "text", body: input.text }, { kind: "text", body: reply }
  ] });
}
