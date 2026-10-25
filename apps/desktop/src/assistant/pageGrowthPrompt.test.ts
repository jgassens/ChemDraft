// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { nativePrompt, nativePromptButtons, type NativePromptOptions } from "../nativePrompt";

const dialog = vi.hoisted(() => ({ message: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: dialog.message }));
vi.mock("../nativeUtilitySuspension", () => ({ withNativeUtilitySuspension: (show: () => Promise<string>) => show() }));

const growth: NativePromptOptions = {
  title: "ChemDraft Assistant", message: "Enlarge the page to fit?", kind: "info", owner: "document",
  choices: [{ id: "enlarge", label: "Enlarge Page" }, { id: "decline", label: "Cancel", cancel: true }]
};
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

type Buttons = { ok: string; cancel: string };
type Backend = "nsalert" | "taskdialog" | "messagebox";
type RfdResult = { kind: "Ok" | "Cancel" } | { kind: "Custom"; label: string };

// Source contract models, not real OS event tests. Paths below are within the cargo registry:
// rfd-0.16.0/src/backend/macos/message_dialog.rs:50-65 adds ok then cancel with no key overrides;
// :120-125 returns Custom(label) for NSAlertFirst/SecondButtonReturn (1000/1001); :135 maps
// all other modal responses to Cancel. objc2-app-kit-0.3.2/src/generated/NSAlert.rs:131-135
// documents Return for the first button and Escape for the literal title "Cancel".
// NSAlert has no ordinary title-bar close button: the close cases below model modal dismissal
// (Cancel/Stop/Abort), not an available click. Without a dismissal there is no resolved result.
// rfd-0.16.0/src/backend/win_cid/message_dialog.rs:87-115 uses custom IDs 1000/1001;
// :138 enables Esc/close (IDCANCEL=2); :156 leaves the first button as Return's default.
// :175-192 returns Cancel on failure/IDCANCEL/unknown, and Custom(label) for custom IDs.
// The MessageBoxW fallback (:45-65, :205-222) uses MB_OKCANCEL, default IDOK=1, IDCANCEL=2
// for Cancel/Esc/close, and Cancel on failure (0). It displays system OK/Cancel labels.
// tauri-plugin-dialog-2.7.1/Cargo.toml:104-107 enables common-controls-v6 (TaskDialog), so
// MessageBoxW is covered defensively but is not the shipped backend.
function rfdResult(backend: Backend, response: number, buttons: Buttons, failed = false): RfdResult {
  if (failed) return { kind: "Cancel" };
  if (backend === "messagebox") return { kind: response === 1 ? "Ok" : "Cancel" };
  if (response === 1000) return { kind: "Custom", label: buttons.ok };
  if (response === 1001) return { kind: "Custom", label: buttons.cancel };
  if (backend === "taskdialog" && response === 1) return { kind: "Ok" };
  return { kind: "Cancel" };
}

// Critical second stage: tauri-plugin-dialog-2.7.1/src/desktop.rs:232-239 remaps BOTH
// Ok and Cancel to the configured custom labels on all platforms; :252 preserves Custom.
// src/models.rs:70-78 serializes Custom as its bare string; JS message() passes it through.
// Omitting this stage made the old Windows Esc test falsely pass with inverted button labels.
function tauriResult(result: RfdResult, buttons: Buttons): string {
  return result.kind === "Custom" ? result.label : result.kind === "Ok" ? buttons.ok : buttons.cancel;
}

const platforms: { platform: ShortcutPlatform; backend: Backend }[] = [
  { platform: "macos", backend: "nsalert" },
  { platform: "windows", backend: "taskdialog" },
  { platform: "windows", backend: "messagebox" }
];
describe.each(platforms)("page growth on $platform ($backend)", ({ platform, backend }) => {
  const first = backend === "messagebox" ? 1 : 1000;
  const second = backend === "messagebox" ? 2 : 1001;
  const escape = backend === "nsalert" ? second : 2;
  it.each([
    { event: "affirmative click", response: first, label: "Enlarge Page", choice: "enlarge" },
    { event: "Cancel click", response: second, label: "Cancel", choice: "decline" },
    { event: "Escape", response: escape, label: "Cancel", choice: "decline" },
    { event: "initial Return", response: first, label: "Enlarge Page", choice: "enlarge" },
    { event: "close/dismiss", response: backend === "nsalert" ? 0 : 2, label: "Cancel", choice: "decline" },
    { event: "modal stop", response: -1000, label: "Cancel", choice: "decline" },
    { event: "modal abort", response: -1001, label: "Cancel", choice: "decline" },
    { event: "unknown native response", response: 9999, label: "Cancel", choice: "decline" },
    { event: "native failure", response: 0, failed: true, label: "Cancel", choice: "decline" }
  ])("$event delivers $label and resolves $choice", async ({ response, failed, label, choice }) => {
    dialog.message.mockImplementation(async (_message: string, { buttons }: { buttons: Buttons }) => {
      expect(buttons).toEqual({ ok: "Enlarge Page", cancel: "Cancel" });
      const received = tauriResult(rfdResult(backend, response, buttons, failed), buttons);
      expect(received).toBe(label);
      return received;
    });
    expect(await nativePrompt(growth, undefined, undefined, undefined, platform)).toBe(choice);
  });
});

it("models the Windows IDCANCEL label remap that caused the regression", () => {
  const inverted = { ok: "Cancel", cancel: "Enlarge Page" };
  expect(tauriResult(rfdResult("taskdialog", 2, inverted), inverted)).toBe("Enlarge Page");
});

describe.each(["macos", "windows"] as const)("fail-closed page growth on %s", platform => {
  it.each(["Cancel", "Ok", "Yes", "1000", "enlarge", "", "unknown", "Enlarge Page ", null, undefined])(
    "declines unexpected or cancel result %s", async result => {
      dialog.message.mockResolvedValue(result);
      expect(await nativePrompt(growth, undefined, undefined, undefined, platform)).toBe("decline");
    }
  );

  it("declines a rejected native call using the assistant's safe fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dialog.message.mockRejectedValue(new Error("Native dialog unavailable"));
    const fallback = vi.fn(async () => "decline");
    expect(await nativePrompt(growth, fallback, undefined, undefined, platform)).toBe("decline");
    expect(fallback).toHaveBeenCalledWith(growth);
  });
});

it('Windows Esc must not confirm a destructive single action', async () => {
  const destructive: NativePromptOptions = { ...growth, choices: [
    { id: "delete", label: "Delete", destructive: true }, { id: "cancel", label: "Cancel", cancel: true }
  ] };
  // IDCANCEL passes through rfd Cancel and Tauri's custom cancel-label remap (sources above).
  const buttons = nativePromptButtons(destructive, "windows") as Buttons;
  dialog.message.mockResolvedValue(tauriResult(rfdResult("taskdialog", 2, buttons), buttons));
  expect(await nativePrompt(destructive, undefined, undefined, undefined, "windows")).toBe("cancel");
});
