import { useEffect, useRef } from "react";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { createBondStereoActions, createFlippedBondStereoAction, moleculeBondStereoCommandId } from "./commands";
import { nativeBondStereoAvailability, nativeBondStereoFlipDisabledReason } from "./documentWorkflow";
import {
  closeToolsetPopoverWindow, currentWindowLogicalPosition, listenForBondStereoPopoverActions,
  listenForToolsetPopoverContentRequests, listenForToolsetPopoverDismiss, openToolsetPopoverWindow,
  sendBondStereoPopoverAction, setToolsetPopoverContent, type ToolsetPopoverAnchor, type ToolsetPopoverContent
} from "./window-manager";

export const BOND_STEREO_POPOVER_ID = "core.bondStereo";
export type BondStereoBadgeRequest = { objectId: string; bondId: string; rect: Pick<DOMRect, "left" | "bottom">; keyboard: boolean };
type Target = { objectId: string; bondId: string };
type Reader = Parameters<typeof nativeBondStereoAvailability>[2];
type Session = { id: string; document: ChemDraftDocument; target: Target; content: ToolsetPopoverContent; anchor?: ToolsetPopoverAnchor };

/** The document owns the snapshot and command authority; the native window receives UI data only. */
export function useBondStereoPopover(options: {
  document: ChemDraftDocument; targets: readonly Target[]; reader: Reader;
  select(target: Target): void; invoke(commandId: string): void | Promise<void>; focusCanvas(): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const session = useRef<Session | undefined>(undefined);
  const serial = useRef(0);
  // Serialize native creation/closure so a cancelled cold open cannot hide or move
  // a newer session after its snapshot has already been delivered.
  const nativeWork = useRef(Promise.resolve());
  const enqueue = (work: () => Promise<void>, failed?: () => void) => {
    nativeWork.current = nativeWork.current.then(work).catch(() => failed?.());
  };
  const close = () => {
    if (!session.current) return;
    const id = session.current.id;
    session.current = undefined;
    void sendBondStereoPopoverAction({ sessionId: id, action: "close" }).catch(() => undefined);
    enqueue(() => closeToolsetPopoverWindow(BOND_STEREO_POPOVER_ID));
    latest.current.focusCanvas();
  };
  const push = async (opened: Session) => {
    if (session.current !== opened || !opened.anchor) return;
    await setToolsetPopoverContent(BOND_STEREO_POPOVER_ID, opened.content, opened.anchor);
  };

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const subscribe = (promise: Promise<() => void>) => { void promise.then(cleanup => disposed ? cleanup() : cleanups.push(cleanup)).catch(() => undefined); };
    subscribe(listenForToolsetPopoverContentRequests(id => {
      if (id === BOND_STEREO_POPOVER_ID && session.current) void push(session.current);
    }));
    subscribe(listenForToolsetPopoverDismiss(close));
    subscribe(listenForBondStereoPopoverActions(payload => {
      const opened = session.current;
      if (!opened || payload.sessionId !== opened.id) return;
      if (payload.action === "geometry" || payload.action === "flipped") {
        const current = latest.current;
        if (current.document !== opened.document || current.targets.length !== 1 ||
          current.targets[0].objectId !== opened.target.objectId || current.targets[0].bondId !== opened.target.bondId) {
          close(); return;
        }
        const commandId = moleculeBondStereoCommandId(payload.action);
        // Clear authority synchronously, before invocation: double clicks cannot write twice.
        close();
        void latest.current.invoke(commandId);
      } else if (payload.action === "keep" || payload.action === "close") close();
    }));
    const pointerAway = () => close();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.current) { event.preventDefault(); event.stopPropagation(); close(); }
    };
    window.addEventListener("pointerdown", pointerAway, true);
    window.addEventListener("keydown", escape, true);
    return () => { disposed = true; cleanups.forEach(cleanup => cleanup()); session.current = undefined;
      window.removeEventListener("pointerdown", pointerAway, true);
      window.removeEventListener("keydown", escape, true);
      enqueue(() => closeToolsetPopoverWindow(BOND_STEREO_POPOVER_ID)); };
  }, []);

  useEffect(() => {
    const opened = session.current;
    if (opened && (opened.document !== options.document || options.targets.length !== 1 ||
      options.targets[0].objectId !== opened.target.objectId || options.targets[0].bondId !== opened.target.bondId)) close();
  }, [options.document, options.targets]);

  return (request: BondStereoBadgeRequest) => {
    close();
    const { document, reader } = latest.current;
    const target = { objectId: request.objectId, bondId: request.bondId };
    const molecule = document.pages.flatMap(page => page.objects).find(object => object.id === target.objectId);
    if (molecule?.type !== "molecule" || !molecule.bonds.some(bond => bond.id === target.bondId && bond.stereo === "either")) return;
    const state = nativeBondStereoAvailability(document, [target], reader);
    latest.current.select(target);
    const actions = [createBondStereoActions(state)[1], createFlippedBondStereoAction(state,
      nativeBondStereoFlipDisabledReason(document, [target], reader))];
    const id = `bond-stereo-${Date.now()}-${++serial.current}`;
    const opened: Session = { id, document, target, content: { kind: "flyout", flyout: {
      id, flyoutId: BOND_STEREO_POPOVER_ID, title: "E/Z not specified", variant: "bondStereo", keyboardOpen: request.keyboard,
      commands: actions.map(action => ({ id: action.id, title: action.title, enabled: action.enabled !== false,
        active: false, disabledReason: action.disabledReason }))
    } } };
    session.current = opened;
    enqueue(async () => {
      if (session.current !== opened) return;
      const position = await currentWindowLogicalPosition("inner");
      if (session.current !== opened) return;
      if (!position) { close(); return; }
      opened.anchor = { x: position.x + request.rect.left, y: position.y + request.rect.bottom + 4 };
      await openToolsetPopoverWindow(BOND_STEREO_POPOVER_ID, "flyout", opened.anchor.x, opened.anchor.y);
      if (session.current !== opened) return;
      await push(opened);
    }, () => { if (session.current === opened) close(); });
  };
}
