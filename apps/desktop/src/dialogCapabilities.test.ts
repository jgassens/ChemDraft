import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDialogLabel } from "./dialogs/dialogLabels";

// Every dialog plugin caller (file open and save, plugin package and image pickers, spectrum export,
// and nativePrompt) runs in the document window; other windows route through it. Any grant counts,
// including the deprecated aliases: in tauri-plugin-dialog 2.7 allow-ask and allow-confirm both
// allow the message command, and dialog:default allows message, open and save.
const DIALOG_WINDOWS = ["main", "doc-*"];
const SUSPEND_TOOLSET_WINDOWS_PERMISSION = "allow-suspend-toolset-windows";
const capabilitiesDir = new URL("../src-tauri/capabilities/", import.meta.url);

type Capability = { identifier: string; windows?: string[]; webviews?: string[]; permissions: (string | { identifier: string })[] };
const capabilities = readdirSync(capabilitiesDir).filter((name) => name.endsWith(".json")).map((name) => ({
  name, capability: JSON.parse(readFileSync(new URL(name, capabilitiesDir), "utf8")) as Capability
}));
const dialogPermissions = (capability: Capability) => capability.permissions
  .map((permission) => typeof permission === "string" ? permission : permission.identifier)
  .filter((identifier) => identifier === "dialog" || identifier.startsWith("dialog:"));
const permissionIdentifiers = (capability: Capability) => capability.permissions
  .map((permission) => typeof permission === "string" ? permission : permission.identifier);

describe("dialog capabilities", () => {
  it("admits owner-qualified dialog kinds and refuses utilities and malformed labels", () => {
    const host = capabilities.find(({ name }) => name === "dialog-host.json")!.capability;
    const matches = (label: string) => host.windows!.some(pattern =>
      new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(label));
    for (const owner of ["main", "doc-a", "doc-b-1234"]) {
      expect(matches(`dialog-${owner}-pageSize-1`)).toBe(true);
      expect(parseDialogLabel(`dialog-${owner}-pageSize-1`)).toBeDefined();
    }
    for (const label of ["main", "doc-a", "toolset-core-main", "toolset-dialog-main-pageSize-1",
      "plugin-panel-dialog-main-pageSize-1", "preferences", "runtime", "dialog-main-unknown-1", "dialog-main-pageSize"]) {
      expect(matches(label), label).toBe(false);
    }
    // Capability globs are only the outer namespace gate. Native parsing and registry/session
    // authorization additionally reject malformed owner/slot components before either command.
    for (const label of ["dialog--pageSize-1", "dialog-main/pageSize-pageSize-1", "dialog-main-pageSize-../main", "dialog-main-pageSize-"]) {
      expect(parseDialogLabel(label), label).toBeUndefined();
    }
  });
  it("keeps document authority out of every utility label", () => {
    const matches = (capability: Capability, label: string) => capability.windows?.some(pattern =>
      pattern.endsWith("*") ? label.startsWith(pattern.slice(0, -1)) : pattern === label) ?? false;
    for (const name of ["dialog-owner.json", "document-dialogs.json"]) {
      const capability = capabilities.find(entry => entry.name === name)!.capability;
      expect(matches(capability, "main")).toBe(true);
      expect(matches(capability, "doc-example")).toBe(true);
      for (const utility of ["dialog-main-export-1", "toolset-core-main", "toolset-popover-core-main",
        "toolset-tooltip", "plugin-panel-example", "preferences", "spin3d-debugger", "runtime"]) {
        expect(matches(capability, utility), `${name}: ${utility}`).toBe(false);
      }
    }
  });
  it("grants content-size reporting only to the actual Preferences window", () => {
    const granted = capabilities.filter(({ capability }) => permissionIdentifiers(capability)
      .includes("allow-preferences-ready"));
    expect(granted.map(({ name }) => name)).toEqual(["preferences-layout.json"]);
    expect(granted[0]!.capability.windows).toEqual(["preferences"]);
    expect(granted[0]!.capability.webviews).toBeUndefined();
    expect(granted[0]!.capability.permissions).toEqual(["allow-preferences-ready"]);
  });
  it("gives draft windows only validated channel transport with no generic event permissions", () => {
    const host = capabilities.find(({ name }) => name === "dialog-host.json")!.capability;
    // Each native dialog kind gets only the same validated request/send transport.
    expect(host.windows).toEqual(["dialog-*-reactionConditions-*", "dialog-*-pageSize-*", "dialog-*-arrangementSpacing-*", "dialog-*-insertTable-*", "dialog-*-customColor-*", "dialog-*-export-*", "dialog-*-engineInstall-*", "dialog-*-toolInstall-*", "dialog-*-structureTemplates-*", "dialog-*-atomProblem-*", "dialog-*-vibeCodeGuide-*"]);
    expect(host.permissions.slice().sort()).toEqual([
      "allow-dialog-request", "allow-dialog-send"
    ]);
    const owner = capabilities.find(({ name }) => name === "dialog-owner.json")!.capability;
    expect(owner.windows).toEqual(["main", "doc-*"]);
    expect(owner.permissions.slice().sort()).toEqual(["allow-dialog-close", "allow-dialog-open", "allow-dialog-publish"]);
  });
  it("grant dialog permissions, aliases included, to the document window alone", () => {
    const granted = capabilities.filter(({ capability }) => dialogPermissions(capability).length > 0);
    expect(granted.map(({ name }) => name)).toEqual(["document-dialogs.json"]);
    for (const { name, capability } of granted) {
      expect(capability.windows, name).toEqual(DIALOG_WINDOWS);
      expect(capability.webviews, name).toBeUndefined();
      expect((capability as { remote?: unknown }).remote, name).toBeUndefined();
    }
  });

  it("grant exactly open, save and message to the document window on both platforms", () => {
    const { capability } = capabilities.find(({ name }) => name === "document-dialogs.json")!;
    expect(dialogPermissions(capability).sort()).toEqual(["dialog:allow-message", "dialog:allow-open", "dialog:allow-save"]);
    expect((capability as { platforms?: unknown }).platforms).toBeUndefined();
  });

  it("grants native prompt toolset suspension to the document window alone", () => {
    const granted = capabilities.filter(({ capability }) => permissionIdentifiers(capability)
      .includes(SUSPEND_TOOLSET_WINDOWS_PERMISSION));
    expect(granted.map(({ name }) => name)).toEqual(["document-dialogs.json"]);
    expect(granted[0]!.capability.windows).toEqual(DIALOG_WINDOWS);
    expect(granted[0]!.capability.webviews).toBeUndefined();
  });
});
