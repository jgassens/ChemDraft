import { parsePluginManifest } from "@chemdraft/plugin-api";

export const manifest = parsePluginManifest({
  id: "org.chemdraft.fixture.requestWorker",
  name: "Caption Arrangement",
  version: "1.0.0",
  apiVersion: "^0.1.26",
  entry: "entry.js",
  permissions: ["document.read", "selection.read", "document.write", "chemistry.compute"],
  contributes: { commands: [
    { id: "plugin.requestWorker.arrange", title: "Arrange captions" },
    { id: "plugin.requestWorker.openTools", title: "Open caption tools" },
    { id: "plugin.requestWorker.finishTools", title: "Finish caption tools" },
    { id: "plugin.requestWorker.events", title: "Read document change events" }
  ] }
});
