import { useCallback, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import type { PluginAppMenuItem } from "../appMenu";
import type { CommandSpec } from "../commands";
import { detectDesktopShortcutPlatform } from "../keyboardShortcuts";
import { nativePrompt } from "../nativePrompt";

const commands = {
  install: { id: "office.installAddin", title: "Install Office Add-in…" },
  remove: { id: "office.removeAddin", title: "Remove Office Add-in…" }
} as const;

const appNames = { word: "Word", powerPoint: "PowerPoint" } as const;
export type OfficeAddinAction = keyof typeof commands;

interface OfficeAddinResult {
  app: keyof typeof appNames;
  status: "notInstalled" | "installedSameVersion" | "installedOtherVersion" | "unrecognized" | "appNotFound" | "unavailable";
  changed: boolean;
  error?: string;
  /**
   * `permissionDenied` is macOS refusing access to the app's folder (EPERM/EACCES), most often
   * after the user chose Don't Allow when macOS asked to let ChemDraft access data from other apps.
   */
  errorKind?: "permissionDenied" | "other";
  /** Set for `unrecognized`: the file at ChemDraft's manifest name that ChemDraft left alone. */
  path?: string;
  /** This app was changed, then restored because the other app's change failed. */
  rolledBack?: boolean;
  /** Set with `permissionDenied`: this build's bundle identifier, for the `tccutil reset` command. */
  bundleIdentifier?: string;
}

/**
 * All the Help rows depend on. There is no status check: reading Word's and PowerPoint's
 * containers can raise macOS's "access data from other apps" prompt, so ChemDraft reads them only
 * inside an Install or Remove the user chose and confirmed (AGENTS.md §13).
 */
interface OfficeAddinState {
  busy?: boolean;
}

export function officeAddinSupported(isDesktop: boolean, platform: ShortcutPlatform = detectDesktopShortcutPlatform()): boolean {
  return isDesktop && platform === "macos";
}

/** Both rows are enabled on macOS except while an action runs; each action reports what it found. */
export function officeAddinCommands(supported: boolean, { busy }: OfficeAddinState = {}) {
  const disabledReason = !supported ? "Office add-in management is available in the ChemDraft app on macOS."
    : busy ? "Office add-in management is in progress."
    : undefined;
  return (["install", "remove"] as const).map(action => {
    const spec: CommandSpec = {
      ...commands[action], icon: "open", source: "core", category: "app",
      enabled: disabledReason === undefined, disabledReason
    };
    return { action, spec };
  });
}

export function officeAddinMenuItems(supported: boolean, bindings: ReturnType<typeof officeAddinCommands>): PluginAppMenuItem[] {
  if (!supported) return [];
  return bindings.map(({ spec }) => ({
    location: "help",
    command: { kind: "command", id: spec.id, commandId: spec.id, label: spec.title, enabled: spec.enabled !== false, coreRouted: true }
  }));
}

const installConfirmation = [
  "This adds ChemDraft to Word and PowerPoint on this Mac.",
  "Next, macOS will ask to let ChemDraft access data from other apps, because the add-in file goes into Word's and PowerPoint's own folders. " +
    "Choose Allow to install it; if you choose Don't Allow, Office is left unchanged.",
  "Microsoft describes this way of adding add-ins as meant for testing and may change it.",
  "The add-in loads its editor from https://chemdraft.ai.",
  "To remove it, choose Help > Remove Office Add-in in ChemDraft."
].join("\n\n");

const removeConfirmation = [
  "This removes ChemDraft from Word and PowerPoint on this Mac.",
  "macOS may ask to let ChemDraft access data from other apps, because the add-in file is in Word's and PowerPoint's own folders. " +
    "Choose Allow to remove it; if you choose Don't Allow, Office is left unchanged."
].join("\n\n");

function unrecognizedMessage(action: OfficeAddinAction, app: string, path = "ChemDraft's add-in manifest file"): string {
  const file = path + " is not a ChemDraft add-in manifest";
  return action === "install"
    ? app + " was not changed. " + file + ", so ChemDraft did not replace it. Move or delete that file, then choose Install Office Add-in again."
    : app + " was not changed. " + file + ", so ChemDraft did not remove it.";
}

/**
 * After Don't Allow, as paragraphs: what happened, then how to retry. macOS keeps the answer (TCC
 * service `SystemPolicyAppData`, keyed by bundle identifier) and may not ask again; resetting that
 * one decision is enough, so the message never suggests a broader grant such as Full Disk Access.
 */
function permissionDeniedMessage(action: OfficeAddinAction, bundleIdentifier: string | undefined): string[] {
  const item = action === "install" ? "Install Office Add-in" : "Remove Office Add-in";
  return [
    "Office was not changed, because macOS did not allow ChemDraft to access Word's and PowerPoint's data.",
    "Choose Help > " + item + " again and click Allow when macOS asks.",
    ...(bundleIdentifier ? [
      "If macOS does not ask again, reset its decision in Terminal with this command, then try again:",
      "tccutil reset SystemPolicyAppData " + bundleIdentifier
    ] : [])
  ];
}

function nothingToRemoveMessage(results: readonly OfficeAddinResult[]): string | undefined {
  if (results.some(result => result.changed || result.error || (result.status !== "notInstalled" && result.status !== "appNotFound"))) {
    return undefined;
  }
  return results.every(result => result.status === "appNotFound")
    ? "Word and PowerPoint were not found on this Mac, so nothing was removed."
    : "The Office add-in is not installed in Word or PowerPoint, so nothing was removed.";
}

interface OfficeAddinPort {
  invoke(command: "office_addin_install" | "office_addin_remove"): Promise<OfficeAddinResult[]>;
  prompt: typeof nativePrompt;
  setStatus: (text: string) => void;
}

/**
 * Confirms, then installs or removes. The add-in's status is read only here, by the command the
 * user confirmed; the results are returned for tests, and nothing keeps them.
 */
export async function runOfficeAddinAction(action: OfficeAddinAction, port: OfficeAddinPort): Promise<OfficeAddinResult[] | undefined> {
  const title = action === "install" ? "Install Office Add-in" : "Remove Office Add-in";
  const notice = async (message: string, kind: "info" | "warning" | "error") => {
    await port.prompt({
      title, message, kind, owner: "document", choices: [{ id: "ok", label: "OK", cancel: true }]
    }, async () => {
      port.setStatus(message.replaceAll("\n\n", " "));
      return "ok";
    });
  };
  const choice = await port.prompt({
    title, message: action === "install" ? installConfirmation : removeConfirmation, kind: "warning", owner: "document",
    choices: [
      action === "install" ? { id: "install", label: "Install" } : { id: "remove", label: "Remove" },
      { id: "cancel", label: "Cancel", cancel: true }
    ]
  }, async () => {
    port.setStatus("Could not open the Office add-in " + (action === "install" ? "installation" : "removal") + " confirmation.");
    return "cancel";
  });
  if (choice !== action) return;

  let results: OfficeAddinResult[];
  try {
    results = await port.invoke(action === "install" ? "office_addin_install" : "office_addin_remove");
  } catch (error) {
    await notice(title + " failed. " + String(error), "error");
    return;
  }

  const denial = results.find(result => result.errorKind === "permissionDenied");
  const denied = denial ? permissionDeniedMessage(action, denial.bundleIdentifier) : undefined;
  if (denied && !results.some(result => result.changed)) {
    await notice(denied.join("\n\n"), "warning");
    return results;
  }
  const nothingRemoved = action === "remove" ? nothingToRemoveMessage(results) : undefined;
  if (nothingRemoved) {
    await notice(nothingRemoved, "info");
    return results;
  }
  // Either both apps change or neither does, so after a failure the other app is reported unchanged.
  const failed = results.some(result => result.error);
  const messages = results.map(result => {
    const app = appNames[result.app];
    if (result.error) return app + " could not be updated. " + result.error;
    if (failed && !result.changed && result.status !== "appNotFound" && result.status !== "unrecognized") {
      return app + " was not changed.";
    }
    if (result.status === "appNotFound") return app + " was skipped because its Office container was not found.";
    if (result.status === "unrecognized") return unrecognizedMessage(action, app, result.path);
    if (action === "install") return result.changed ? "Installed in " + app + "." : "Already installed in " + app + ".";
    return result.changed ? "Removed from " + app + "." : "The add-in was already absent from " + app + ".";
  });
  const changed = results.filter(result => result.changed).map(result => appNames[result.app]).join(" and ");
  if (changed) {
    messages.push("Restart " + changed + (action === "install" ? ", then choose Edit Structure on the Home tab." : " to finish removing the add-in."));
  }
  // Something changed, so only the retry steps apply, not "Office was not changed".
  if (denied) messages.push(...denied.slice(1));
  await notice(messages.join("\n\n"), results.some(result => result.error || result.status === "unrecognized") ? "warning" : "info");
  return results;
}

export function useOfficeAddinCommands(supported: boolean, setStatus: (text: string) => void) {
  // Nothing runs at launch or on focus: the rows stay enabled, and only a chosen action reads
  // Office's folders.
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const run = useCallback(async (action: OfficeAddinAction) => {
    if (!supported || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await runOfficeAddinAction(action, { invoke, prompt: nativePrompt, setStatus });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [supported, setStatus]);

  return useMemo(() => {
    const bindings = officeAddinCommands(supported, { busy });
    return { bindings, run, menuItems: officeAddinMenuItems(supported, bindings) };
  }, [supported, busy, run]);
}
