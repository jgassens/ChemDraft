import { runPluginWorker, type PluginWorkerEndpoint } from "@chemdraft/plugin-api";
import { createLegacyFixtureRegistration } from "./register";

const registration = createLegacyFixtureRegistration();
const endpoint = globalThis as unknown as PluginWorkerEndpoint;

// Let the SDK produce the probe's opt-ins and send its capability calls. Present the older
// version at the wire boundary so the host has to reject the opt-ins itself.
runPluginWorker({ ...registration, manifest: { ...registration.manifest, apiVersion: "^0.1.26" } }, {
  addEventListener: (type, listener) => endpoint.addEventListener(type, listener),
  postMessage(message) {
    if (message && typeof message === "object" && "kind" in message && message.kind === "ready") {
      endpoint.postMessage({ ...message, apiVersion: registration.manifest.apiVersion });
    } else {
      endpoint.postMessage(message);
    }
  }
});
