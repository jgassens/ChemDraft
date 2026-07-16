// @vitest-environment jsdom

import { molscribeOcsrCommandId } from "@chemdraft/molscribe-ocsr-plugin";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { usePluginRuntime, type PluginRuntimeView } from "./usePluginRuntime";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
});

function Probe({ registry, capture }: { registry: CommandRegistry; capture: (view: PluginRuntimeView) => void }) {
  capture(
    usePluginRuntime({
      getActiveDocument: () => undefined,
      getSelection: () => ({ objectIds: [], molecules: [] }),
      commandRegistry: registry
    })
  );
  return null;
}

describe("usePluginRuntime on the shared command registry", () => {
  it("isPluginCommand is a pluginId-ownership check, not registry membership (study R3)", async () => {
    const registry = new CommandRegistry();
    let coreRan = 0;
    registry.register({ id: "core.probe", title: "Probe", source: "core" }, () => {
      coreRan += 1;
      return undefined;
    });

    let view: PluginRuntimeView | undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(Probe, {
          registry,
          capture: (captured) => {
            view = captured;
          }
        })
      );
      await Promise.resolve();
    });

    // The host shares the injected registry, so membership alone would misclassify core commands.
    expect(view!.runtime.host.commands).toBe(registry);
    expect(view!.runtime.host.commands.has("core.probe")).toBe(true);
    expect(view!.isPluginCommand("core.probe")).toBe(false);
    expect(view!.isPluginCommand(molscribeOcsrCommandId)).toBe(true);
    expect(view!.isPluginCommand("no.such.command")).toBe(false);

    // Single dispatch: the same invoke path reaches core commands in the shared registry.
    await act(async () => {
      await view!.invokePluginCommand("core.probe");
    });
    expect(coreRan).toBe(1);
  });
});
