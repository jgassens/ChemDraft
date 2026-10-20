import { installNestedModuleWorkerShim } from "./nestedModuleWorkerShim.js";

installNestedModuleWorkerShim("windows");
// Static imports would evaluate plugin dependencies before installing the shim.
await import("./massFragmentPluginWorker");

export {};
