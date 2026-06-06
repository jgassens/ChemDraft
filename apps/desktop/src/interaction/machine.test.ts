import { describe, it, expect } from "vitest";

import {
  initialInteractionState,
  interactionReducer,
  type InteractionState,
  type InteractionTarget
} from "./machine";

const atom: InteractionTarget = { kind: "atom", objectId: "m1", atomId: "a1" };
const object: InteractionTarget = { kind: "object", objectId: "m1" };
const empty: InteractionTarget = { kind: "empty" };

const move = (state: InteractionState, x: number, target: InteractionTarget) =>
  interactionReducer(state, { type: "pointerMove", pointerId: 1, world: { x, y: 0 }, target });

describe("interaction machine", () => {
  it("hovers whatever the pointer is over while idle", () => {
    const state = move(initialInteractionState(), 0, atom);
    expect(state.phase).toBe("hovering");
    expect(state.hoverTarget).toEqual(atom);
  });

  it("goes idle (no hover) over empty space", () => {
    const state = move(initialInteractionState(), 0, empty);
    expect(state.phase).toBe("idle");
    expect(state.hoverTarget).toEqual(empty);
  });

  it("does not strand hover during a drag and re-acquires it exactly once on pointer up", () => {
    let state = move(initialInteractionState(), 0, atom);
    expect(state.hoverTarget).toEqual(atom);

    state = interactionReducer(state, {
      type: "pointerDown",
      pointerId: 1,
      world: { x: 0, y: 0 },
      target: atom,
      dragKind: "object-move"
    });
    expect(state.phase).toBe("pressing");
    expect(state.hoverTarget).toBeUndefined();

    state = move(state, 10, empty); // crosses the 4px threshold
    expect(state.phase).toBe("dragging");
    expect(state.hoverTarget).toBeUndefined();

    // Moving back over an atom mid-drag must NOT resurrect the hover highlight.
    state = move(state, 5, atom);
    expect(state.phase).toBe("dragging");
    expect(state.hoverTarget).toBeUndefined();

    state = interactionReducer(state, {
      type: "pointerUp",
      pointerId: 1,
      world: { x: 5, y: 0 },
      target: atom
    });
    expect(state.phase).toBe("hovering");
    expect(state.hoverTarget).toEqual(atom);
  });

  it("treats a press that never crosses the threshold as a click, not a drag", () => {
    let state = interactionReducer(initialInteractionState(), {
      type: "pointerDown",
      pointerId: 1,
      world: { x: 0, y: 0 },
      target: atom,
      dragKind: "object-move"
    });
    state = move(state, 2, atom); // 2px < 4px threshold
    expect(state.phase).toBe("pressing");

    state = interactionReducer(state, {
      type: "pointerUp",
      pointerId: 1,
      world: { x: 2, y: 0 },
      target: atom
    });
    expect(state.phase).toBe("hovering");
  });

  it("handles the exact marquee gesture sequence from press to threshold to release", () => {
    // 1. pointerDown on empty space
    let state = interactionReducer(initialInteractionState(), {
      type: "pointerDown",
      pointerId: 1,
      world: { x: 0, y: 0 },
      target: empty,
      dragKind: "marquee"
    });
    expect(state.phase).toBe("pressing");
    expect(state.dragKind).toBe("marquee");

    // 2. move < 4px stays pressing
    state = move(state, 3, empty);
    expect(state.phase).toBe("pressing");

    // 3. move >= 4px transitions to dragging
    state = move(state, 4, empty);
    expect(state.phase).toBe("dragging");
    expect(state.dragKind).toBe("marquee");

    // 4. pointerUp returns to idle
    state = interactionReducer(state, {
      type: "pointerUp",
      pointerId: 1,
      world: { x: 4, y: 0 },
      target: empty
    });
    expect(state.phase).toBe("idle");
  });

  it("handles the exact placement gesture sequence from press to threshold to release", () => {
    // 1. pointerDown on empty space
    let state = interactionReducer(initialInteractionState(), {
      type: "pointerDown",
      pointerId: 1,
      world: { x: 0, y: 0 },
      target: empty,
      dragKind: "placement"
    });
    expect(state.phase).toBe("pressing");
    expect(state.dragKind).toBe("placement");

    // 2. move < 4px stays pressing
    state = move(state, 3, empty);
    expect(state.phase).toBe("pressing");

    // 3. move >= 4px transitions to dragging
    state = move(state, 4, empty);
    expect(state.phase).toBe("dragging");
    expect(state.dragKind).toBe("placement");

    // 4. pointerUp returns to idle
    state = interactionReducer(state, {
      type: "pointerUp",
      pointerId: 1,
      world: { x: 4, y: 0 },
      target: empty
    });
    expect(state.phase).toBe("idle");
  });

  it("starts a move from an object", () => {

    const drag = move(
      interactionReducer(initialInteractionState(), {
        type: "pointerDown",
        pointerId: 1,
        world: { x: 0, y: 0 },
        target: object,
        dragKind: "object-move"
      }),
      6,
      empty
    );
    expect(drag.phase).toBe("dragging");
    expect(drag.dragKind).toBe("object-move");
  });

  it("uses the larger threshold for freeform bond drags", () => {
    let state = interactionReducer(initialInteractionState(), {
      type: "pointerDown",
      pointerId: 1,
      world: { x: 0, y: 0 },
      target: atom,
      dragKind: "freeform-bond"
    });
    state = move(state, 5, atom); // 5px < 6px threshold
    expect(state.phase).toBe("pressing");
    state = move(state, 7, atom); // 7px >= 6px
    expect(state.phase).toBe("dragging");
  });

  it("ignores pointer events from a different pointer id mid-press", () => {
    const pressed = interactionReducer(initialInteractionState(), {
      type: "pointerDown",
      pointerId: 1,
      world: { x: 0, y: 0 },
      target: atom,
      dragKind: "object-move"
    });
    const other = interactionReducer(pressed, {
      type: "pointerUp",
      pointerId: 2,
      world: { x: 0, y: 0 },
      target: empty
    });
    expect(other).toBe(pressed);
  });
});
