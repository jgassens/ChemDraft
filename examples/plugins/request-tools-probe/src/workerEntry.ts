import { runPluginWorker } from "@chemdraft/plugin-api";
import { createProbeRegistration } from "./register";

runPluginWorker(createProbeRegistration());
