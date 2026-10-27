import { installNestedModuleWorkerShim } from "./nestedModuleWorkerShim.js";

// A static dependency evaluated BEFORE plugin modules, without suspending entry evaluation.
installNestedModuleWorkerShim("windows");
