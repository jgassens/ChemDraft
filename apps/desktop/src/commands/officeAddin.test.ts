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
  app: "powerPoint", status: "unavailable", changed: false, errorKind: "permissionDenied", error: "Operation not permitted (os error 1)"
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
    const state = { results: [uninstalled, powerpointMissing] };
    const port = createPort();
    const registry = registryFor(supported, state, port);
    expect(officeAddinMenuItems(supported, officeAddinCommands(supported, state))).toEqual([]);
    for (const id of ["office.installAddin", "office.removeAddin"]) {
      await expect(registry.invoke(id)).rejects.toThrow("available in the ChemDraft app on macOS");
    }
    expect(port.prompt).not.toHaveBeenCalled();
    expect(port.invoke).not.toHaveBeenCalled();
  });

  it.each([
    [[uninstalled, powerpointMissing], [true, false]],
    [[installed, powerpointMissing], [false, true]],
    [[outdated, powerpointMissing], [true, true]],
    [[foreign, powerpointMissing], [true, true]],
    [[wordMissing, powerpointMissing], [false, false]],
    [undefined, [false, false]]
  ] as const)("syncs native Help actions with status %j", (results, enabled) => {
    const supported = officeAddinSupported(true, "macos");
    const bindings = officeAddinCommands(supported, { results });
    expect(bindings.map(({ spec }) => Boolean(spec.disabledReason))).toEqual(enabled.map(value => !value));
    expect(buildMainWindowNativeMenuItems(officeAddinMenuItems(supported, bindings)).filter(item => item.location === "help")).toEqual([
      { id: "office.installAddin", label: "Install Office Add-in…", enabled: enabled[0], coreRouted: true, location: "help" },
      { id: "office.removeAddin", label: "Remove Office Add-in", enabled: enabled[1], coreRouted: true, location: "help" }
    ]);
  });

  it("requires affirmative native confirmation before invoking install", async () => {
    const port = createPort();
    let answer!: (choice: string) => void;
    port.prompt.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const registry = registryFor(true, { results: [uninstalled, powerpointMissing] }, port);
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

  it("cancels install if the native confirmation cannot open", async () => {
    const port = createPort();
    port.prompt.mockImplementationOnce((prompt, fallback) => fallback!(prompt));
    await registryFor(true, { results: [uninstalled, powerpointMissing] }, port).invoke("office.installAddin");
    expect(port.invoke).not.toHaveBeenCalled();
    expect(port.setStatus).toHaveBeenCalledWith("Could not open the Office add-in installation confirmation.");
  });

  it("shows where to find Edit Structure after installing and reports an app that was skipped", async () => {
    const port = createPort();
    port.prompt.mockResolvedValueOnce("install").mockResolvedValueOnce("ok").mockResolvedValueOnce("install").mockResolvedValueOnce("ok");
    port.invoke.mockResolvedValueOnce([installed, { ...installed, app: "powerPoint" }])
      .mockResolvedValueOnce([installed, powerpointMissing]);
    const registry = registryFor(true, { results: [uninstalled, powerpointMissing] }, port);
    await registry.invoke("office.installAddin");
    expect(port.invoke).toHaveBeenCalledWith("office_addin_install");
    expect(port.prompt.mock.calls[1]?.[0].message).toContain("Restart Word and PowerPoint, then choose Edit Structure on the Home tab.");
    await registry.invoke("office.installAddin");
    expect(port.prompt.mock.calls[3]?.[0].message).toContain("PowerPoint was skipped because its Office container was not found.");
    expect(port.prompt.mock.calls[3]?.[0].message).toContain("Restart Word, then choose Edit Structure on the Home tab.");
  });

  it("reports the other app's failure and that the first app was restored", async () => {
    const port = createPort();
    port.prompt.mockResolvedValue("ok");
    port.invoke.mockResolvedValue([
      { ...installed, changed: false, rolledBack: true },
      { app: "powerPoint", status: "unavailable", error: "No space left on device", errorKind: "other", changed: false }
    ]);
    const registry = registryFor(true, { results: [installed, { ...installed, app: "powerPoint" }] }, port);
    await registry.invoke("office.removeAddin");
    expect(port.invoke).toHaveBeenCalledOnce();
    expect(port.invoke).toHaveBeenCalledWith("office_addin_remove");
    expect(port.prompt.mock.calls[0]?.[0]).toMatchObject({ kind: "warning" });
    expect(port.prompt.mock.calls[0]?.[0].message).toBe("Word was not changed.\n\nPowerPoint could not be updated. No space left on device");
  });

  it.each([
    ["install", "office_addin_install", "installed", "Install Office Add-in"],
    ["remove", "office_addin_remove", "removed", "Remove Office Add-in"]
  ] as const)("explains a macOS permission denial on %s and how to allow it", async (action, command, verb, item) => {
    const port = createPort();
    port.prompt.mockResolvedValue(action === "install" ? "install" : "ok");
    port.invoke.mockResolvedValue([{ ...uninstalled, rolledBack: true }, deniedPowerPoint]);
    const state = await runOfficeAddinAction(action, port);
    expect(port.invoke).toHaveBeenCalledWith(command);
    const report = port.prompt.mock.calls.at(-1)?.[0];
    expect(report).toMatchObject({ kind: "warning", title: item });
    expect(report?.message).toBe(
      "Office was not changed. macOS did not allow ChemDraft to access Word's and PowerPoint's data, so the add-in was not " + verb + " in either app." +
      "\n\nTo allow it, choose Help > " + item + " again and choose Allow when macOS asks. If macOS does not ask, open " +
      "System Settings > Privacy & Security > Full Disk Access and turn on ChemDraft (macOS has no separate setting for " +
      "access to other apps' data), then choose Help > " + item + " again."
    );
    expect(report?.message).not.toContain("Restart");
    expect(report?.message).not.toContain("os error");
    expect(state).toEqual({ results: [{ ...uninstalled, rolledBack: true }, deniedPowerPoint] });
  });

  it("keeps Install and Remove enabled after a denial so choosing one again retries", async () => {
    const port = createPort();
    port.prompt.mockResolvedValue("install");
    port.invoke.mockResolvedValueOnce([uninstalled, deniedPowerPoint])
      .mockResolvedValueOnce([installed, { ...installed, app: "powerPoint" }]);
    const state = await runOfficeAddinAction("install", port);
    const bindings = officeAddinCommands(true, state!);
    expect(bindings.map(({ spec }) => [spec.enabled, spec.disabledReason])).toEqual([[true, undefined], [true, undefined]]);
    await registryFor(true, state!, port).invoke("office.installAddin");
    expect(port.invoke).toHaveBeenCalledTimes(2);
    expect(port.prompt.mock.calls.at(-1)?.[0].message).toContain("Installed in Word.\n\nInstalled in PowerPoint.");
    // A status check macOS denied also leaves Install available.
    expect(officeAddinCommands(true, { results: [uninstalled, deniedPowerPoint] })[0]!.spec.enabled).toBe(true);
  });

  it("exists from the first menu build, disabled with a reason, until the status is known", () => {
    const supported = officeAddinSupported(true, "macos");
    const bindings = officeAddinCommands(supported, {});
    expect(bindings.map(({ spec }) => spec.disabledReason)).toEqual(["Checking Office add-in status…", "Checking Office add-in status…"]);
    expect(officeAddinMenuItems(supported, bindings).map(item => item.command)).toEqual([
      expect.objectContaining({ id: "office.installAddin", label: "Install Office Add-in…", enabled: false }),
      expect.objectContaining({ id: "office.removeAddin", label: "Remove Office Add-in", enabled: false })
    ]);
  });

  it.each([
    ["install", "office_addin_install", "Word was not changed. " + wordPath +
      " is not a ChemDraft add-in manifest, so ChemDraft did not replace it. Move or delete that file, then choose Install Office Add-in again."],
    ["remove", "office_addin_remove", "Word was not changed. " + wordPath +
      " is not a ChemDraft add-in manifest, so ChemDraft did not remove it."]
  ] as const)("names the unidentified file it left alone on %s", async (action, command, expected) => {
    const port = createPort();
    port.prompt.mockResolvedValue(action === "install" ? "install" : "ok");
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
    port.prompt.mockImplementationOnce((prompt, fallback) => fallback!(prompt));
    port.invoke.mockResolvedValue([foreign, powerpointMissing]);
    await runOfficeAddinAction("remove", port);
    expect(port.setStatus).toHaveBeenCalledWith(expect.stringContaining(wordPath + " is not a ChemDraft add-in manifest"));
  });
});
