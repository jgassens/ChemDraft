import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every dialog plugin caller (file open and save, plugin package and image pickers, spectrum export,
// and nativePrompt) runs in the document window; other windows route through it. Any grant counts,
// including the deprecated aliases: in tauri-plugin-dialog 2.7 allow-ask and allow-confirm both
// allow the message command, and dialog:default allows message, open and save.
const DIALOG_WINDOWS = ["main"];
const capabilitiesDir = new URL("../src-tauri/capabilities/", import.meta.url);

type Capability = { identifier: string; windows?: string[]; webviews?: string[]; permissions: (string | { identifier: string })[] };
const capabilities = readdirSync(capabilitiesDir).filter((name) => name.endsWith(".json")).map((name) => ({
  name, capability: JSON.parse(readFileSync(new URL(name, capabilitiesDir), "utf8")) as Capability
}));
const dialogPermissions = (capability: Capability) => capability.permissions
  .map((permission) => typeof permission === "string" ? permission : permission.identifier)
  .filter((identifier) => identifier === "dialog" || identifier.startsWith("dialog:"));

describe("dialog capabilities", () => {
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
});
