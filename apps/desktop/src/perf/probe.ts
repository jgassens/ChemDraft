import { z } from "zod";
import { keyboardEventChord, type ShortcutRegistry } from "@chemdraft/shortcut-engine";
import type { CommandRegistry } from "@chemdraft/plugin-host";

export const PerfRecordSchema = z.object({
  v: z.literal(3),
  kind: z.enum(["pointerdown", "click", "keydown", "native-command", "cold-launch", "startup", "document-open", "window-shown", "dialog-open"]),
  commandId: z.string().max(256).optional(),
  window: z.enum(["main", "palette", "toolset", "settings", "inspector", "palette-popover", "dialog", "plugin-panel", "preferences", "spin3d-debugger"]),
  platform: z.enum(["macos", "windows", "linux"]),
  buildStamp: z.string().max(256),
  t0: z.number().finite().nonnegative(),
  firstFrameMs: z.number().finite().nonnegative().optional(),
  rafStartMs: z.number().finite().nonnegative().optional(),
  windowShownMs: z.number().finite().nonnegative().optional(),
  doneMs: z.number().finite().nonnegative().optional(),
  doneSignal: z.enum(["document-commit", "window-shown", "window-painted", "startup-painted", "forwarded", "dialog-open", "export-written", "command-finished", "gesture-ended", "frame", "canvas-ready", "popover-shown", "no-op", "timeout", "failed"]).optional(),
  extra: z.record(z.unknown()).optional()
}).strict();
export type PerfRecord = z.infer<typeof PerfRecordSchema>;
export type DoneSignal = NonNullable<PerfRecord["doneSignal"]>;
/** Tolerate at most 10 ms between independently calibrated webview timestamps. */
export const COMPLETION_CLOCK_SKEW_MS = 10;
export interface ProbeEnvironment {
  target: Pick<Window, "addEventListener" | "removeEventListener">;
  now(): number;
  eventTime(timeStamp: number): number;
  frame(callback: () => void): number;
  cancelFrame(id: number): void;
  afterPaint(callback: () => void): void;
  defer(callback: () => void): void;
  timeout(callback: () => void, delayMs?: number): number;
  clearTimeout(id: number): void;
  write(record: PerfRecord): unknown;
  window: PerfRecord["window"];
  platform: PerfRecord["platform"];
  buildStamp: string;
  processStart: number;
  clockErrorMs: number;
  onFailure?(error: unknown): void;
  onStop?(): void;
  correlationDelayMs?: number;
  forwardInput?(origin: { inputId: string; t0: number; commandId: string }): void;
}
interface Span { destination?: string; deliveredAt?: number; correlationTimer?: number; record: PerfRecord; done?: number; frame?: number; rafStart?: number; frameGeneration?: number; raf?: number; timer?: number; expected?: DoneSignal; requestKey?: string; registryObserved?: boolean; parent?: Span; pointerId?: number; inputTarget?: Element; }

