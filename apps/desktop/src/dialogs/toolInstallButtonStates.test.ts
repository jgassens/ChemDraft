import { describe, expect, it } from "vitest";
import states from "./toolInstallButtonStates.json";
import { validToolInstallSnapshot } from "./dialogProtocol";
import { toolInstallFixture } from "./toolInstallTestFixtures";

describe("shared tool installation button contract", () => {
  it.each(states)("validates exactly the buttons for $state.status", row => {
    const candidates = [...states.map(state => state.buttons), [], [...row.buttons].reverse(), [...row.buttons, "close"], ["unknown"]];
    for (const buttons of candidates) {
      expect(validToolInstallSnapshot({ ...toolInstallFixture(), state: row.state, buttons }), JSON.stringify(buttons))
        .toBe(JSON.stringify(buttons) === JSON.stringify(row.buttons));
    }
  });
});
