// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installPluginPanelPointerFeed } from "./pluginPanelPointerFeed";

const feed = vi.hoisted(() => ({
  move: undefined as undefined | ((point: { x: number; y: number }) => void),
  leave: undefined as undefined | (() => void),
  unlisten: vi.fn(),
  listen: vi.fn()
}));
vi.mock("../window-manager", () => ({
  listenForPalettePointer: async (label: string, handler: typeof feed.move) => {
    feed.listen(label); feed.move = handler; return feed.unlisten;
  },
  listenForPalettePointerLeave: async (_label: string, handler: typeof feed.leave) => {
    feed.leave = handler; return feed.unlisten;
  }
}));
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.(); cleanup = undefined;
  document.body.replaceChildren();
  Reflect.deleteProperty(document, "elementFromPoint");
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

it("keeps hover and chart pointer motion working in a non-key panel, without requesting focus", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const button = document.createElement("button");
  document.body.append(button);
  const hitTest = vi.fn(() => button);
  Object.defineProperty(document, "elementFromPoint", { value: hitTest, configurable: true });
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const move = vi.fn(); const over = vi.fn(); const out = vi.fn();
  button.addEventListener("pointermove", move);
  button.addEventListener("pointerover", over);
  button.addEventListener("pointerout", out);
  cleanup = installPluginPanelPointerFeed("panel.test");
  await Promise.resolve();
  expect(feed.listen).toHaveBeenCalledWith("plugin-panel-panel:test");
  feed.move!({ x: 30, y: 40 });
  expect(over).toHaveBeenCalledOnce(); expect(move).toHaveBeenCalledOnce();
  expect(move.mock.calls[0]![0].clientX).toBe(30);
  expect(button.classList.contains("panel-synthetic-hover")).toBe(true);
  feed.leave!();
  expect(out).toHaveBeenCalledOnce();
  expect(button.classList.contains("panel-synthetic-hover")).toBe(false);
});

it("does not duplicate pointer events while the input has native keyboard focus", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const hitTest = vi.fn();
  Object.defineProperty(document, "elementFromPoint", { value: hitTest, configurable: true });
  cleanup = installPluginPanelPointerFeed("panel.test");
  await Promise.resolve();
  feed.move!({ x: 30, y: 40 });
  expect(hitTest).not.toHaveBeenCalled();
});
