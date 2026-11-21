import { readFileSync } from "node:fs";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { describe, expect, it, vi } from "vitest";
import { createCoreCommandRegistrar, type CoreCommandBindings } from "./coreCommandRegistrar";
import { officeAddinCommands, officeAddinMenuItems, officeAddinSupported, runOfficeAddinAction } from "./officeAddin";
import { buildMainWindowNativeMenuItems } from "../plugins/nativePluginMenu";

type State = Parameters<typeof officeAddinCommands>[1];
type Port = Parameters<typeof runOfficeAddinAction>[1];

const wordMissing = { app: "word", status: "appNotFound", changed: false } as const;
const powerpointMissing = { app: "powerPoint", status: "appNotFound", changed: false } as const;
const uninstalled = { app: "word", status: "notInstalled", changed: false } as const;
const installed = { app: "word", status: "installedSameVersion", changed: true } as const;
const outdated = { app: "word", status: "installedOtherVersion", changed: false } as const;
const wordPath = "/Users/someone/Library/Containers/com.microsoft.Word/Data/Documents/wef/chemdraft-office-addin.xml";
const foreign = { app: "word", status: "unrecognized", changed: false, path: wordPath } as const;
const deniedPowerPoint = {
  app: "powerPoint", status: "unavailable", changed: false, errorKind: "permissionDenied", error: "Operation not permitted (os error 1)",
  bundleIdentifier: "org.chemdraft.desktop"
} as const;

function createPort() {
  return { invoke: vi.fn<Port["invoke"]>(), prompt: vi.fn<Port["prompt"]>(), setStatus: vi.fn() };
}

function registryFor(supported: boolean, state: State, port: Port) {
  const registry = new CommandRegistry();
  const bindings: CoreCommandBindings = new Map(officeAddinCommands(supported, state).map(({ spec, action }) => [
    spec.id, { spec, run: async () => { await runOfficeAddinAction(action, port); } }
  ]));
  createCoreCommandRegistrar(registry, () => bindings)(bindings);
  return registry;
}

