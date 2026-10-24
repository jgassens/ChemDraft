// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { MessageDialogCustomButtons } from "@tauri-apps/plugin-dialog";
import { nativePrompt, type NativePromptOptions } from "../nativePrompt";

const dialog = vi.hoisted(() => ({ message: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: dialog.message }));
vi.mock("../nativeUtilitySuspension", () => ({ withNativeUtilitySuspension: (show: () => Promise<string>) => show() }));

const growth: NativePromptOptions = {
  title: "ChemDraft Assistant", message: "Enlarge the page to fit?", kind: "info", owner: "document",
  choices: [{ id: "enlarge", label: "Enlarge Page", destructive: true }, { id: "decline", label: "Cancel", cancel: true }]
};
afterEach(() => vi.resetAllMocks());

it.each(["macos", "windows"] as const)("Return cannot enlarge and Escape declines the initial native box on %s", async platform => {
  let press!: (key: "Return" | "Escape") => void;
  dialog.message.mockImplementation((_message: string, { buttons }: { buttons: MessageDialogCustomButtons }) =>
    new Promise<string>(resolve => {
      const labels = Object.values(buttons);
      expect(labels).toEqual(["Cancel", "Enlarge Page"]);
      // Contract model, not an OS event test. macOS: coordinating session's native NSAlert
      // probe, Cancel first => no Return default, Escape by literal title. Windows: rfd 0.16.0
      // win_cid/message_dialog.rs, nDefaultButton=0 => first custom button; Escape => IDCANCEL.
      press = key => {
        const answer = key === "Escape"
          ? platform === "macos" ? labels.find(label => label === "Cancel") : "Cancel"
          : platform === "macos" && labels[0] === "Cancel" ? undefined : labels[0];
        if (answer !== undefined) resolve(answer);
      };
    }));
  const settled = vi.fn();
  const response = nativePrompt(growth, undefined, undefined, undefined, platform).then(settled);
  await vi.waitFor(() => expect(dialog.message).toHaveBeenCalledOnce());
  press("Return");
  await Promise.resolve(); await Promise.resolve();
  if (platform === "macos") expect(settled).not.toHaveBeenCalled();
  else { await response; expect(settled).toHaveBeenCalledWith("decline"); }
  expect(settled).not.toHaveBeenCalledWith("enlarge");
  press("Escape");
  await response;
  expect(settled).toHaveBeenCalledWith("decline");

  // Escape on a fresh Windows box is IDCANCEL, distinct from the second custom button.
  const escaped = nativePrompt(growth, undefined, undefined, undefined, platform);
  await vi.waitFor(() => expect(dialog.message).toHaveBeenCalledTimes(2));
  press("Escape");
  expect(await escaped).toBe("decline");
  dialog.message.mockResolvedValue("Enlarge Page");
  expect(await nativePrompt(growth, undefined, undefined, undefined, platform)).toBe("enlarge");
});
