// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearNativeClick, installMainWindowPalettePendingKeys, PALETTE_CLICK_TIMEOUT_MS, PALETTE_KEY_GUARD_CLEAR_COMMAND,
  type PaletteClickPendingEvent
} from "./palettePendingKeys";

const native = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown) => undefined) }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: native.invoke }));

const tauriWindow = window as unknown as Record<string, unknown>;

afterEach(() => {
  delete tauriWindow.__TAURI_INTERNALS__;
  native.invoke.mockClear();
});

describe("palette click-outside release", () => {
  it("releases the native guard through the narrow command, which Office editors are granted", async () => {
    tauriWindow.__TAURI_INTERNALS__ = {};
    await clearNativeClick(7, 1_234);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith("palette_key_guard_clear", { sequence: 7, pointerBefore: 1_234 });
    expect(PALETTE_KEY_GUARD_CLEAR_COMMAND).toBe("palette_key_guard_clear");
  });

  it("does nothing outside the desktop runtime", async () => {
    await clearNativeClick(7, 1_234);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("never emits an app-wide event, which Office editor windows are denied", () => {
    const source = readFileSync(new URL("./palettePendingKeys.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.emit\(|emitTo\(|@tauri-apps\/api\/event|webviewWindow/);
  });

  it("releases the click it was told about when the page sees a pointerdown", async () => {
    let notify: ((event: PaletteClickPendingEvent) => void) | undefined;
    const release = vi.fn(async () => undefined);
    const stop = installMainWindowPalettePendingKeys(async listener => {
      notify = listener;
      return () => undefined;
    }, release);
    await Promise.resolve();
    notify!({ sequence: 3, pending: true, expiresAt: Date.now() + PALETTE_CLICK_TIMEOUT_MS });
    const blocked = new KeyboardEvent("keydown", { key: "Delete", cancelable: true });
    window.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);

    window.dispatchEvent(new Event("pointerdown"));
    expect(release).toHaveBeenCalledWith(3, expect.any(Number));
    const allowed = new KeyboardEvent("keydown", { key: "Delete", cancelable: true });
    window.dispatchEvent(allowed);
    expect(allowed.defaultPrevented).toBe(false);
    stop();
  });
});
