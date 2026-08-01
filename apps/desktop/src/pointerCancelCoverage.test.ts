import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every drag family that snapshots a start document must restore it when the gesture is cancelled.
 *
 * This is asserted structurally rather than behaviourally on purpose. The rule is about *coverage* —
 * "no drag family is missing a cancel branch" — which is a property of the whole set, not of any one
 * gesture, and the failure mode is silent: a pointer cancel mid-drag simply leaves the preview
 * document standing, un-restored and with no undo entry to get back from.
 *
 * Object resize and corner-radius capture on the page, so a cancel is delivered to
 * `handlePagePointerCancel`, which had no branch for either. `handleObjectPointerCancel` covered
 * them for the object-capture case, which is what made the gap easy to miss by reading one handler.
 */
describe("pointer-cancel coverage", () => {
  const source = readFileSync("apps/desktop/src/MainWindow.tsx", "utf8");

  /** The body of a `const <name> = useCallback(` up to the next top-level declaration. */
  function callbackBody(name: string): string {
    const parts = source.split(`const ${name} = useCallback(`);
    expect(parts).toHaveLength(2);
    return parts[1].split("\n  const ")[0];
  }

  it("restores every drag family that captures a start document", () => {
    const dragStatesWithStartDocument = new Set(
      [...source.matchAll(/type (\w+DragState) = \{(.*?)\n\};/gs)]
        .filter(([, , body]) => body.includes("startDocument"))
        .map(([, name]) => name)
    );
    const dragRefs = [...source.matchAll(/const (\w+Ref) = useRef<(\w+DragState) \| null>/g)]
      .filter(([, , stateType]) => dragStatesWithStartDocument.has(stateType))
      .map(([, ref]) => ref);

    // Sanity: the scan must actually find the families, or this test passes vacuously forever.
    expect(dragRefs.length).toBeGreaterThan(10);
    expect(dragRefs).toContain("objectResizeDragRef");
    expect(dragRefs).toContain("graphicCornerRadiusDragRef");

    // A gesture is cancelled through whichever element holds the pointer capture, so a family is
    // covered if either handler restores it.
    const cancelHandlers = callbackBody("handlePagePointerCancel") + callbackBody("handleObjectPointerCancel");
    const uncovered = dragRefs.filter((ref) => !cancelHandlers.includes(`${ref}.current`));

    expect(uncovered).toEqual([]);
  });

  it("restores the two page-capturing families from the page handler specifically", () => {
    // These capture on the page (`pageRef.current.setPointerCapture`), so the page handler is the
    // one that actually fires for them — being listed only in the object handler is not coverage.
    const pageCancel = callbackBody("handlePagePointerCancel");

    expect(pageCancel).toContain("objectResizeDragRef.current");
    expect(pageCancel).toContain("graphicCornerRadiusDragRef.current");
    expect(pageCancel).toContain("replacePresentDocument(objectResizeDrag.startDocument)");
    expect(pageCancel).toContain("replacePresentDocument(graphicCornerRadiusDrag.startDocument)");
  });
});
