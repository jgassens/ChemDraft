import { z } from "zod";
import type { CommandRegistry } from "@chemdraft/plugin-host";

export const PerfRecordSchema = z.object({
  v: z.literal(1),
  kind: z.enum(["pointerdown", "click", "keydown", "native-command", "cold-launch", "document-open"]),
  commandId: z.string().max(256).optional(),
  window: z.enum(["main", "palette", "palette-popover", "dialog", "plugin-panel"]),
  platform: z.enum(["macos", "windows", "linux"]),
  buildStamp: z.string().max(256),
  t0: z.number().finite().nonnegative(),
  firstFrameMs: z.number().finite().nonnegative().optional(),
  doneMs: z.number().finite().nonnegative().optional(),
  doneSignal: z.enum(["document-commit", "window-shown", "dialog-open", "export-written", "command-finished", "gesture-ended", "frame", "canvas-ready", "timeout", "failed"]).optional(),
  extra: z.record(z.unknown()).optional()
}).strict();
export type PerfRecord = z.infer<typeof PerfRecordSchema>;
export type DoneSignal = NonNullable<PerfRecord["doneSignal"]>;
export interface ProbeEnvironment {
  target: Pick<Window, "addEventListener" | "removeEventListener">;
  now(): number;
  eventTime(timeStamp: number): number;
  frame(callback: () => void): number;
  cancelFrame(id: number): void;
  defer(callback: () => void): void;
  timeout(callback: () => void): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
  write(record: PerfRecord): void;
  window: PerfRecord["window"];
  platform: PerfRecord["platform"];
  buildStamp: string;
  processStart: number;
  clockErrorMs: number;
}
interface Span { record: PerfRecord; done?: number; frame?: number; raf?: number; timer?: ReturnType<typeof setTimeout>; expected?: DoneSignal; requestKey?: string; registryObserved?: boolean; parent?: Span; pointerId?: number; }

