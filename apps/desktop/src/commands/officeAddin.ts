import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import type { PluginAppMenuItem } from "../appMenu";
import type { CommandSpec } from "../commands";
import { detectDesktopShortcutPlatform } from "../keyboardShortcuts";
import { nativePrompt } from "../nativePrompt";

const commands = {
  install: { id: "office.installAddin", title: "Install Office Add-in…" },
  remove: { id: "office.removeAddin", title: "Remove Office Add-in" }
} as const;

const appNames = { word: "Word", powerPoint: "PowerPoint" } as const;
export type OfficeAddinAction = keyof typeof commands;

interface OfficeAddinResult {
  app: keyof typeof appNames;
  status: "notInstalled" | "installedSameVersion" | "installedOtherVersion" | "unrecognized" | "appNotFound" | "unavailable";
  changed: boolean;
  error?: string;
  /** Set for `unrecognized`: the file at ChemDraft's manifest name that ChemDraft left alone. */
  path?: string;
}

interface OfficeAddinState {
  results?: readonly OfficeAddinResult[];
  error?: string;
  busy?: boolean;
}

export function officeAddinSupported(isDesktop: boolean, platform: ShortcutPlatform = detectDesktopShortcutPlatform()): boolean {
  return isDesktop && platform === "macos";
}

export function officeAddinCommands(supported: boolean, { results, error, busy }: OfficeAddinState) {
  const availability = !supported ? "Office add-in management is available in the ChemDraft app on macOS."
    : busy ? "Office add-in management is in progress."
    : error ? "Could not check Office add-in status. " + error
    : !results ? "Checking Office add-in status."
    : undefined;
  const disabledFor = (action: OfficeAddinAction): string | undefined => {
    if (availability) return availability;
    // An unrecognized file keeps both actions enabled so choosing one explains which file is in the way.
    if (results?.some(result => result.status === "installedOtherVersion" || result.status === "unrecognized" ||
        result.status === (action === "install" ? "notInstalled" : "installedSameVersion"))) return undefined;
    if (results?.every(result => result.status === "appNotFound")) return "Word and PowerPoint were not found.";
    if (results?.some(result => result.status === "unavailable")) {
      return "Could not check the Office add-in in " + results
        .filter(result => result.status === "unavailable")
        .map(result => appNames[result.app]).join(" and ") + ".";
    }
    return action === "install" ? "The current Office add-in is already installed." : "The Office add-in is not installed.";
  };
  return (["install", "remove"] as const).map(action => {
    const disabledReason = disabledFor(action);
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
  "Microsoft describes this way of adding add-ins as meant for testing and may change it.",
  "The add-in loads its editor from https://chemdraft.ai.",
  "To remove it, choose Help > Remove Office Add-in in ChemDraft."
].join("\n\n");

function unrecognizedMessage(action: OfficeAddinAction, app: string, path = "ChemDraft's add-in manifest file"): string {
  const file = path + " is not a ChemDraft add-in manifest";
  return action === "install"
    ? app + " was not changed. " + file + ", so ChemDraft did not replace it. Move or delete that file, then choose Install Office Add-in again."
    : app + " was not changed. " + file + ", so ChemDraft did not remove it.";
}

interface OfficeAddinPort {
  invoke(command: "office_addin_install" | "office_addin_remove"): Promise<OfficeAddinResult[]>;
  prompt: typeof nativePrompt;
  setStatus: (text: string) => void;
}

export async function runOfficeAddinAction(action: OfficeAddinAction, port: OfficeAddinPort): Promise<OfficeAddinState | undefined> {
  const title = action === "install" ? "Install Office Add-in" : "Remove Office Add-in";
  const notice = async (message: string, kind: "info" | "warning" | "error") => {
    await port.prompt({
      title, message, kind, owner: "document", choices: [{ id: "ok", label: "OK", cancel: true }]
    }, async () => {
      port.setStatus(message.replaceAll("\n\n", " "));
      return "ok";
    });
  };
  if (action === "install") {
    const choice = await port.prompt({
      title, message: installConfirmation, kind: "warning", owner: "document",
      choices: [{ id: "install", label: "Install" }, { id: "cancel", label: "Cancel", cancel: true }]
    }, async () => {
      port.setStatus("Could not open the Office add-in installation confirmation.");
      return "cancel";
    });
    if (choice !== "install") return;
  }

  let results: OfficeAddinResult[];
  try {
    results = await port.invoke(action === "install" ? "office_addin_install" : "office_addin_remove");
  } catch (error) {
    const message = String(error);
    await notice(title + " failed. " + message, "error");
    return { error: message };
  }

  const messages = results.map(result => {
    const app = appNames[result.app];
    if (result.error) return app + " could not be updated. " + result.error;
    if (result.status === "appNotFound") return app + " was skipped because its Office container was not found.";
    if (result.status === "unrecognized") return unrecognizedMessage(action, app, result.path);
    if (action === "install") return result.changed ? "Installed in " + app + "." : "Already installed in " + app + ".";
    return result.changed ? "Removed from " + app + "." : "The add-in was already absent from " + app + ".";
  });
  const changed = results.filter(result => result.changed).map(result => appNames[result.app]).join(" and ");
  if (changed) {
    messages.push("Restart " + changed + (action === "install" ? ", then choose Edit Structure on the Home tab." : " to finish removing the add-in."));
  }
  await notice(messages.join("\n\n"), results.some(result => result.error || result.status === "unrecognized") ? "warning" : "info");
  return { results };
}

export function useOfficeAddinCommands(supported: boolean, setStatus: (text: string) => void) {
  const [state, setState] = useState<OfficeAddinState>({});
  const busy = useRef(false);
  const request = useRef(0);

  useEffect(() => {
    if (!supported) return;
    const refresh = async () => {
      if (busy.current) return;
      const id = ++request.current;
      try {
        const results = await invoke<OfficeAddinResult[]>("office_addin_status");
        if (id === request.current) setState({ results });
      } catch (error) {
        if (id === request.current) setState({ error: String(error) });
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      request.current++;
      window.removeEventListener("focus", refresh);
    };
  }, [supported]);

  const run = useCallback(async (action: OfficeAddinAction) => {
    if (!supported || busy.current) return;
    busy.current = true;
    const id = ++request.current;
    setState(current => ({ ...current, busy: true }));
    try {
      const result = await runOfficeAddinAction(action, { invoke, prompt: nativePrompt, setStatus });
      if (id === request.current && result) setState({ ...result, busy: true });
    } finally {
      busy.current = false;
      if (id === request.current) setState(current => ({ ...current, busy: false }));
    }
  }, [supported, setStatus]);

  return useMemo(() => {
    const bindings = officeAddinCommands(supported, state);
    return { bindings, run, menuItems: officeAddinMenuItems(supported, bindings) };
  }, [supported, state, run]);
}
