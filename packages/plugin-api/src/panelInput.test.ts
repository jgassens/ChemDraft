import { describe, expect, it, vi } from "vitest";
import {
  PluginCommandInputSchema,
  PluginPanelContributionSchema,
  PluginPanelControlIdSchema,
  PluginPanelPayloadSchema,
  PluginPanelReportSchema,
  PluginPanelSectionSchema
} from "./index";

const prompt = { kind: "prompt", id: "composer", commandId: "plugin.chat.submit" };
const button = { id: "stop", label: "Stop", commandId: "plugin.chat.stop" };
const actions = { kind: "actions", id: "controls", buttons: [button] };
const select = { id: "provider", label: "Provider", value: "a", options: [{ value: "a", label: "A" }] };
const input = { source: "panel", panelId: "panel.chat.main", sectionId: "composer", control: "prompt" };

describe("panel input schemas", () => {
  it("applies prompt and button defaults and preserves explicit settings", () => {
    expect(PluginPanelSectionSchema.parse(prompt)).toEqual({ ...prompt, submitLabel: "Send", maxLength: 4000, rows: 3, disabled: false });
    expect(PluginPanelSectionSchema.parse(actions)).toEqual({ ...actions, buttons: [{ ...button, disabled: false, tone: "default" }] });
    expect(PluginPanelSectionSchema.parse({ ...prompt, select, maxLength: 20000, rows: 12, disabled: true, submitLabel: "Ask" }))
      .toMatchObject({ select, maxLength: 20000, rows: 12, disabled: true, submitLabel: "Ask" });
    expect(PluginPanelSectionSchema.parse({ ...actions, buttons: [{ ...button, tone: "danger", payload: { run: 7 } }] }))
      .toMatchObject({ buttons: [{ tone: "danger", payload: { run: 7 } }] });
  });

  it.each(["a", "A-1.foo_bar", "x".repeat(64)])("accepts control id %s", id => {
    expect(PluginPanelControlIdSchema.safeParse(id).success).toBe(true);
  });
  it.each(["", "_a", "a b", "a/b", "a".repeat(65), "é"])("refuses invalid control id %s", id => {
    expect(PluginPanelControlIdSchema.safeParse(id).success).toBe(false);
  });

  it.each([
    { ...prompt, maxLength: 0 }, { ...prompt, maxLength: 20001 }, { ...prompt, maxLength: 1.5 },
    { ...prompt, rows: 0 }, { ...prompt, rows: 13 }, { ...prompt, commandId: "document.new" },
    { ...prompt, select: { ...select, options: [] } },
    { ...prompt, select: { ...select, options: Array.from({ length: 21 }, () => select.options[0]) } },
    { ...actions, buttons: [] }, { ...actions, buttons: Array.from({ length: 9 }, () => button) },
    { ...actions, buttons: [{ ...button, tone: "unknown" }] }
  ])("refuses invalid section limits %#", section => {
    expect(PluginPanelSectionSchema.safeParse(section).success).toBe(false);
  });

  it("refuses duplicate ids across sections, selects and buttons", () => {
    for (const sections of [
      [prompt, prompt], [prompt, { ...actions, id: prompt.id }],
      [{ ...prompt, select: { ...select, id: prompt.id } }],
      [{ ...prompt, select }, { ...actions, buttons: [{ ...button, id: select.id }] }],
      [{ ...actions, buttons: [button, button] }]
    ]) expect(PluginPanelReportSchema.safeParse({ title: "Chat", sections }).success).toBe(false);
    expect(PluginPanelReportSchema.safeParse({ title: "Chat", sections: [{ ...prompt, select }, actions] }).success).toBe(true);
  });

  it("accepts JSON payloads at the serialized size boundary", () => {
    expect(PluginPanelPayloadSchema.parse({ a: [null, true, 1, "text"] })).toEqual({ a: [null, true, 1, "text"] });
    expect(PluginPanelPayloadSchema.safeParse("x".repeat(3998)).success).toBe(true);
    expect(PluginPanelPayloadSchema.safeParse("x".repeat(3999)).success).toBe(false);
    const shared = { value: 1 };
    expect(PluginPanelPayloadSchema.safeParse([shared, shared]).success).toBe(true);
  });

  it("refuses unsafe keys and non-JSON values without invoking accessors", () => {
    const getter = vi.fn(() => "secret");
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    const sparseWithExtra = Object.assign(new Array(1), { ignored: 1 });
    for (const payload of [
      undefined, NaN, Infinity, 1n, () => {}, Symbol("x"), { a: undefined },
      new Date(), new Map(), new Set(), cyclic, new Array(2), sparseWithExtra,
      Object.create({ inherited: true }), Object.defineProperty({}, "value", { enumerable: true, get: getter }),
      { toJSON: getter }, { [Symbol("x")]: 1 }, ...["__proto__", "constructor", "prototype"].map(key => JSON.parse(`{"a":{"${key}":1}}`))
    ]) expect(PluginPanelPayloadSchema.safeParse(payload).success).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(PluginPanelSectionSchema.safeParse({ ...actions, buttons: [{ ...button, payload: { a: undefined } }] }).success).toBe(false);
  });

  it("bounds deeply nested payloads without overflowing validation", () => {
    let payload: unknown = null;
    for (let i = 0; i < 20000; i++) payload = [payload];
    expect(PluginPanelPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it.each(["png", "jpeg", "webp"])("accepts a base64 %s image", format => {
    expect(PluginPanelSectionSchema.safeParse({ kind: "image", dataUri: `data:image/${format};base64,YQ==`, alt: "Preview", maxWidthPx: 300 }).success).toBe(true);
  });
  it.each([
    "https://example.com/x.png", "data:image/svg+xml;base64,YQ==", "data:image/png,YQ==",
    "data:image/png;base64,", "data:image/png;base64,abc", "data:image/png;base64,Y@==",
    "data:image/png;base64,abc\n", `data:image/png;base64,${"a".repeat(1024 * 1024)}`
  ])("refuses invalid or oversized image %#", dataUri => {
    expect(PluginPanelSectionSchema.safeParse({ kind: "image", dataUri, alt: "Preview" }).success).toBe(false);
  });

  it("validates command input sources and field limits", () => {
    expect(PluginCommandInputSchema.parse({ ...input, text: "x".repeat(20000), selected: "x".repeat(100), payload: { action: true } }))
      .toMatchObject(input);
    expect(PluginCommandInputSchema.safeParse({ ...input, source: "overlay", panelId: undefined, overlayId: "overlay.chat.main" }).success).toBe(true);
    for (const bad of [
      { ...input, panelId: undefined }, { ...input, source: "overlay" }, { ...input, overlayId: "overlay.chat.main" },
      { ...input, text: "x".repeat(20001) }, { ...input, selected: "x".repeat(101) },
      { ...input, payload: { value: undefined } }, { ...input, control: "unknown" }, { ...input, extra: true }
    ]) expect(PluginCommandInputSchema.safeParse(bad).success).toBe(false);
    for (const control of ["prompt", "select", "button"]) {
      expect(PluginCommandInputSchema.safeParse({ ...input, control, controlId: "send" }).success).toBe(true);
    }
  });

  it("validates optional preferred window dimensions", () => {
    const panel = { id: "panel.chat.main", title: "Chat" };
    expect(PluginPanelContributionSchema.parse(panel)).not.toHaveProperty("preferredWindowSize");
    expect(PluginPanelContributionSchema.parse({ ...panel, preferredWindowSize: { width: 480, height: 640 } }))
      .toHaveProperty("preferredWindowSize", { width: 480, height: 640 });
    for (const preferredWindowSize of [{ width: 0, height: 640 }, { width: 400, height: -1 }, { width: 1.5, height: 2 }]) {
      expect(PluginPanelContributionSchema.safeParse({ ...panel, preferredWindowSize }).success).toBe(false);
    }
  });
});
