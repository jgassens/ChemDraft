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
const overlayId = "overlay.chat.chat";
let configured = false;
let entries = [];
const action = (id, label) => ({ id, label, commandId: `plugin.chat.${id}` });
async function execute({ commandId, input }, call) {
  const status = text => call("overlays", "setStatus", { overlayId, text });
  const transcript = () => call("overlays", "setTranscript", { overlayId, entries });
  const ready = async () => {
    await call("overlays", "setContent", { overlayId, sections: [
      { kind: "text", title: "Mode: Local", body: "Test mode selected" },
      { kind: "actions", id: "choice", buttons: [action("choose", "✓ Local"), action("setup", "Setup…")] },
      { kind: "actions", id: "conversation", buttons: [action("new", "New conversation")] }
    ] });
    await status("Local ready");
  };
  const setup = async () => {
    const tool = await call("tools", "status", { tool: "codex" });
    await call("overlays", "setContent", { overlayId, sections: [
      { kind: "text", title: "Setup — choose a mode", body: "Select a test mode" },
      { kind: "actions", id: "setup-finish", buttons: [action("finish", "Finish setup")] },
      { kind: "text", title: "Local mode", body: `Installed ${tool.version}. Signed in` },
      { kind: "actions", id: "setup-choice", buttons: [action("choose", "Use this mode")] }
    ] });
  };
  switch (commandId) {
    case "plugin.chat.open":
      configured ||= !!(await call("storage", "get", "chosenProviders"))?.length;
      await (configured ? ready() : setup());
      await call("overlays", "open", { overlayId, focus: true });
      break;
    case "plugin.chat.choose":
      if (configured) await ready();
      break;
    case "plugin.chat.finish":
      configured = true;
      await call("storage", "set", "chosenProviders", ["codex"]);
      await ready();
      break;
    case "plugin.chat.setup": await setup(); break;
    case "plugin.chat.new": entries = []; await transcript(); await ready(); break;
    case "plugin.chat.submit": {
      if (!configured) {
        await status("Finish Setup above before sending a request.");
        break;
      }
      entries.push({ role: "user", text: input.text });
      await transcript();
      const run = await call("tools", "run", { tool: "codex", conversationId: "testchat01", prompt: input.text, systemPrompt: "Test replay only" });
      const result = await call("tools", "poll", { runId: run.runId, cursor: 0 });
      // Read a final empty poll too, proving cursor forwarding through the host.
      await call("tools", "poll", { runId: run.runId, cursor: result.nextCursor });
      for (const line of result.lines) {
        const record = JSON.parse(line.text);
        if (record.kind === "reply") entries.push({ role: "assistant", text: record.text });
      }
      await transcript();
      await ready();
      await status("Local replied — no changes to the page");
      break;
    }
    default: throw new Error(`Unknown test command: ${commandId}`);
  }
}
