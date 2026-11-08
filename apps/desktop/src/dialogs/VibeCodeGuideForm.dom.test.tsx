// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { VibeCodeGuideForm } from "./VibeCodeGuideForm";
import { VIBE_CODE_GUIDE } from "./vibeCodeGuideText";

it("sends only the selected action for each button and Escape", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); const action = vi.fn();
  act(() => root.render(createElement(VibeCodeGuideForm, { onAction: action })));
  expect(container.querySelectorAll("li")).toHaveLength(5);
  expect(container.textContent).toContain(VIBE_CODE_GUIDE.safety);
  const buttons = [...container.querySelectorAll("button")];
  act(() => buttons[0]!.click()); expect(action).toHaveBeenLastCalledWith("saveStarter");
  act(() => buttons[1]!.click()); expect(action).toHaveBeenLastCalledWith("openPluginManager");
  act(() => buttons[2]!.click()); expect(action).toHaveBeenLastCalledWith("cancel");
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(action.mock.calls).toEqual([["saveStarter"], ["openPluginManager"], ["cancel"], ["cancel"]]);
  act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
});
