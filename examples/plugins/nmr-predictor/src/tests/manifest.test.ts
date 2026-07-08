import { parsePluginManifest, validatePluginManifest } from "@chemdraft/plugin-api";
import { PluginHost } from "@chemdraft/plugin-host";
import { describe, expect, it } from "vitest";

import {
  nmrPredictCarbonCommandId,
  nmrPredictProtonCommandId,
  nmrPredictorManifest,
  nmrPredictorPanelId
} from "../manifest";

describe("nmrPredictorManifest", () => {
  it("is a valid plugin manifest", () => {
    expect(validatePluginManifest(nmrPredictorManifest).ok).toBe(true);
    const parsed = parsePluginManifest(nmrPredictorManifest);
    expect(parsed.id).toBe("org.chemdraft.nmr.predictor");
    expect(parsed.contributes.commands.map((command) => command.id)).toEqual([
      nmrPredictCarbonCommandId,
      nmrPredictProtonCommandId
    ]);
    expect(parsed.contributes.menus).toHaveLength(2);
    expect(parsed.contributes.analyzers).toHaveLength(1);
    expect(parsed.contributes.panels[0]?.id).toBe(nmrPredictorPanelId);
  });

  it("registers through the real host, with all contribution command references resolvable", () => {
    const host = new PluginHost();
    // assertContributionCommands (M2) rejects menu/panel/analyzer entries referencing a
    // non-contributed command; a clean registration proves the manifest is internally consistent.
    expect(() =>
      host.registerPlugin(nmrPredictorManifest, {
        commandHandlers: {
          [nmrPredictCarbonCommandId]: async () => undefined,
          [nmrPredictProtonCommandId]: async () => undefined
        }
      })
    ).not.toThrow();

    expect(host.listMenuContributions("analyze").map((entry) => entry.contribution.commandId)).toEqual([
      nmrPredictCarbonCommandId,
      nmrPredictProtonCommandId
    ]);
  });
});