describe("Office add-in commands", () => {
  it.each([
    [true, "windows"],
    [true, "linux"],
    [false, "macos"]
  ] as const)("disables and hides native actions when desktop is %s on %s", async (desktop, platform) => {
    const supported = officeAddinSupported(desktop, platform);
    const port = createPort();
    const registry = registryFor(supported, {}, port);
    expect(officeAddinMenuItems(supported, officeAddinCommands(supported, {}))).toEqual([]);
    for (const id of ["office.installAddin", "office.removeAddin"]) {
      await expect(registry.invoke(id)).rejects.toThrow("available in the ChemDraft app on macOS");
    }
    expect(port.prompt).not.toHaveBeenCalled();
    expect(port.invoke).not.toHaveBeenCalled();
  });

  it("shows both Help rows enabled from the first menu build, with no status check", () => {
    const supported = officeAddinSupported(true, "macos");
    const bindings = officeAddinCommands(supported, {});
    expect(bindings.map(({ spec }) => [spec.enabled, spec.disabledReason])).toEqual([[true, undefined], [true, undefined]]);
    expect(buildMainWindowNativeMenuItems(officeAddinMenuItems(supported, bindings)).filter(item => item.location === "help")).toEqual([
      { id: "office.installAddin", label: "Install Office Add-in…", enabled: true, coreRouted: true, location: "help" },
      { id: "office.removeAddin", label: "Remove Office Add-in…", enabled: true, coreRouted: true, location: "help" }
    ]);
    // Reading Word's and PowerPoint's containers can raise macOS's "access data from other apps"
    // prompt, so nothing reads them until the user chooses an action: no status command, nothing on
    // mount or focus.
    const source = readFileSync(new URL("./officeAddin.ts", import.meta.url), "utf8");
    expect(source).not.toContain("office_addin_status");
    expect(source).not.toContain("useEffect");
    expect(source).not.toContain("addEventListener");
    expect(source).not.toContain("Checking Office add-in status");
  });

  it("disables both rows, with a reason, only while an action runs", () => {
    const bindings = officeAddinCommands(true, { busy: true });
    expect(bindings.map(({ spec }) => [spec.enabled, spec.disabledReason])).toEqual([
      [false, "Office add-in management is in progress."],
      [false, "Office add-in management is in progress."]
    ]);
  });

  it("requires affirmative native confirmation before invoking install", async () => {
    const port = createPort();
    let answer!: (choice: string) => void;
    port.prompt.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const registry = registryFor(true, {}, port);
    const installing = registry.invoke("office.installAddin");
    expect(port.prompt.mock.calls[0]?.[0]).toMatchObject({
      owner: "document",
      choices: [{ id: "install", label: "Install" }, { id: "cancel", label: "Cancel", cancel: true }]
    });
    const text = port.prompt.mock.calls[0]?.[0].message;
    expect(text).toContain("adds ChemDraft to Word and PowerPoint on this Mac");
    expect(text).toContain("Microsoft describes this way of adding add-ins as meant for testing and may change it");
    expect(text).toContain("loads its editor from https://chemdraft.ai");
    expect(text).toContain("Help > Remove Office Add-in");
    expect(text).toContain("Next, macOS will ask to let ChemDraft access data from other apps, because the add-in file goes into " +
      "Word's and PowerPoint's own folders. Choose Allow to install it; if you choose Don't Allow, Office is left unchanged.");
    // The macOS sentence comes before the add-in is written, right after what Install does.
    expect(text.split("\n\n")[1]).toMatch(/^Next, macOS will ask/);
    expect(port.invoke).not.toHaveBeenCalled();
    answer("cancel");
    await installing;
    expect(port.invoke).not.toHaveBeenCalled();
  });

  it("requires affirmative native confirmation before invoking remove", async () => {
    const port = createPort();
    let answer!: (choice: string) => void;
    port.prompt.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const removing = registryFor(true, {}, port).invoke("office.removeAddin");
    expect(port.prompt.mock.calls[0]?.[0]).toMatchObject({
      title: "Remove Office Add-in",
      owner: "document",
      choices: [{ id: "remove", label: "Remove" }, { id: "cancel", label: "Cancel", cancel: true }]
    });
    expect(port.prompt.mock.calls[0]?.[0].message).toBe(
      "This removes ChemDraft from Word and PowerPoint on this Mac.\n\n" +
      "macOS may ask to let ChemDraft access data from other apps, because the add-in file is in Word's and PowerPoint's own folders. " +
      "Choose Allow to remove it; if you choose Don't Allow, Office is left unchanged."
    );
    expect(port.invoke).not.toHaveBeenCalled();
    answer("cancel");
    await removing;
    expect(port.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["installAddin", "Could not open the Office add-in installation confirmation."],
    ["removeAddin", "Could not open the Office add-in removal confirmation."]
  ] as const)("cancels %s if the native confirmation cannot open", async (command, status) => {
    const port = createPort();
    port.prompt.mockImplementationOnce((prompt, fallback) => fallback!(prompt));
    await registryFor(true, {}, port).invoke("office." + command);
    expect(port.invoke).not.toHaveBeenCalled();
    expect(port.setStatus).toHaveBeenCalledWith(status);
  });

  it("shows where to find Edit Structure after installing and reports an app that was skipped", async () => {
    const port = createPort();
    port.prompt.mockResolvedValueOnce("install").mockResolvedValueOnce("ok").mockResolvedValueOnce("install").mockResolvedValueOnce("ok");
    port.invoke.mockResolvedValueOnce([installed, { ...installed, app: "powerPoint" }])
      .mockResolvedValueOnce([installed, powerpointMissing]);
    const registry = registryFor(true, {}, port);
    await registry.invoke("office.installAddin");
    expect(port.invoke).toHaveBeenCalledWith("office_addin_install");
    expect(port.prompt.mock.calls[1]?.[0].message).toContain("Restart Word and PowerPoint, then choose Edit Structure on the Home tab.");
    await registry.invoke("office.installAddin");
    expect(port.prompt.mock.calls[3]?.[0].message).toContain("PowerPoint was skipped because its Office container was not found.");
    expect(port.prompt.mock.calls[3]?.[0].message).toContain("Restart Word, then choose Edit Structure on the Home tab.");
  });

  it("reports the other app's failure and that the first app was restored", async () => {
    const port = createPort();
    port.prompt.mockResolvedValueOnce("remove").mockResolvedValue("ok");
    port.invoke.mockResolvedValue([
      { ...installed, changed: false, rolledBack: true },
      { app: "powerPoint", status: "unavailable", error: "No space left on device", errorKind: "other", changed: false }
    ]);
    const registry = registryFor(true, {}, port);
    await registry.invoke("office.removeAddin");
    expect(port.invoke).toHaveBeenCalledOnce();
    expect(port.invoke).toHaveBeenCalledWith("office_addin_remove");
    expect(port.prompt.mock.calls[1]?.[0]).toMatchObject({ kind: "warning" });
    expect(port.prompt.mock.calls[1]?.[0].message).toBe("Word was not changed.\n\nPowerPoint could not be updated. No space left on device");
  });

  it.each([
    [[uninstalled, powerpointMissing], "The Office add-in is not installed in Word or PowerPoint, so nothing was removed."],
    [[uninstalled, { ...uninstalled, app: "powerPoint" }], "The Office add-in is not installed in Word or PowerPoint, so nothing was removed."],
    [[wordMissing, powerpointMissing], "Word and PowerPoint were not found on this Mac, so nothing was removed."]
  ] as const)("says plainly when Remove finds nothing installed (%j)", async (results, expected) => {
    const port = createPort();
    port.prompt.mockResolvedValueOnce("remove").mockResolvedValue("ok");
    port.invoke.mockResolvedValue([...results]);
    await runOfficeAddinAction("remove", port);
    expect(port.invoke).toHaveBeenCalledWith("office_addin_remove");
    expect(port.prompt.mock.calls[1]?.[0]).toMatchObject({ kind: "info", title: "Remove Office Add-in" });
    expect(port.prompt.mock.calls[1]?.[0].message).toBe(expected);
  });

  it("reports what Remove removed", async () => {
    const port = createPort();
    port.prompt.mockResolvedValueOnce("remove").mockResolvedValue("ok");
    port.invoke.mockResolvedValue([{ app: "word", status: "notInstalled", changed: true }, powerpointMissing]);
    await runOfficeAddinAction("remove", port);
    expect(port.prompt.mock.calls[1]?.[0].message).toBe(
      "Removed from Word.\n\nPowerPoint was skipped because its Office container was not found.\n\nRestart Word to finish removing the add-in."
    );
  });

  it.each([
    ["install", "office_addin_install", "Install Office Add-in", "org.chemdraft.desktop"],
    ["remove", "office_addin_remove", "Remove Office Add-in", "org.chemdraft.desktop.dev"]
  ] as const)("explains a macOS permission denial on %s, how to retry and how to reset the decision", async (action, command, item, bundleIdentifier) => {
    const port = createPort();
    port.prompt.mockResolvedValueOnce(action).mockResolvedValue("ok");
    const denied = { ...deniedPowerPoint, bundleIdentifier };
    port.invoke.mockResolvedValue([{ ...uninstalled, rolledBack: true }, denied]);
    const results = await runOfficeAddinAction(action, port);
    expect(port.invoke).toHaveBeenCalledWith(command);
    const report = port.prompt.mock.calls.at(-1)?.[0];
    expect(report).toMatchObject({ kind: "warning", title: item });
    expect(report?.message).toBe(
      "Office was not changed, because macOS did not allow ChemDraft to access Word's and PowerPoint's data." +
      "\n\nChoose Help > " + item + " again and click Allow when macOS asks." +
      "\n\nIf macOS does not ask again, reset its decision in Terminal with this command, then try again:" +
      "\n\ntccutil reset SystemPolicyAppData " + bundleIdentifier
    );
    expect(report?.message).not.toContain("Full Disk Access");
    expect(report?.message).not.toContain("System Settings");
    expect(report?.message).not.toContain("Restart");
    expect(report?.message).not.toContain("os error");
    expect(results).toEqual([{ ...uninstalled, rolledBack: true }, denied]);
  });

  it("never invents a bundle identifier for the reset command", async () => {
    const port = createPort();
    port.prompt.mockResolvedValueOnce("install").mockResolvedValue("ok");
    const withoutIdentifier = {
      app: "powerPoint", status: "unavailable", changed: false, errorKind: "permissionDenied", error: deniedPowerPoint.error
    } as const;
    port.invoke.mockResolvedValue([uninstalled, withoutIdentifier]);
    await runOfficeAddinAction("install", port);
    const message = port.prompt.mock.calls.at(-1)?.[0].message;
    expect(message).toBe("Office was not changed, because macOS did not allow ChemDraft to access Word's and PowerPoint's data." +
      "\n\nChoose Help > Install Office Add-in again and click Allow when macOS asks.");
  });

  it("gives only the retry steps when one app did change before the denial", async () => {
    const port = createPort();
    port.prompt.mockResolvedValueOnce("install").mockResolvedValue("ok");
    port.invoke.mockResolvedValue([{ ...installed, error: "ChemDraft could not undo this change after PowerPoint failed: x" }, deniedPowerPoint]);
    await runOfficeAddinAction("install", port);
    const message = port.prompt.mock.calls.at(-1)?.[0].message;
    expect(message).not.toContain("Office was not changed");
    expect(message).toContain("Choose Help > Install Office Add-in again and click Allow when macOS asks.");
    expect(message).toContain("tccutil reset SystemPolicyAppData org.chemdraft.desktop");
  });

  it("keeps Install and Remove enabled after a denial so choosing one again retries", async () => {
    const port = createPort();
    port.prompt.mockImplementation(async prompt => prompt.choices[0]!.id);
    port.invoke.mockResolvedValueOnce([uninstalled, deniedPowerPoint])
      .mockResolvedValueOnce([installed, { ...installed, app: "powerPoint" }]);
    await runOfficeAddinAction("install", port);
    const bindings = officeAddinCommands(true, {});
    expect(bindings.map(({ spec }) => [spec.enabled, spec.disabledReason])).toEqual([[true, undefined], [true, undefined]]);
    await registryFor(true, {}, port).invoke("office.installAddin");
    expect(port.invoke).toHaveBeenCalledTimes(2);
    expect(port.prompt.mock.calls.at(-1)?.[0].message).toContain("Installed in Word.\n\nInstalled in PowerPoint.");
  });

  it.each([
    ["install", "office_addin_install", "Word was not changed. " + wordPath +
      " is not a ChemDraft add-in manifest, so ChemDraft did not replace it. Move or delete that file, then choose Install Office Add-in again."],
    ["remove", "office_addin_remove", "Word was not changed. " + wordPath +
      " is not a ChemDraft add-in manifest, so ChemDraft did not remove it."]
  ] as const)("names the unidentified file it left alone on %s", async (action, command, expected) => {
    const port = createPort();
    port.prompt.mockResolvedValueOnce(action).mockResolvedValue("ok");
    port.invoke.mockResolvedValue([foreign, { ...installed, app: "powerPoint", changed: false }]);
    await runOfficeAddinAction(action, port);
    expect(port.invoke).toHaveBeenCalledWith(command);
    const report = port.prompt.mock.calls.at(-1)?.[0];
    expect(report).toMatchObject({ kind: "warning" });
    expect(report?.message.split("\n\n")[0]).toBe(expected);
    expect(report?.message).not.toContain("Restart");
  });

  it("still names the file in the status line when the report cannot open", async () => {
    const port = createPort();
    port.prompt.mockResolvedValueOnce("remove").mockImplementationOnce((prompt, fallback) => fallback!(prompt));
    port.invoke.mockResolvedValue([foreign, powerpointMissing]);
    await runOfficeAddinAction("remove", port);
    expect(port.setStatus).toHaveBeenCalledWith(expect.stringContaining(wordPath + " is not a ChemDraft add-in manifest"));
  });
});
