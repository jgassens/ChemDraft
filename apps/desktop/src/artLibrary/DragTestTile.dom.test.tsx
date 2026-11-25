// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DragTestTile } from "./DragTestTile";
import type { ArtDragEnded, DragTestBridge } from "./dragTestHarness";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function bridge(path: string | null) {
  let end: ((ended: ArtDragEnded) => void) | undefined;
  const fake: DragTestBridge & { end(ended: ArtDragEnded): void } = {
    prepare: vi.fn(async () => path),
    startDrag: vi.fn(async (_path: string, onEnd: (ended: ArtDragEnded) => void) => { end = onEnd; }),
    end: ended => end?.(ended)
  };
  return fake;
}

function pointer(target: Element, type: string, init: { x: number; y: number; buttons?: number; button?: number }) {
  // jsdom has no PointerEvent; React reads these fields from a MouseEvent of the pointer type.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.x, clientY: init.y,
    buttons: init.buttons ?? 1, button: init.button ?? 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => { target.dispatchEvent(event); });
}

describe("DragTestTile (development builds only)", () => {
  it("renders nothing when Rust answers null, as a stable build does", async () => {
    const fake = bridge(null);
    await act(async () => root.render(createElement(DragTestTile, { bridge: fake })));
    expect(fake.prepare).toHaveBeenCalledOnce();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when Rust refuses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake: DragTestBridge = { prepare: vi.fn(async () => { throw new Error("denied"); }), startDrag: vi.fn() };
    await act(async () => root.render(createElement(DragTestTile, { bridge: fake })));
    expect(container.innerHTML).toBe("");
    expect(warn).toHaveBeenCalled();
  });

  it("starts one drag of the prepared file once the pointer passes the threshold, and reports the end", async () => {
    const path = "/Users/ada/Library/Application Support/org.chemdraft.desktop.dev/art-library/spike/drag-test.svg";
    const fake = bridge(path);
    await act(async () => root.render(createElement(DragTestTile, { bridge: fake })));
    const tile = container.querySelector("[data-drag-test-path]")!;
    expect(tile.getAttribute("data-drag-test-path")).toBe(path);

    pointer(tile, "pointerdown", { x: 10, y: 10 });
    pointer(tile, "pointermove", { x: 12, y: 11 });
    expect(fake.startDrag).not.toHaveBeenCalled();
    pointer(tile, "pointermove", { x: 20, y: 10 });
    pointer(tile, "pointermove", { x: 30, y: 10 });
    expect(fake.startDrag).toHaveBeenCalledOnce();
    expect(vi.mocked(fake.startDrag).mock.calls[0]![0]).toBe(path);
    expect(container.querySelector("[role=status]")!.textContent).toBe("Dragging…");

    await act(async () => fake.end({ outcome: "dropped", x: 400, y: 300 }));
    expect(container.querySelector("[role=status]")!.textContent).toBe("Dropped (pointer at 400, 300).");
  });

  it("ignores moves without the primary button held and other buttons' presses", async () => {
    const fake = bridge("/a/art-library/spike/drag-test.svg");
    await act(async () => root.render(createElement(DragTestTile, { bridge: fake })));
    const tile = container.querySelector("[data-drag-test-path]")!;
    pointer(tile, "pointerdown", { x: 0, y: 0, button: 2, buttons: 2 });
    pointer(tile, "pointermove", { x: 50, y: 0, buttons: 2 });
    pointer(tile, "pointerdown", { x: 0, y: 0 });
    pointer(tile, "pointermove", { x: 50, y: 0, buttons: 0 });
    pointer(tile, "pointerup", { x: 50, y: 0, buttons: 0 });
    pointer(tile, "pointermove", { x: 90, y: 0 });
    expect(fake.startDrag).not.toHaveBeenCalled();
  });

  it("shows Rust's refusal", async () => {
    const fake = bridge("/a/art-library/spike/drag-test.svg");
    vi.mocked(fake.startDrag).mockRejectedValueOnce("Art drag refused: \"/a\" is outside the art library folders.");
    await act(async () => root.render(createElement(DragTestTile, { bridge: fake })));
    const tile = container.querySelector("[data-drag-test-path]")!;
    pointer(tile, "pointerdown", { x: 0, y: 0 });
    await act(async () => { pointer(tile, "pointermove", { x: 9, y: 0 }); });
    expect(container.querySelector("[role=status]")!.textContent).toMatch(/outside the art library/);
  });
});
