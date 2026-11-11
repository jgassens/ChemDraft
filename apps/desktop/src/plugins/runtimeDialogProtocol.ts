import { z } from "zod";
import { validEngineInstallSnapshot, validToolInstallSnapshot } from "../dialogs/dialogProtocol";

export const runtimeDialogTarget = z.object({ windowId: z.string().min(1).max(128), tabId: z.string().min(1).max(256),
  documentKey: z.string().min(1).max(256) }).strict();
export type RuntimeDialogTarget = z.infer<typeof runtimeDialogTarget>;
export const runtimeDialogRequest = z.object({ target: runtimeDialogTarget, id: z.string().uuid(),
  kind: z.enum(["engineInstall", "toolInstall"]), operation: z.enum(["open", "update", "close", "error"]),
  snapshot: z.unknown().optional(), message: z.string().max(4000).optional() }).strict().superRefine((value, context) => {
  if ((value.operation === "open" || value.operation === "update") &&
    !(value.kind === "engineInstall" ? validEngineInstallSnapshot(value.snapshot) : validToolInstallSnapshot(value.snapshot))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid runtime dialog snapshot." });
  }
});
export const runtimeDialogAction = z.object({ target: runtimeDialogTarget, id: z.string().uuid(),
  action: z.enum(["install", "allow", "cancelInstall", "close", "closed", "failed"]), message: z.string().max(4000).optional() }).strict();