/** Constructed only after the existing bridge gate. No global listeners/timers at module load. */
export class PerfProbe {
  private pending = new Set<Span>();
  private activeRegistry = new Set<Span>();
  private instrumentedRegistries = new WeakSet<CommandRegistry>();
  private task?: Span;
  private launch?: Span;
  private shortcuts?: ShortcutRegistry;
  private flyoutPress?: { span: Span; target: Element; requested: boolean };
  private ready = false;
  private stopped = false;
  private forwards: { inputId: string; t0: number; commandId: string; window: string }[] = [];
  private deliveries: Span[] = [];
  private forwardSequence = 0;
  private forwardedPress?: { target: Element; inputId: string; t0: number; commandId: string };
  /** Every diagnostic entry point is best effort, including callbacks after teardown. */
  guard<T>(hook: () => T): T | undefined {
    if (this.stopped) return undefined;
    try {
      const result = hook();
      if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch(error => this.fail(error));
        return undefined;
      }
      return result;
    }
    catch (error) {
      this.fail(error);
      return undefined;
    }
  }
  private fail(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    try { this.stop(); } catch { /* Even a substituted teardown must fail open. */ }
    try {
      if (this.env.onFailure) this.env.onFailure(error);
      else console.warn("Perf probe disabled after an error", error);
    } catch { /* Diagnostics only. */ }
  }
  constructor(private env: ProbeEnvironment) {
    this.guard(() => {
      for (const kind of ["pointerdown", "click", "keydown"] as const) env.target.addEventListener(kind, this.input, true);
      env.target.addEventListener("chemdraft:native-command", this.native, true);
      for (const kind of ["pointerup", "pointercancel"]) env.target.addEventListener(kind, this.paletteRelease, true);
      for (const kind of ["pointerup", "pointercancel"]) env.target.addEventListener(kind, this.release);
      if (env.window === "main") this.launch = this.start("cold-launch", env.processStart);
    });
  }
  private input = (event: Event) => this.guard(() => {
    if (!event.isTrusted) return;
    if (event.type === "keydown" && ["Meta", "Control", "Shift", "Alt"].includes((event as KeyboardEvent).key)) return;
    if (event.type === "pointerdown" || event.type === "keydown") this.forwardedPress = undefined;
    const flyout = ["palette", "toolset", "settings", "inspector"].includes(this.env.window) && typeof Element !== "undefined" && event.target instanceof Element
      ? event.target.closest("[data-command-flyout-button]") : null;
    if (event.type === "click" && flyout && this.flyoutPress?.target === flyout && this.flyoutPress.requested) {
      this.flyoutPress = undefined;
      return;
    }
    if (event.type === "pointerdown") this.flyoutPress = undefined;
    const span = this.capture(event.type as PerfRecord["kind"], this.env.eventTime(event.timeStamp));
    if (this.env.forwardInput && event.type === "pointerdown" && typeof Element !== "undefined" && event.target instanceof Element) {
      span.inputTarget = event.target.closest("[data-command-id]") ?? undefined;
      if (span.inputTarget) span.expected = "gesture-ended";
    }
    // Pointer actions run on pointerup in ToolPalette; keyboard/click-only actions arrive here.
    if (this.env.forwardInput && event.type === "click" && typeof Element !== "undefined" && event.target instanceof Element) {
      if (this.forwardCommand(event, span)) { this.forwardedPress = undefined; return; }
    }
    if (event.type === "keydown") {
      const key = event as KeyboardEvent;
      const commandId = this.shortcuts?.resolve(key);
      // Keep only bound chords, never arbitrary typed text.
      if (commandId) {
        span.record.extra!.chord = keyboardEventChord(key);
        this.command(commandId);
      }
    }
    if (flyout) {
      span.record.extra!.flyoutId = flyout.getAttribute("data-command-flyout-button");
      if (event.type === "pointerdown") {
        span.expected = "gesture-ended";
        this.flyoutPress = { span, target: flyout, requested: false };
      } else if (event.type === "click") {
        const commandId = flyout.getAttribute("data-command-id");
        if (commandId) span.record.commandId = commandId;
      }
    }
    if (event.type === "pointerdown") span.pointerId = (event as PointerEvent).pointerId;
    // Drawing gestures commit on pointerup; keep pointerdown alive across the preview frames.
    if (event.type === "pointerdown" && this.env.window === "main" && typeof Element !== "undefined"
      && event.target instanceof Element && event.target.closest(".page")
      && !event.target.closest("input,textarea,[contenteditable]")) span.expected = "document-commit";
  });
  private forwardCommand(event: Event, click?: Span): boolean {
    if (!this.env.forwardInput || typeof Element === "undefined" || !(event.target instanceof Element)) return false;
    const target = event.target.closest("[data-command-id]");
    const commandId = target?.getAttribute("data-command-id");
    if (!target || !commandId || target.matches(":disabled,[aria-disabled='true']")) return false;
    const press = [...this.pending].find(p => p.inputTarget === target && p.record.kind === "pointerdown" && p.done === undefined);
    const previous = click && this.forwardedPress?.target === target ? this.forwardedPress : undefined;
    if (!press && !click) return false;
    const origin = previous ?? { inputId: `toolbar-${(press ?? click)!.record.t0}-${++this.forwardSequence}`, t0: (press ?? click)!.record.t0, commandId };
    if (!previous) this.env.forwardInput({ inputId: origin.inputId, t0: origin.t0, commandId });
    this.forwardedPress = { ...origin, target };
    for (const local of [press, click]) if (local) {
      local.record.commandId = commandId;
      local.record.extra = { ...local.record.extra, inputId: origin.inputId, nonCompleting: true };
      this.resetFrame(local);
      local.done = this.env.now(); local.record.doneSignal = "forwarded";
      this.flush(local, true);
    }
    return true;
  }
  private paletteRelease = (event: Event) => this.guard(() => {
    const press = this.flyoutPress;
    if (event.isTrusted && event.type === "pointerup" && !press?.requested && this.forwardCommand(event)) return;
    if (!event.isTrusted || !press || press.span.pointerId !== (event as PointerEvent).pointerId || press.requested) return;
    // Capture precedes React's pointerup handler, which stops propagation.
    this.task = press.span;
    this.resetFrame(press.span);
    if (event.type === "pointerup") {
      const commandId = press.target.getAttribute("data-command-id");
      if (commandId) press.span.record.commandId = commandId;
      press.span.expected = undefined;
    }
    this.env.defer(() => this.guard(() => {
      if (this.task === press.span) this.task = undefined;
      if (press.span.done === undefined && !press.span.registryObserved) {
        press.span.expected = "frame";
        press.span.frame = undefined;
        this.scheduleFrame(press.span, "input-task");
      }
    }));
  });
  private release = (event: Event) => this.guard(() => {
    if (!event.isTrusted) return;
    // Runs after React's pointerup handler: a drawing commit has already supplied its stronger
    // signal. A no-op/cancelled gesture must not be attributed to a later, unrelated edit.
    for (const span of this.pending) {
      if (span.record.kind === "pointerdown" && !span.record.commandId && span.done === undefined
        && span.expected === "document-commit" && span.pointerId === (event as PointerEvent).pointerId) {
        this.finish(span, "gesture-ended"); this.scheduleFrame(span, "gesture-end");
      }
    }
  });
  private native = (event: Event) => this.guard(() => {
    const detail = (event as CustomEvent<{ commandId?: string }>).detail;
    const commandId = detail?.commandId;
    if (typeof commandId !== "string") return;
    const span = this.capture("native-command", this.env.now());
    span.deliveredAt = span.record.t0;
    this.deliveries.push(span);
    if (this.deliveries.length > 256) this.deliveries.shift();
    this.command(commandId);
  });
  /** Only the dedicated perf event calls this; native-command stays an app-only payload. */
  forwardedInput(input: { inputId: string; t0: number; commandId: string; window: string }): void {
    this.guard(() => {
      if (!input || !Number.isFinite(input.t0) || !input.inputId || !input.commandId || !input.window) return;
      this.forwards.push(input);
      if (this.forwards.length > 256) this.forwards.shift();
    });
  }
  private correlateForward(span: Span): void {
    if (span.deliveredAt === undefined) return;
    const groups = new Map<Span, typeof this.forwards>();
    for (const input of this.forwards) {
      if (input.commandId !== span.record.commandId) continue;
      const first = this.deliveries.find(delivery => delivery.record.commandId === input.commandId
        && delivery.deliveredAt! >= input.t0 - COMPLETION_CLOCK_SKEW_MS
        && delivery.deliveredAt! - input.t0 <= 250);
      if (first) groups.set(first, [...(groups.get(first) ?? []), input]);
    }
    const candidates = groups.get(span) ?? [];
    // An earlier ambiguous delivery consumed no identifiable origin. Later deliveries inside
    // that set's window remain ambiguous too, rather than claiming a shorter native latency.
    const overlapping = candidates.length ? [] : [...groups.values()].filter(group => group.length > 1)
      .flat().filter(input => span.deliveredAt! >= input.t0 - COMPLETION_CLOCK_SKEW_MS && span.deliveredAt! - input.t0 <= 250);
    if (candidates.length > 1 || overlapping.length) {
      span.record.extra = { ...span.record.extra, forwardAmbiguous: true,
        candidateInputIds: (candidates.length ? candidates : overlapping).map(input => input.inputId), nativeDeliveredAt: span.deliveredAt };
    } else if (candidates.length === 1) {
      const origin = candidates[0];
      const delta = span.record.t0 - origin.t0;
      if (span.record.windowShownMs !== undefined) span.record.windowShownMs = Math.max(0, span.record.windowShownMs + delta);
      span.record.t0 = origin.t0;
      span.record.extra = { ...span.record.extra, forwarded: true, originInputId: origin.inputId,
        originWindow: origin.window, nativeDeliveredAt: span.deliveredAt };
    }
  }
  private capture(kind: PerfRecord["kind"], t0: number) {
    const span = this.start(kind, t0);
    this.task = span;
    // React's discrete event updates flush before this microtask. DOM mutations can reschedule
    // this frame; an input with no DOM update is explicitly labelled input-task instead.
    this.env.defer(() => this.guard(() => {
      if (this.task === span) this.task = undefined;
      if (!span.registryObserved && !span.expected && span.done === undefined) span.expected = "frame";
      this.scheduleFrame(span, "input-task");
    }));
    return span;
  }
  private start(kind: PerfRecord["kind"], t0 = this.env.now(), commandId?: string): Span {
    const span: Span = { record: { v: 3, kind, t0, commandId, window: this.env.window,
      platform: this.env.platform, buildStamp: this.env.buildStamp,
      extra: { clockErrorMs: this.env.clockErrorMs, processStart: this.env.processStart } } };
    this.pending.add(span);
    // Bound memory and ensure cancelled/picker/no-op commands never masquerade as completions.
    if (this.pending.size > 256) this.expire(this.pending.values().next().value!);
    span.timer = this.env.timeout(() => this.guard(() => this.expire(span)), Math.max(0, 120_000 - (this.env.now() - t0)));
    return span;
  }
  command(commandId: string): Span | undefined {
    return this.guard(() => {
      const span = this.task ?? [...this.pending].reverse().find(p => p.record.commandId === commandId && p.done === undefined);
      if (!span || commandId.length > 256) return undefined;
      const firstBinding = span.record.commandId !== commandId;
      span.record.commandId = commandId;
      if (firstBinding || span.expected === undefined || span.expected === "popover-shown") {
        span.expected = commandId === "view.togglePreferences" ? "window-shown"
          : commandId === "plugins.manage" ? "dialog-open"
          : commandId === "document.open" ? "document-commit"
          : commandId === "export.open" || commandId === "page.setSizeCustom" || commandId === "layout.arrangementSpacing" ? "dialog-open"
          : commandId.startsWith("view.toolset.toggle.") ? "window-shown" : undefined;
      }
      return span;
    });
  }
  setShortcutRegistry(registry: ShortcutRegistry | undefined): void {
    this.guard(() => { this.shortcuts = registry; });
  }
  /** A content broadcast proves the hold requested an open; wait for its actual reveal. */
  popoverRequested(flyoutId: string): void {
    this.guard(() => {
      const press = this.flyoutPress;
      if (press?.span.record.extra?.flyoutId === flyoutId) press.requested = true;
      for (const span of this.pending) {
        if (span.record.extra?.flyoutId !== flyoutId || span.done !== undefined) continue;
        span.expected = "popover-shown";
        this.resetFrame(span);
      }
    });
  }
  popoverShown(flyoutId: string, at: number, frameAt: number | undefined, window: string, signal: "popover-shown" | "no-op" | "failed" = "popover-shown", rafAt?: number): void {
    this.guard(() => {
      for (const span of [...this.pending]) {
        if (span.expected !== "popover-shown" || span.record.extra?.flyoutId !== flyoutId || span.done !== undefined) continue;
        if (!Number.isFinite(at) || at < span.record.t0 - COMPLETION_CLOCK_SKEW_MS) continue;
        if (signal === "popover-shown" && frameAt === undefined) continue;
        if (frameAt !== undefined && (!Number.isFinite(frameAt) || frameAt < at - COMPLETION_CLOCK_SKEW_MS)) continue;
        // Content has no request token. Disclose the palette/flyout matching inference.
        span.record.extra = { ...span.record.extra, approximateCompletion: true };
        span.requestKey = "popover-shown";
        span.expected = signal;
        this.remoteCompletion("popover-shown", signal, at, frameAt, window, rafAt);
        if (span.done !== undefined && signal !== "popover-shown") this.flush(span, true);
      }
    });
  }
  /** Destination rows inherit the initiating command's timestamp when it is still pending. */
  surfaceStarted(window: PerfRecord["window"], commandId?: string, surface?: string): Span | undefined {
    return this.guard(() => {
      const parent = commandId === undefined ? undefined : [...this.pending].reverse().find(p => p.record.commandId === commandId && p.done === undefined);
      const span = this.start(window === "dialog" ? "dialog-open" : "window-shown", parent?.record.t0, commandId);
      span.parent = parent;
      span.expected = window === "dialog" ? "dialog-open" : "window-shown";
      span.record.window = window;
      span.record.extra = { ...span.record.extra, originWindow: this.env.window, surface };
      return span;
    });
  }
  surfaceShown(span: Span | undefined, signal: DoneSignal): void {
    this.guard(() => {
      if (!span || span.done !== undefined) return;
      // Closing a toggle settles its input but does not claim a shown surface.
      if (signal === "command-finished") {
        span.done = this.env.now();
        if (span.timer !== undefined) this.env.clearTimeout(span.timer);
        this.pending.delete(span);
        if (span.parent) { this.finish(span.parent, signal); this.scheduleFrame(span.parent, "input-task"); }
        return;
      }
      span.record.extra = { ...span.record.extra, frameWindow: this.env.window };
      this.finish(span, signal); this.scheduleFrame(span, "window-shown");
      // Hidden/dismissed destinations may suspend rAF. A no-op claims no visible frame.
      if (signal === "no-op" || signal === "failed") this.flush(span, true);
      if (span.parent) { this.finish(span.parent, signal); this.scheduleFrame(span.parent, "window-shown"); }
    });
  }
  /** Wrap this instance only, preserving arguments, results, rejection and invocation count. */
  instrumentRegistry(registry: CommandRegistry): void {
    return this.guard(() => {
      if (this.instrumentedRegistries.has(registry)) return;
      this.instrumentedRegistries.add(registry);
      const invoke = registry.invoke.bind(registry);
      registry.invoke = <Result>(...args: Parameters<CommandRegistry["invoke"]>): Promise<Result> => {
        const span = this.guard(() => this.command(args[0]));
        if (span) span.registryObserved = true;
        if (span) this.activeRegistry.add(span);
        const result = invoke<Result>(...args);
        void result.then(() => this.guard(() => {
          if (span) this.activeRegistry.delete(span);
          if (span && !span.expected && span.done === undefined) this.finish(span, "command-finished");
        }), () => this.guard(() => { if (span) { this.activeRegistry.delete(span); this.finish(span, "failed"); } }));
        return result;
      };
    });
  }
  registryExpected(span: Span | undefined): void {
    this.guard(() => { if (span) span.registryObserved = true; });
  }
  dispatchReturned(span: Span | undefined): void {
    return this.guard(() => {
      if (span && !span.registryObserved && !span.expected && span.done === undefined) this.finish(span, "command-finished");
    });
  }
  expectSignal(signal: DoneSignal, commandId?: string): Span | undefined {
    return this.guard(() => {
      const span = commandId ? [...this.pending].reverse().find(p => p.record.commandId === commandId && p.done === undefined)
        : this.task ?? (this.activeRegistry.size === 1 ? [...this.activeRegistry][0] : undefined);
      if (span) span.expected = signal;
      // The sole active registry invocation is a heuristic after an async yield. An unrelated
      // operation can request a signal then, so keep that attribution visible to log consumers.
      if (span && !commandId && !this.task) span.record.extra = { ...span.record.extra, approximateCompletion: true };
      return span;
    });
  }
  complete(span: Span, signal: DoneSignal): void {
    this.guard(() => {
      if (span.expected === "window-painted" && signal === "window-shown") {
        span.record.windowShownMs ??= Math.max(0, this.env.now() - span.record.t0);
        return;
      }
      if (signal === "command-finished" || signal === "failed") { span.expected = signal; span.requestKey = undefined; }
      this.finish(span, signal);
      if (signal === "command-finished" || signal === "failed") this.scheduleFrame(span, "input-task");
    });
  }
  signal(signal: DoneSignal, commandId?: string): void {
    return this.guard(() => {
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
    });
  }
  timestamp(): number | undefined {
    return this.guard(() => this.env.now());
  }
  nativeWindowStarted(inputId: string, commandId?: string, destination?: string): { inputId: string; t0: number; commandId?: string } | undefined {
    return this.guard(() => {
      const span = this.expectSignal("window-painted", commandId);
      if (!span) return;
      inputId = span.record.extra?.inputId as string ?? inputId;
      span.requestKey = inputId;
      span.destination = destination;
      span.record.extra = { ...span.record.extra, inputId };
      this.resetFrame(span);
      return { inputId, t0: span.record.t0, commandId: span.record.commandId };
    });
  }
  nativeWindowShown(inputId: string, at: number): void {
    this.guard(() => {
      const span = [...this.pending].find(p => p.requestKey === inputId);
      if (span) span.record.windowShownMs = Math.max(0, at - span.record.t0);
    });
  }
  destinationPaint(request: { inputId: string; t0: number; commandId?: string; shownAt?: number }, frameAt: number, rafAt: number, surface: string, contentfulAt = frameAt, paintMethod = "post-paint-content"): void {
    this.guard(() => {
      const startup = request.inputId.startsWith("startup-");
      const span = this.start(startup ? "startup" : this.env.window === "settings" ? "dialog-open" : "window-shown", request.t0, request.commandId);
      span.record.extra = { ...span.record.extra, inputId: request.inputId, surface, paintMethod, frameSource: "destination-window" };
      span.record.windowShownMs = request.shownAt === undefined ? undefined : Math.max(0, request.shownAt - request.t0);
      span.done = contentfulAt; span.frame = frameAt; span.rafStart = rafAt; span.record.doneSignal = startup ? "startup-painted" : "window-painted";
      this.flush(span);
    });
  }
  expectCompletion(signal: DoneSignal, requestKey: string): void {
    return this.guard(() => {
      const span = this.task ?? [...this.pending].reverse().find(p => p.expected === signal && p.done === undefined && !p.requestKey);
      if (!span) return;
      span.expected = signal; span.requestKey = requestKey;
    });
  }
  /** Paint reports are authenticated by window label; main joins by destination and time. */
  remoteNativePaint(target: string, at: number, frameAt: number, window: string, rafAt: number, shownAt?: number): void {
    this.guard(() => {
      const candidates = [...this.pending].filter(span => span.destination === target
        && span.expected === "window-painted" && span.record.t0 <= at + COMPLETION_CLOCK_SKEW_MS
        && at - span.record.t0 <= 120_000);
      if (candidates.length !== 1) {
        for (const span of candidates) span.record.extra = { ...span.record.extra, destinationAmbiguous: true };
        return;
      }
      this.remoteCompletion(candidates[0].requestKey!, "window-painted", at, frameAt, window, rafAt, shownAt);
    });
  }
  remoteCompletion(requestKey: string, signal: DoneSignal, at: number, frameAt?: number, window?: string, rafAt?: number, shownAt?: number): void {
    return this.guard(() => {
      const span = [...this.pending].find(p => p.requestKey === requestKey && p.expected === signal);
      if (!span || !Number.isFinite(at) || at < 0 || at < span.record.t0 - COMPLETION_CLOCK_SKEW_MS) return;
      if (frameAt !== undefined && (!Number.isFinite(frameAt) || frameAt < 0 || frameAt < at - COMPLETION_CLOCK_SKEW_MS)) return;
      if (rafAt !== undefined && (!Number.isFinite(rafAt) || rafAt < 0 || frameAt === undefined || frameAt < rafAt)) return;
      if (shownAt !== undefined && (!Number.isFinite(shownAt) || shownAt < span.record.t0 - COMPLETION_CLOCK_SKEW_MS)) return;
      span.done = Math.max(at, span.record.t0); span.record.doneSignal = signal;
      span.record.extra = { ...span.record.extra, completionWindow: window };
      if (shownAt !== undefined) span.record.windowShownMs = Math.max(0, shownAt - span.record.t0);
      if (at < span.record.t0 || (frameAt !== undefined && frameAt < at)) span.record.extra.clockSkewAdjusted = true;
      if (frameAt !== undefined) {
        span.frame = Math.max(frameAt, span.record.t0);
        span.rafStart = rafAt;
        span.record.extra.frameSource = "destination-window";
      }
      this.flush(span);
    });
  }
  documentOpenStarted(): Span | undefined {
    return this.guard(() => {
      const command = [...this.pending].find(p => p.record.commandId === "document.open" && p.record.kind !== "document-open" && p.done === undefined);
      const span = this.start("document-open", command?.record.t0, "document.open");
      span.parent = command;
      return span;
    });
  }
  documentOpenCommitted(span: Span | undefined): void {
    return this.guard(() => {
      if (!span) return;
      for (const item of [span, span.parent]) {
        if (!item) continue;
        this.resetFrame(item);
      }
      this.finish(span, "document-commit");
      const command = span.parent;
      if (command) { this.finish(command, "document-commit"); this.scheduleFrame(command, "document-open"); }
      // Called after open's last state update. rAF follows its React commit.
      this.scheduleFrame(span, "document-open");
    });
  }
  documentOpenSkipped(span: Span | undefined, outcome: "queued" | "already-open"): void {
    return this.guard(() => {
      if (!span) return;
      for (const item of [span, span.parent]) {
        if (!item) continue;
        item.record.extra = { ...item.record.extra, openOutcome: outcome };
        this.finish(item, "command-finished");
        this.scheduleFrame(item, "document-open");
      }
    });
  }
  documentOpenFailed(span: Span | undefined): void {
    return this.guard(() => {
      if (!span) return;
      this.finish(span, "failed"); this.scheduleFrame(span, "failed");
      if (span.parent) { this.finish(span.parent, "failed"); this.scheduleFrame(span.parent, "failed"); }
    });
  }
  readyCanvas(readyAt?: number): void {
    return this.guard(() => {
      if (this.ready || !this.launch) return;
      this.ready = true;
      const span = this.launch;
      span.done = readyAt ?? this.env.now(); span.record.doneSignal = "canvas-ready";
      span.raf = this.env.frame(() => this.guard(() => {
        span.raf = undefined; span.rafStart = this.env.now();
        this.env.afterPaint(() => this.guard(() => {
          if (!this.pending.has(span)) return;
          span.frame = this.env.now(); this.flush(span);
        }));
      }));
    });
  }
  /** Called after React/DOM commit, never before setState. */
  rendered(): void {
    return this.guard(() => {
      for (const span of this.pending) {
        if (span.record.kind !== "cold-launch" && span.frame === undefined && (span.record.kind !== "document-open" || span.done !== undefined)) this.scheduleFrame(span, "dom-commit");
      }
    });
  }
  private scheduleFrame(span: Span, source: string) {
    if (!this.pending.has(span) || span.frame !== undefined || span.record.kind === "cold-launch") return;
    if ((span.record.kind === "window-shown" || span.record.kind === "dialog-open") && span.done === undefined) return;
    if (span.record.kind === "document-open" && span.done === undefined) return;
    if (span.record.commandId === "document.open" && span.done === undefined) return;
    if ((span.expected === "window-shown" || span.expected === "popover-shown") && span.done === undefined) return;
    if (span.expected === "window-painted") return;
    if (span.record.kind === "document-open" || span.record.commandId === "document.open") source = "document-open";
    this.resetFrame(span);
    const generation = span.frameGeneration;
    span.raf = this.env.frame(() => this.guard(() => {
      span.raf = undefined;
      const rafStart = this.env.now();
      this.env.afterPaint(() => this.guard(() => {
        if (!this.pending.has(span) || span.frameGeneration !== generation) return;
        span.rafStart = rafStart; span.frame = this.env.now();
        span.record.extra = { ...span.record.extra, frameSource: source };
        if (span.expected === "frame" && span.done === undefined) this.finish(span, "frame");
        this.flush(span);
      }));
    }));
  }
  private resetFrame(span: Span) {
    if (span.raf !== undefined) this.env.cancelFrame(span.raf);
    span.raf = undefined; span.frame = undefined; span.rafStart = undefined;
    span.frameGeneration = (span.frameGeneration ?? 0) + 1;
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
    if (span.expected === "window-painted") span.record.extra.missingDestinationPaint = true;
    this.flush(span, true);
  }
  private flush(span: Span, incomplete = false) {
    if (this.stopped || !this.pending.has(span) || span.done === undefined || (!incomplete && span.frame === undefined)) return;
    if (span.deliveredAt !== undefined && this.env.correlationDelayMs && !incomplete) {
      if (this.env.now() < span.deliveredAt + this.env.correlationDelayMs) {
        if (span.correlationTimer === undefined) span.correlationTimer = this.env.timeout(() => this.guard(() => {
          span.correlationTimer = undefined; this.flush(span);
        }), span.deliveredAt + this.env.correlationDelayMs - this.env.now());
        return;
      }
    }
    this.correlateForward(span);
    if (span.correlationTimer !== undefined) this.env.clearTimeout(span.correlationTimer);
    if (span.timer !== undefined) this.env.clearTimeout(span.timer);
    if (span.raf !== undefined) this.env.cancelFrame(span.raf);
    this.pending.delete(span);
    const elapsed = (time: number) => Math.max(0, time - span.record.t0);
    const record = PerfRecordSchema.safeParse({ ...span.record, doneMs: span.record.doneSignal === "forwarded" ? undefined : elapsed(span.done),
      rafStartMs: span.rafStart === undefined ? undefined : elapsed(span.rafStart),
      firstFrameMs: span.frame === undefined ? undefined : elapsed(span.frame) });
    if (!record.success) throw new Error("Perf probe produced an invalid sample");
    this.guard(() => this.env.write(record.data));
  }
  stop(): void {
    this.stopped = true;
    const cleanup = (hook: () => unknown) => {
      try {
        const result = hook();
        if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(() => undefined);
      } catch { /* Already disabled. */ }
    };
    for (const kind of ["pointerdown", "click", "keydown"] as const) cleanup(() => this.env.target.removeEventListener(kind, this.input, true));
    cleanup(() => this.env.target.removeEventListener("chemdraft:native-command", this.native, true));
    for (const kind of ["pointerup", "pointercancel"]) cleanup(() => this.env.target.removeEventListener(kind, this.paletteRelease, true));
    for (const kind of ["pointerup", "pointercancel"]) cleanup(() => this.env.target.removeEventListener(kind, this.release));
    for (const span of this.pending) {
      if (span.correlationTimer !== undefined) cleanup(() => this.env.clearTimeout(span.correlationTimer!));
      if (span.timer !== undefined) cleanup(() => this.env.clearTimeout(span.timer!));
      if (span.raf !== undefined) cleanup(() => this.env.cancelFrame(span.raf!));
    }
    this.pending.clear();
    this.forwards = []; this.deliveries = [];
    this.activeRegistry.clear();
    this.task = undefined;
    cleanup(() => this.env.onStop?.());
  }
}

export function createPerfProbe(enabled: boolean, environment: () => ProbeEnvironment): PerfProbe | undefined {
  if (!enabled) return undefined;
  return new PerfProbe(environment());
}
