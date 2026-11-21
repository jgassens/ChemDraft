import { expect, it } from "vitest";
import { commandId, manifest } from "./index";
import { createLegacyFixtureRegistration } from "./register";

it("declares API 0.1.25 and contributes all four fixture commands to the Plugins menu", () => {
  const registration = createLegacyFixtureRegistration();
  const commandIds = [commandId("readDocument"), commandId("readSelection"), commandId("beginRequest"), commandId("events")];
  expect(registration.manifest).toBe(manifest);
  expect(manifest.apiVersion).toBe("^0.1.25");
  expect(manifest.entry).toBe("entry.js");
  expect(manifest.contributes.commands.map(command => command.id)).toEqual(commandIds);
  expect(manifest.contributes.menus.map(menu => menu.commandId)).toEqual(commandIds);
  expect(manifest.contributes.menus.every(menu => menu.location === "plugins")).toBe(true);
  expect(Object.keys(registration.commandHandlers)).toEqual(commandIds);
});