/** Constructed only after the existing bridge gate. No global listeners/timers at module load. */
export class PerfProbe {
  private pending = new Set<Span>();
  private activeRegistry = new Set<Span>();
  private task?: Span;
  private launch?: Span;
  private ready = false;
  private stopped = false;
  constructor(private env: ProbeEnvironment) {
    for (const kind of ["pointerdown", "click", "keydown"] as const) env.target.addEventListener(kind, this.input, true);
    env.target.addEventListener("chemdraft:native-command", this.native, true);
    for (const kind of ["pointerup", "pointercancel"]) env.target.addEventListener(kind, this.release);
    if (env.window === "main") this.launch = this.start("cold-launch", env.processStart);
  }
  private input = (event: Event) => {
    if (!event.isTrusted) return;
    const span = this.capture(event.type as PerfRecord["kind"], this.env.eventTime(event.timeStamp));
    if (event.type === "pointerdown") span.pointerId = (event as PointerEvent).pointerId;
    // Drawing gestures commit on pointerup; keep pointerdown alive across the preview frames.
    if (event.type === "pointerdown" && this.env.window === "main" && typeof Element !== "undefined"
      && event.target instanceof Element && event.target.closest(".page")
      && !event.target.closest("input,textarea,[contenteditable]")) span.expected = "document-commit";
  };
  private release = (event: Event) => {
    if (!event.isTrusted) return;
    // Runs after React's pointerup handler: a drawing commit has already supplied its stronger
    // signal. A no-op/cancelled gesture must not be attributed to a later, unrelated edit.
    for (const span of this.pending) {
      if (span.record.kind === "pointerdown" && !span.record.commandId && span.done === undefined
        && span.expected === "document-commit" && span.pointerId === (event as PointerEvent).pointerId) {
        this.finish(span, "gesture-ended"); this.scheduleFrame(span, "gesture-end");
      }
    }
  };
  private native = (event: Event) => {
    const commandId = (event as CustomEvent<{ commandId?: string }>).detail?.commandId;
    if (typeof commandId !== "string") return;
    this.capture("native-command", this.env.now());
    this.command(commandId);
  };
  private capture(kind: PerfRecord["kind"], t0: number) {
    const span = this.start(kind, t0);
    this.task = span;
    // React's discrete event updates flush before this microtask. DOM mutations can reschedule
    // this frame; an input with no DOM update is explicitly labelled input-task instead.
    this.env.defer(() => {
      if (this.task === span) this.task = undefined;
      if (!span.record.commandId && !span.expected && span.done === undefined) span.expected = "frame";
      this.scheduleFrame(span, "input-task");
    });
    return span;
  }
  private start(kind: PerfRecord["kind"], t0 = this.env.now(), commandId?: string): Span {
    const span: Span = { record: { v: 1, kind, t0, commandId, window: this.env.window,
      platform: this.env.platform, buildStamp: this.env.buildStamp,
      extra: { clockErrorMs: this.env.clockErrorMs, processStart: this.env.processStart } } };
    this.pending.add(span);
    // Bound memory and ensure cancelled/picker/no-op commands never masquerade as completions.
    if (this.pending.size > 256) this.expire(this.pending.values().next().value!);
    span.timer = this.env.timeout(() => this.expire(span));
    return span;
  }
  command(commandId: string): Span | undefined {
    const span = this.task ?? [...this.pending].reverse().find(p => p.record.commandId === commandId && p.done === undefined);
    if (!span || commandId.length > 256) return undefined;
    const firstBinding = span.record.commandId !== commandId;
    span.record.commandId = commandId;
    if (firstBinding || span.expected === undefined) {
      span.expected = commandId === "document.open" ? "document-commit"
        : commandId === "export.open" || commandId === "page.setSizeCustom" || commandId === "layout.arrangementSpacing" ? "dialog-open"
        : commandId.startsWith("view.toolset.toggle.") ? "window-shown" : undefined;
    }
    return span;
  }
  /** Wrap this instance only, preserving arguments, results, rejection and invocation count. */
  instrumentRegistry(registry: CommandRegistry): void {
    const invoke = registry.invoke.bind(registry);
    registry.invoke = <Result>(...args: Parameters<CommandRegistry["invoke"]>): Promise<Result> => {
      const span = this.command(args[0]);
      if (span) span.registryObserved = true;
      if (span) this.activeRegistry.add(span);
      const result = invoke<Result>(...args);
      void result.then(() => {
        if (span) this.activeRegistry.delete(span);
        if (span && !span.expected && span.done === undefined) this.finish(span, "command-finished");
      }, () => { if (span) { this.activeRegistry.delete(span); this.finish(span, "failed"); } });
      return result;
    };
  }
  registryExpected(span: Span | undefined): void { if (span) span.registryObserved = true; }
  dispatchReturned(span: Span | undefined): void {
    if (span && !span.registryObserved && !span.expected && span.done === undefined) this.finish(span, "command-finished");
  }
  expectSignal(signal: DoneSignal, commandId?: string): Span | undefined {
    const span = commandId ? [...this.pending].reverse().find(p => p.record.commandId === commandId && p.done === undefined)
      : this.task ?? (this.activeRegistry.size === 1 ? [...this.activeRegistry][0] : undefined);
    if (span) span.expected = signal;
    return span;
  }
  complete(span: Span, signal: DoneSignal): void { this.finish(span, signal); }
  signal(signal: DoneSignal, commandId?: string): void {
    for (const span of this.pending) {
      if (commandId && span.record.commandId !== commandId) continue;
      if (span.record.kind === "cold-launch" || span.record.kind === "document-open" || span.done !== undefined) continue;
      if (span.record.commandId === "document.open") continue; // Open settles only after its final install.
      if (span.requestKey) continue; // A correlated cross-window completion is authoritative.
      if (!span.expected && signal !== "document-commit") continue;
      if (this.task && span !== this.task && !span.expected) continue;
      if (span !== this.task && !span.expected && !(this.activeRegistry.size === 1 && this.activeRegistry.has(span))) {
        if (this.activeRegistry.has(span)) span.record.extra = { ...span.record.extra, ambiguousCompletion: true };
        continue;
      }
      if (span.expected && span.expected !== signal) continue;
      // A generic command can settle on a stronger observable signal before its promise resolves.
      if (signal === "document-commit" || signal === "dialog-open" || signal === "window-shown" || signal === "export-written" || span.expected === signal) this.finish(span, signal);
    }
  }
  timestamp(): number { return this.env.now(); }
  expectCompletion(signal: DoneSignal, requestKey: string): void {
    const span = this.task ?? [...this.pending].reverse().find(p => p.expected === signal && p.done === undefined && !p.requestKey);
    if (!span) return;
    span.expected = signal; span.requestKey = requestKey;
  }
  remoteCompletion(requestKey: string, signal: DoneSignal, at: number, frameAt?: number, window?: string): void {
    const span = [...this.pending].find(p => p.requestKey === requestKey && p.expected === signal);
    if (!span || !Number.isFinite(at) || at < span.record.t0) return;
    span.done = at; span.record.doneSignal = signal;
    span.record.extra = { ...span.record.extra, completionWindow: window };
    if (frameAt !== undefined && Number.isFinite(frameAt) && frameAt >= span.record.t0) {
      span.frame = frameAt;
      span.record.extra.frameSource = "destination-window";
    }
    this.flush(span);
  }
  documentOpenStarted(): Span {
    const command = [...this.pending].find(p => p.record.commandId === "document.open" && p.record.kind !== "document-open" && p.done === undefined);
    const span = this.start("document-open", command?.record.t0, "document.open");
    span.parent = command;
    return span;
  }
  documentOpenCommitted(span: Span): void {
    this.finish(span, "document-commit");
    const command = span.parent;
    if (command) { this.finish(command, "document-commit"); this.scheduleFrame(command, "document-open"); }
    // Called after open's last state update. rAF follows its React commit.
    this.scheduleFrame(span, "document-open");
  }
  documentOpenFailed(span: Span): void {
    this.finish(span, "failed"); this.scheduleFrame(span, "failed");
    if (span.parent) { this.finish(span.parent, "failed"); this.scheduleFrame(span.parent, "failed"); }
  }
  readyCanvas(): void {
    if (this.ready || !this.launch) return;
    this.ready = true;
    const span = this.launch;
    span.raf = this.env.frame(() => { span.raf = undefined; this.finish(span, "canvas-ready"); span.frame = this.env.now(); this.flush(span); });
  }
  /** Called after React/DOM commit, never before setState. */
  rendered(): void {
    for (const span of this.pending) {
      if (span.record.kind !== "cold-launch" && span.frame === undefined && (span.record.kind !== "document-open" || span.done !== undefined)) this.scheduleFrame(span, "dom-commit");
    }
  }
  private scheduleFrame(span: Span, source: string) {
    if (!this.pending.has(span) || span.frame !== undefined || span.record.kind === "cold-launch") return;
    if (span.record.kind === "document-open" && span.done === undefined) return;
    if (span.record.commandId === "document.open" && span.done === undefined) return;
    if (span.expected === "window-shown" && span.done === undefined) return;
    if (span.raf !== undefined) this.env.cancelFrame(span.raf);
    span.raf = this.env.frame(() => {
      span.raf = undefined;
      span.frame = this.env.now();
      span.record.extra = { ...span.record.extra, frameSource: source };
      if (span.expected === "frame" && span.done === undefined) this.finish(span, "frame");
      this.flush(span);
    });
  }
  private finish(span: Span, signal: DoneSignal) {
    if (span.done !== undefined) return;
    span.done = this.env.now(); span.record.doneSignal = signal;
    if (signal === "window-shown") this.scheduleFrame(span, "window-shown");
    this.flush(span);
  }
  private expire(span: Span) {
    if (!this.pending.has(span)) return;
    if (span.done === undefined) { span.done = this.env.now(); span.record.doneSignal = "timeout"; }
    span.record.extra = { ...span.record.extra, incomplete: true };
    this.flush(span, true);
  }
  private flush(span: Span, incomplete = false) {
    if (this.stopped || !this.pending.has(span) || span.done === undefined || (!incomplete && span.frame === undefined)) return;
    this.pending.delete(span);
    if (span.timer !== undefined) this.env.clearTimeout(span.timer);
    if (span.raf !== undefined) this.env.cancelFrame(span.raf);
    const elapsed = (time: number) => Math.max(0, time - span.record.t0);
    const record = PerfRecordSchema.safeParse({ ...span.record, doneMs: elapsed(span.done),
      firstFrameMs: span.frame === undefined ? undefined : elapsed(span.frame) });
    if (!record.success) { console.warn("Perf probe discarded an invalid sample"); return; }
    try { this.env.write(record.data); }
    catch (error) { console.warn("Perf probe writer failed", error); }
  }
  stop(): void {
    this.stopped = true;
    for (const kind of ["pointerdown", "click", "keydown"] as const) this.env.target.removeEventListener(kind, this.input, true);
    this.env.target.removeEventListener("chemdraft:native-command", this.native, true);
    for (const kind of ["pointerup", "pointercancel"]) this.env.target.removeEventListener(kind, this.release);
    for (const span of this.pending) {
      if (span.timer !== undefined) this.env.clearTimeout(span.timer);
      if (span.raf !== undefined) this.env.cancelFrame(span.raf);
    }
    this.pending.clear();
    this.activeRegistry.clear();
  }
}

export function createPerfProbe(enabled: boolean, environment: () => ProbeEnvironment): PerfProbe | undefined {
  if (!enabled) return undefined;
  return new PerfProbe(environment());
}
