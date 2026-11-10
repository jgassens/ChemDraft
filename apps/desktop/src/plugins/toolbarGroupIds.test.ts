import { PLUGIN_TOOLBAR_GROUP_IDS } from "@chemdraft/plugin-api";
import { MAIN_TOOLBAR_GROUP_IDS } from "@chemdraft/toolset-registry";
import { expect, it } from "vitest";

it("keeps public plugin toolbar group ids aligned with the main toolbar", () => {
  expect(PLUGIN_TOOLBAR_GROUP_IDS).toEqual(MAIN_TOOLBAR_GROUP_IDS.filter(id => id !== "undeclared"));
});
