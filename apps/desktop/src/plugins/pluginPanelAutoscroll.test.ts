import { describe, expect, it } from "vitest";

import { isScrolledToBottom, shouldAutoscroll } from "./pluginPanelAutoscroll";

describe("plugin panel autoscroll", () => {
  it("recognises the bottom and its tolerance", () => {
    expect(isScrolledToBottom({ scrollHeight: 600, clientHeight: 200, scrollTop: 400 })).toBe(true);
    expect(isScrolledToBottom({ scrollHeight: 600, clientHeight: 200, scrollTop: 377 })).toBe(true);
    expect(isScrolledToBottom({ scrollHeight: 600, clientHeight: 200, scrollTop: 375 })).toBe(false);
    expect(isScrolledToBottom({ scrollHeight: 600, clientHeight: 200, scrollTop: 390 }, 5)).toBe(false);
  });

  it("follows output only for readers at the bottom or their own submit", () => {
    expect(shouldAutoscroll({ wasAtBottom: true, ownSubmit: false })).toBe(true);
    expect(shouldAutoscroll({ wasAtBottom: false, ownSubmit: true })).toBe(true);
    expect(shouldAutoscroll({ wasAtBottom: false, ownSubmit: false })).toBe(false);
  });
});
