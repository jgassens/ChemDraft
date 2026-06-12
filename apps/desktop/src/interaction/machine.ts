/**
 * Explicit interaction state machine for the canvas.
 *
 * The pointer handling in MainWindow grew into a ladder of `if (xxxRef.current?.pointerId
 * === event.pointerId) return` guards, one per drag kind, with hover recomputed only
 * after every guard fell through. New drag kinds meant new guards, and it was easy for a
 * hover update to be skipped or stranded. This reducer models the interaction as a small
 * set of phases so the rules are explicit and testable:
 *
 *   idle ⇄ hovering → pressing → dragging(kind) → (back to) hovering
 *                       │                              ▲
 *                       └──────── click / up ──────────┘
 *
 * Key invariant: while `dragging`, the hover target is cleared and cannot be set, so a
 * stale highlight can never appear under the cursor mid-drag. On `pointerUp` we transition
 * straight back to `hovering`/`idle` from the up target, so hover re-acquires exactly once.
 *
 * The machine is pure: it decides *which phase we are in* and *whether a drag has crossed
 * its threshold*. It does not own the document or run effects — the caller maps
 * `dragKind` to the existing preview/commit logic. This keeps adoption incremental.
 */

export interface Point {
  x: number;
  y: number;
}

/** The kinds of drag the canvas supports, mirroring the existing ref-based drags. */
export type DragKind =
  | "text-resize"
  | "object-rotate"
  | "projected-plane-tilt"
  | "molecule-resize"
  | "group-resize"
  | "group-rotate"
  | "object-move"
  | "native-part"
  | "freeform-bond"
  | "placement"
  | "marquee";

/** What the pointer is over. `empty` means open canvas. */
export type InteractionTarget =
  | { kind: "atom"; objectId: string; atomId: string }
  | { kind: "bond"; objectId: string; bondId: string }
  | { kind: "object"; objectId: string }
  | { kind: "empty" };

export type InteractionPhase = "idle" | "hovering" | "pressing" | "dragging" | "editing";

export interface InteractionState {
  phase: InteractionPhase;
  pointerId?: number;
  /** Valid in idle/hovering — what the hover chrome should highlight. */
  hoverTarget?: InteractionTarget;
  /** Captured at pointerDown — what the press/drag is acting on. */
  pressTarget?: InteractionTarget;
  /** Valid in dragging — which drag is in progress. */
  dragKind?: DragKind;
  startWorld?: Point;
  latestWorld?: Point;
}

export type InteractionEvent =
  | { type: "pointerMove"; pointerId: number; world: Point; target: InteractionTarget }
  | {
      type: "pointerDown";
      pointerId: number;
      world: Point;
      target: InteractionTarget;
      dragKind: DragKind;
    }
  | { type: "pointerUp"; pointerId: number; world: Point; target: InteractionTarget }
  | { type: "enterEditing"; objectId: string }
  | { type: "cancel" };

/**
 * Movement (in page-space px) a press must exceed before it becomes a drag. Mirrors the
 * thresholds used by the existing handlers: OBJECT_DRAG_THRESHOLD = 4,
 * FREEFORM_BOND_DRAG_THRESHOLD = 6. `text-resize` engages immediately (handle drag).
 */
export const DRAG_THRESHOLDS: Record<DragKind, number> = {
  "text-resize": 0,
  "object-rotate": 4,
  "projected-plane-tilt": 4,
  "molecule-resize": 4,
  "group-resize": 4,
  "group-rotate": 4,
  "object-move": 4,
  "native-part": 4,
  "freeform-bond": 6,
  placement: 4,
  marquee: 4
};

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

/** Phase implied by a hover/up target: highlighting something ⇒ hovering, else idle. */
function restingPhase(target: InteractionTarget): "idle" | "hovering" {
  return target.kind === "empty" ? "idle" : "hovering";
}

export function initialInteractionState(): InteractionState {
  return { phase: "idle" };
}

export function interactionReducer(
  state: InteractionState,
  event: InteractionEvent
): InteractionState {
  switch (event.type) {
    case "pointerDown": {
      // Begin a press. Capture the target and the intended drag kind; hover is cleared
      // because a press is about to act, not hover.
      return {
        phase: "pressing",
        pointerId: event.pointerId,
        pressTarget: event.target,
        dragKind: event.dragKind,
        startWorld: event.world,
        latestWorld: event.world,
        hoverTarget: undefined
      };
    }

    case "pointerMove": {
      // Mid-press: promote to a drag once movement crosses the kind's threshold.
      if (state.phase === "pressing" && event.pointerId === state.pointerId) {
        const start = state.startWorld ?? event.world;
        const dragKind = state.dragKind ?? "object-move";
        const moved = distance(start, event.world);
        if (moved >= DRAG_THRESHOLDS[dragKind]) {
          return { ...state, phase: "dragging", latestWorld: event.world, hoverTarget: undefined };
        }
        return { ...state, latestWorld: event.world };
      }

      // Mid-drag: keep dragging; hover stays cleared (the invariant).
      if (state.phase === "dragging" && event.pointerId === state.pointerId) {
        return { ...state, latestWorld: event.world };
      }

      // While editing, a plain move does not disturb the editing session.
      if (state.phase === "editing") {
        return state;
      }

      // idle / hovering: this is the hover path — track what is under the pointer.
      return {
        phase: restingPhase(event.target),
        hoverTarget: event.target,
        latestWorld: event.world
      };
    }

    case "pointerUp": {
      // Only the pointer that pressed ends the press/drag.
      if (state.pointerId !== undefined && event.pointerId !== state.pointerId) {
        return state;
      }
      // End of press (click) or drag: re-acquire hover from the up target exactly once.
      return {
        phase: restingPhase(event.target),
        hoverTarget: event.target,
        latestWorld: event.world
      };
    }

    case "enterEditing": {
      return { phase: "editing", hoverTarget: undefined };
    }

    case "cancel": {
      return state.hoverTarget
        ? { phase: restingPhase(state.hoverTarget), hoverTarget: state.hoverTarget }
        : initialInteractionState();
    }

    default:
      return state;
  }
}
