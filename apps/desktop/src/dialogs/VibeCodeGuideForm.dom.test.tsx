// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { VibeCodeGuideForm } from "./VibeCodeGuideForm";
import { VIBE_CODE_GUIDE } from "./vibeCodeGuideText";

it("requests content fitting with its form element once", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); const ready = vi.fn(); const action = vi.fn();
  act(() => root.render(createElement(VibeCodeGuideForm, { onAction: action, onReady: ready })));
  expect(ready).toHaveBeenCalledOnce();
  expect(ready).toHaveBeenCalledWith(container.querySelector("form"));
  act(() => root.render(createElement(VibeCodeGuideForm, { onAction: action, onReady: vi.fn() })));
  expect(ready).toHaveBeenCalledOnce();
  act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
});

it("sends only the selected action for each button and Escape", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); const action = vi.fn();
  act(() => root.render(createElement(VibeCodeGuideForm, { onAction: action })));
  expect(container.querySelectorAll("li")).toHaveLength(5);
  expect(container.textContent).toContain(VIBE_CODE_GUIDE.safety);
  expect(container.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
  expect(container.querySelectorAll("li")[4]!.textContent).not.toContain("….");
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons).toHaveLength(3);
  expect(buttons.every(button => button.matches(".cd-page-size-form button"))).toBe(true);
  expect(buttons[2]!.closest(".cd-page-size-buttons.cd-dialog-fit-footer")).not.toBeNull();
  expect(container.querySelector(".cd-page-size-buttons button[type=submit]")).toBe(buttons[2]);
  act(() => buttons[0]!.click()); expect(action).toHaveBeenLastCalledWith("saveStarter");
  act(() => buttons[1]!.click()); expect(action).toHaveBeenLastCalledWith("openPluginManager");
  act(() => buttons[2]!.click()); expect(action).toHaveBeenLastCalledWith("cancel");
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(action.mock.calls).toEqual([["saveStarter"], ["openPluginManager"], ["cancel"], ["cancel"]]);
  act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(action).toHaveBeenLastCalledWith("cancel");
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(action.mock.calls).toEqual([["saveStarter"], ["openPluginManager"], ["cancel"], ["cancel"], ["cancel"], ["cancel"]]);
  act(() => buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(action).toHaveBeenCalledTimes(6);
  act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
});
