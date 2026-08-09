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
 *
 * Two things this scan originally got wrong, both of which let a real gap through:
 *
 *  - It keyed on the `\w+DragState` NAME SUFFIX, so `PathArtDrawState` — which carries a
 *    `startDocument` like every other family — was invisible, and `pathArtDrawRef` was cleared by
 *    neither handler. A structural test that selects its own subjects by naming convention only
 *    covers the families someone remembered to name conventionally. It now keys on the field.
 *  - It counted a MENTION of the ref as coverage, so a branch that read the state and did nothing
 *    with it would pass. It now requires one of the three disposal forms this file actually uses.
 */
describe("pointer-cancel coverage", () => {
  const source = readFileSync("apps/desktop/src/MainWindow.tsx", "utf8");

  /**
   * The executable body of a `const <name> = useCallback(`, stopping at its dependency array.
   *
   * Comments are stripped and the dep array is excluded because this scan is substring matching over
   * source text, and both are places a family's name appears without anything happening to it. Both
   * were caught red-handed: the prose comment introducing this very fix names `pathArtDrawRef.current`,
   * and `clearNativePathArtDraw` appears in both dep arrays — so with the branch deleted the handler
   * still "mentioned" the ref and still "called" the clear, and the coverage check passed on code
   * with no cancel branch at all.
   */
  function callbackBody(name: string): string {
    const parts = source.split(`const ${name} = useCallback(`);
    expect(parts).toHaveLength(2);
    const body = parts[1].split("\n  }, [")[0];
    expect(body.length).toBeGreaterThan(200);
    return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  }

  /**
   * The three forms this file uses to dispose of a cancelled gesture. Restoring is not universal:
   * a click-to-place path draw never writes a preview document, so clearing its state IS its
   * disposal. Requiring any one of these is what stops a branch that merely reads the ref from
   * counting as coverage.
   */
  function disposesFamily(handler: string, ref: string): boolean {
    const name = ref.replace(/Ref$/, "");
    const stem = name.charAt(0).toUpperCase() + name.slice(1);
    return (
      handler.includes(`replacePresentDocument(${name}.startDocument)`) ||
      handler.includes(`${ref}.current = null`) ||
      new RegExp(`clear(?:Native)?${stem}\\b`).test(handler)
    );
  }

  it("restores every drag family that captures a start document", () => {
    // Keyed on the `startDocument` FIELD, not on a `*DragState` name — see the note above.
    const statesWithStartDocument = new Set(
      [...source.matchAll(/type (\w+State) = \{(.*?)\n\};/gs)]
        .filter(([, , body]) => body.includes("startDocument"))
        .map(([, name]) => name)
    );
    const dragRefs = [...source.matchAll(/const (\w+Ref) = useRef<(\w+State) \| null>/g)]
      .filter(([, , stateType]) => statesWithStartDocument.has(stateType))
      .map(([, ref]) => ref);

    // Sanity: the scan must actually find the families, or this test passes vacuously forever.
    expect(dragRefs.length).toBeGreaterThan(10);
    expect(dragRefs).toContain("objectResizeDragRef");
    expect(dragRefs).toContain("graphicCornerRadiusDragRef");
    // The two the old `*DragState` suffix gate skipped.
    expect(dragRefs).toContain("pathArtDrawRef");
    expect(dragRefs).toContain("textResizeRef");

    // A gesture is cancelled through whichever element holds the pointer capture, so a family is
    // covered if either handler disposes of it.
    const cancelHandlers = callbackBody("handlePagePointerCancel") + callbackBody("handleObjectPointerCancel");
    const uncovered = dragRefs.filter(
      (ref) => !cancelHandlers.includes(`${ref}.current`) || !disposesFamily(cancelHandlers, ref)
    );

    expect(uncovered).toEqual([]);
  });

  it("abandons a path draw from both cancel handlers", () => {
    // Unlike resize and corner radius, a path draw is not bound to one capture element: a polyline
    // takes no pointer capture at all, and the pen captures whichever element received the click. So
    // the cancel can arrive at either handler, and disposing of it in only one leaves the other path
    // stranded — `pathArtDrawRef` gates two pointer-move paths with no pointerId check and an early
    // `return`, so a stranded draw swallows every later move and strands a stale commit base.
    for (const handler of ["handlePagePointerCancel", "handleObjectPointerCancel"]) {
      const body = callbackBody(handler);
      expect(body, handler).toContain("pathArtDrawRef.current");
      expect(body, handler).toContain("clearNativePathArtDraw()");
    }
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
