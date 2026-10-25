import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { createPerfProbe, PerfRecordSchema, type PerfRecord, type ProbeEnvironment } from "./probe";

function harness(window: PerfRecord["window"] = "palette") {
  let now = 1000;
  let id = 0;
  const frames = new Map<number, () => void>();
  const tasks: (() => void)[] = [];
  const timers = new Map<number, () => void>();
  const listeners = new Map<string, EventListener>();
  const records: PerfRecord[] = [];
  const env: ProbeEnvironment = {
    target: {
      addEventListener: vi.fn((name, listener) => listeners.set(name, listener as EventListener)),
      removeEventListener: vi.fn((name) => { listeners.delete(name); })
    },
    now: () => now, eventTime: stamp => 900 + stamp,
    frame: vi.fn(callback => { frames.set(++id, callback); return id; }),
    cancelFrame: vi.fn(key => { frames.delete(key); }), defer: callback => { tasks.push(callback); },
    timeout: vi.fn(callback => { timers.set(++id, callback); return id as unknown as ReturnType<typeof setTimeout>; }),
    clearTimeout: vi.fn(key => { timers.delete(key as unknown as number); }),
    write: vi.fn(record => { records.push(record); }), window, platform: "macos", buildStamp: "test", processStart: 500, clockErrorMs: 0.2
  };
  return {
    env, records, timers, listeners, frames, setTime(value: number) { now = value; },
    input(type = "click", trusted = true) { listeners.get(type)?.({ type, isTrusted: trusted, timeStamp: 90 } as Event); },
    native(commandId: string) { listeners.get("chemdraft:native-command")?.({ detail: { commandId } } as unknown as Event); },
    tasks() { for (const task of tasks.splice(0)) task(); },
    paint() { const callbacks = [...frames.values()]; frames.clear(); for (const frame of callbacks) frame(); }
  };
}

