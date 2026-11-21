import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { invoke } from "@tauri-apps/api/core";
import { ackFirstPaint, WINDOW_FIRST_PAINT_COMMAND } from "./firstPaint";

const rust = readFileSync(new URL("../src-tauri/src/first_paint.rs", import.meta.url), "utf8");
const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const build = readFileSync(new URL("../src-tauri/build.rs", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/** A page with a manual frame queue and a visibility state the test controls. */
function page(visibilityState: DocumentVisibilityState = "visible") {
  let frames: Array<() => void> = [];
  const listeners = new Set<() => void>();
  const sent: string[] = [];
  const document = {
    visibilityState,
    addEventListener: (type: string, listener: () => void) => { if (type === "visibilitychange") listeners.add(listener); },
    removeEventListener: (type: string, listener: () => void) => { if (type === "visibilitychange") listeners.delete(listener); }
  };
  return {
    sent, listeners,
    environment: {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      document: document as unknown as Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">,
      invoke: (command: string) => { sent.push(command); return Promise.reject(new Error("not allowed")); }
    },
    frame: () => { const due = frames; frames = []; due.forEach(callback => callback()); },
    pendingFrames: () => frames.length,
    hide: () => { document.visibilityState = "hidden"; [...listeners].forEach(listener => listener()); }
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("ackFirstPaint", () => {
  it("acknowledges after the second animation frame, once, and swallows a refusal", async () => {
    const p = page();
    const done = ackFirstPaint(p.environment);
    await settle();
    expect(p.sent).toEqual([]);
    p.frame(); // the frame that carries the content
    await settle();
    expect(p.sent).toEqual([]);
    p.frame(); // runs once that frame has been presented
    await expect(done).resolves.toBeUndefined();
    expect(p.sent).toEqual([WINDOW_FIRST_PAINT_COMMAND]);
    expect(p.pendingFrames()).toBe(0);
    expect(p.listeners.size).toBe(0);
    p.hide();
    await settle();
    expect(p.sent).toHaveLength(1);
  });

  it("acknowledges at once while the page is hidden, when no frames would come", async () => {
    const p = page("hidden");
    await ackFirstPaint(p.environment);
    expect(p.sent).toEqual([WINDOW_FIRST_PAINT_COMMAND]);
    expect(p.pendingFrames()).toBe(0);
    expect(p.listeners.size).toBe(0);
  });

  it("acknowledges when the page turns hidden while waiting, and not again on the next frames", async () => {
    const p = page();
    const done = ackFirstPaint(p.environment);
    p.frame();
    p.hide();
    await done;
    expect(p.sent).toEqual([WINDOW_FIRST_PAINT_COMMAND]);
    p.frame();
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.listeners.size).toBe(0);
  });

  it("acknowledges without animation frames available", async () => {
    const p = page();
    await ackFirstPaint({ ...p.environment, requestAnimationFrame: undefined });
    expect(p.sent).toEqual([WINDOW_FIRST_PAINT_COMMAND]);
  });

  it("invokes the Tauri command with no arguments by default, so it can only reveal the caller", async () => {
    const p = page("hidden");
    await ackFirstPaint({ document: p.environment.document });
    expect(invoke).toHaveBeenCalledWith(WINDOW_FIRST_PAINT_COMMAND);
    expect(vi.mocked(invoke).mock.calls.every((call: unknown[]) => call.length === 1)).toBe(true);
  });

  it("matches the Rust command, its registration, and index.html's inline loader", () => {
    expect(rust).toContain(`#[tauri::command]\npub fn ${WINDOW_FIRST_PAINT_COMMAND}(window: WebviewWindow) -> Result<(), String> {`);
    expect(lib).toContain(`            first_paint::${WINDOW_FIRST_PAINT_COMMAND},\n`);
    expect(build).toContain(`"${WINDOW_FIRST_PAINT_COMMAND}",`);
    expect(html).toContain(`tauri.invoke("${WINDOW_FIRST_PAINT_COMMAND}", {})`);
    // The Rust side never focuses: callers that want focus take it after the show.
    const code = rust.slice(0, rust.indexOf("#[cfg(test)]\nmod tests")).split("\n")
      .filter(line => !line.trimStart().startsWith("//")).join("\n");
    expect(code).not.toContain("set_focus");
    expect(code).not.toMatch(/\.(focused|skip_taskbar|parent|owner)\(/);
  });
});