describe("bridge-gated timing probe", () => {
  it("off does not even construct the environment, listeners, timers or writer", () => {
    const h = harness(); const factory = vi.fn(() => h.env);
    expect(createPerfProbe(false, factory)).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(h.env.target.addEventListener).not.toHaveBeenCalled();
    expect(h.env.frame).not.toHaveBeenCalled();
    expect(h.env.timeout).not.toHaveBeenCalled();
    expect(h.env.write).not.toHaveBeenCalled();
  });
  it("ignores all synthetic input and removes every listener/timer on teardown", () => {
    const h = harness(); const probe = createPerfProbe(true, () => h.env)!;
    for (const type of ["click", "pointerdown", "keydown"]) h.input(type, false);
    h.tasks(); h.paint();
    expect(h.records).toEqual([]); expect(h.timers.size).toBe(0);
    h.input(); probe.stop();
    expect(h.listeners.size).toBe(0); expect(h.timers.size).toBe(0); expect(h.frames.size).toBe(0);
  });
  it.each(["pointerdown", "click", "keydown"])("records trusted %s, command commit, and first frame separately", async type => {
    const h = harness(); const probe = createPerfProbe(true, () => h.env)!;
    const registry = new CommandRegistry();
    const handler = vi.fn(() => { h.setTime(1010); probe.signal("document-commit"); return 42; });
    registry.register({ id: "edit.draw", title: "Draw", source: "core" }, handler);
    probe.instrumentRegistry(registry);
    h.input(type); expect(await registry.invoke("edit.draw")).toBe(42);
    expect(handler).toHaveBeenCalledTimes(1); expect(h.records).toEqual([]);
    h.tasks(); probe.rendered(); h.setTime(1020); h.paint();
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ v: 1, kind: type, commandId: "edit.draw", window: "palette", platform: "macos",
      buildStamp: "test", t0: 990, firstFrameMs: 30, doneMs: 20, doneSignal: "document-commit" });
    expect(PerfRecordSchema.safeParse(h.records[0]).success).toBe(true);
  });
  it("preserves registry rejection without recording synthetic agent commands", async () => {
    const h = harness(); const probe = createPerfProbe(true, () => h.env)!;
    const registry = new CommandRegistry();
    registry.register({ id: "test.fail", title: "Fail", source: "core" }, () => { throw new Error("expected"); });
    probe.instrumentRegistry(registry);
    await expect(registry.invoke("test.fail")).rejects.toThrow("expected");
    expect(h.records).toEqual([]);
    h.input(); await expect(registry.invoke("test.fail")).rejects.toThrow("expected");
    h.tasks(); h.paint(); expect(h.records[0]?.doneSignal).toBe("failed");
  });
  it("records native menu receipt, then waits for correlated dialog show and destination frame", () => {
    const h = harness("main"); const probe = createPerfProbe(true, () => h.env)!;
    h.native("export.open"); probe.expectCompletion("dialog-open", "session-1"); h.tasks(); h.paint();
    probe.signal("document-commit"); expect(h.records).toEqual([]);
    probe.remoteCompletion("wrong-session", "dialog-open", 1100, 1120, "dialog-main-export-1");
    expect(h.records).toEqual([]);
    probe.remoteCompletion("session-1", "dialog-open", 1100, 1120, "dialog-main-export-1");
    expect(h.records[0]).toMatchObject({ kind: "native-command", commandId: "export.open", t0: 1000,
      doneMs: 100, firstFrameMs: 120, doneSignal: "dialog-open", extra: { frameSource: "destination-window" } });
    probe.stop();
  });
  it("waits for native window show before observing its requesting-page frame", () => {
    const h = harness(); const probe = createPerfProbe(true, () => h.env)!;
    h.native("view.toolset.toggle.core.main"); h.tasks(); probe.rendered(); h.paint();
    expect(h.records).toEqual([]);
    h.setTime(1500); probe.signal("window-shown"); h.setTime(1520); h.paint();
    expect(h.records[0]).toMatchObject({ doneSignal: "window-shown", doneMs: 500, firstFrameMs: 520 });
  });
  it("observes an asynchronous command's document commit after the input task has ended", async () => {
    const h = harness(); const probe = createPerfProbe(true, () => h.env)!;
    const registry = new CommandRegistry(); let resume!: () => void;
    registry.register({ id: "edit.async", title: "Async", source: "core" }, async () => {
      await new Promise<void>(resolve => { resume = resolve; });
      probe.signal("document-commit");
    });
    probe.instrumentRegistry(registry); h.input(); const result = registry.invoke("edit.async"); h.tasks();
    h.setTime(1500); resume(); await result; h.setTime(1520); h.paint();
    expect(h.records[0]).toMatchObject({ doneSignal: "document-commit", doneMs: 510, firstFrameMs: 530 });
  });
  it("preserves a plugin's window completion policy across queued registry dispatch", async () => {
    const h = harness(); const probe = createPerfProbe(true, () => h.env)!;
    const registry = new CommandRegistry(); registry.register({ id: "plugin.demo.open", title: "Open", source: "core" }, () => undefined);
    probe.instrumentRegistry(registry); h.input(); probe.command("plugin.demo.open"); probe.expectSignal("window-shown");
    h.tasks(); await registry.invoke("plugin.demo.open"); h.paint(); expect(h.records).toEqual([]);
    h.setTime(1500); probe.signal("window-shown", "plugin.demo.open"); h.setTime(1520); h.paint();
    expect(h.records[0]).toMatchObject({ commandId: "plugin.demo.open", doneSignal: "window-shown", doneMs: 510, firstFrameMs: 530 });
  });
  it("records cold launch once at the first ready canvas frame", () => {
    const h = harness("main"); const probe = createPerfProbe(true, () => h.env)!;
    probe.rendered(); h.paint(); expect(h.records).toEqual([]);
    probe.readyCanvas(); probe.readyCanvas(); h.setTime(1600); h.paint();
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ kind: "cold-launch", t0: 500, firstFrameMs: 1100, doneMs: 1100, doneSignal: "canvas-ready" });
  });
  it("does not count a picker/partial render as the document-open frame", () => {
    const h = harness(); const probe = createPerfProbe(true, () => h.env)!;
    h.native("document.open"); h.tasks(); h.setTime(1200);
    const open = probe.documentOpenStarted(); probe.rendered(); h.paint(); expect(h.records).toEqual([]);
    h.setTime(1400); probe.documentOpenCommitted(open); h.setTime(1420); h.paint();
    expect(h.records).toHaveLength(2);
    for (const record of h.records) expect(record).toMatchObject({ t0: 1000, doneMs: 400, firstFrameMs: 420, doneSignal: "document-commit" });
    expect(h.records.map(r => r.kind).sort()).toEqual(["document-open", "native-command"]);
  });
  it("marks an export written only on its matching completion, independent of local busy paint", () => {
    const h = harness("dialog"); const probe = createPerfProbe(true, () => h.env)!;
    h.input(); probe.expectCompletion("export-written", "export-1"); h.tasks(); h.setTime(1020); h.paint();
    expect(h.records).toEqual([]);
    probe.remoteCompletion("export-1", "export-written", 1500, undefined, "main");
    expect(h.records[0]).toMatchObject({ kind: "click", doneSignal: "export-written", doneMs: 510, firstFrameMs: 30 });
  });
  it("bounds cancelled operations and labels them incomplete", () => {
    const h = harness(); const probe = createPerfProbe(true, () => h.env)!;
    h.native("document.open"); h.tasks(); h.setTime(121000);
    for (const timeout of [...h.timers.values()]) timeout();
    expect(h.records[0]).toMatchObject({ doneSignal: "timeout", extra: { incomplete: true } });
    expect(h.records[0].firstFrameMs).toBeUndefined();
  });
  it("ends a canvas gesture without attributing a later unrelated commit to it", () => {
    const h = harness(); const probe = createPerfProbe(true, () => h.env)!;
    h.input("pointerdown"); probe.expectSignal("document-commit"); h.tasks(); h.paint();
    h.setTime(1500); h.input("pointerup");
    expect(h.records[0]).toMatchObject({ kind: "pointerdown", doneSignal: "gesture-ended", doneMs: 510 });
    probe.signal("document-commit"); expect(h.records).toHaveLength(1); probe.stop();
  });
  it("keeps invalid telemetry and writer failures out of command behavior", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const invalid = harness(); invalid.env.buildStamp = "x".repeat(300);
    const first = createPerfProbe(true, () => invalid.env)!;
    invalid.input(); invalid.tasks(); expect(() => invalid.paint()).not.toThrow(); expect(invalid.records).toEqual([]); first.stop();
    const failing = harness(); failing.env.write = () => { throw new Error("disk unavailable"); };
    const second = createPerfProbe(true, () => failing.env)!;
    failing.input(); failing.tasks(); expect(() => failing.paint()).not.toThrow(); second.stop();
    expect(warn).toHaveBeenCalledTimes(2); warn.mockRestore();
  });
  it("rejects malformed schema versions, durations, roles and unknown fields", () => {
    const valid = { v: 1, kind: "click", window: "main", platform: "windows", buildStamp: "test", t0: 1 };
    expect(PerfRecordSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [{ ...valid, v: 2 }, { ...valid, doneMs: -1 }, { ...valid, t0: NaN }, { ...valid, window: "unknown" }, { ...valid, document: {} }]) {
      expect(PerfRecordSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
