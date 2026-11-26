// @vitest-environment jsdom
// RC 1.2.3 hands-on report (macOS): hovering an atom and pressing + (Shift+= on a US keyboard) picked
// the Positive Charge tool instead of charging the atom, while - charged it. Real key events through
// MainWindow, dispatched from the focused canvas with the Shift keydown first and no pointer move after
// it. Cause: some macOS input paths report Shift+= as key "=" (not "+"), which the hover table (literal
// "+") missed while the window shortcut registry folds +/= into the Positive Charge tool's chord.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChemDraftDocument } from "@chemdraft/chem-core";
import { transformPointForObject } from "@chemdraft/layout-engine";
import { ensureOclResources } from "@chemdraft/ocl-adapter";
import { MainWindow } from "./MainWindow";
import * as workflow from "./documentWorkflow";
import { KEYBINDING_STORAGE_KEY } from "./keybindingSettings";
import { dropMolecule } from "./testSupport/electronMarkDropFixture";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

type Point = { x: number; y: number };
const PLUS = { key: "+", code: "Equal", shiftKey: true };
// What some macOS input paths (and automation) report for Shift+=: the unshifted legend, Shift held.
const SHIFTED_EQUAL = { key: "=", code: "Equal", shiftKey: true };
// What automation tools inject for Shift+=: key "=" with the numpad-equal code.
const NUMPAD_EQUAL_SHIFTED = { key: "=", code: "NumpadEqual", shiftKey: true };
// An injected typed "+": macOS reports Unicode-typed text with the placeholder code KeyA.
const TYPED_PLUS = { key: "+", code: "KeyA" };
const BARE_EQUAL = { key: "=", code: "Equal" };
const NUMPAD_PLUS = { key: "+", code: "NumpadAdd" };
// A layout where + needs no Shift (German, Nordic): the key is labelled + on its own.
const UNSHIFTED_PLUS = { key: "+", code: "BracketRight" };
const MINUS = { key: "-", code: "Minus" };
const NUMPAD_MINUS = { key: "-", code: "NumpadSubtract" };
const NUMPAD_EQUAL = { key: "=", code: "NumpadEqual" };
// Real layouts with punctuation on letter positions (Dvorak: , on KeyW, . on KeyE, ; on KeyZ).
// Hover keys read the PHYSICAL letter there, exactly as RC2 did: only + and - bypass that mapping.
const DVORAK_COMMA = { key: ",", code: "KeyW" };
const DVORAK_PERIOD = { key: ".", code: "KeyE" };
const DVORAK_SEMICOLON = { key: ";", code: "KeyZ" };
// AZERTY puts , on KeyM; ; sits on Comma, which is not a letter code.
const AZERTY_COMMA = { key: ",", code: "KeyM" };
const AZERTY_SEMICOLON = { key: ";", code: "Comma" };
// Letters from other scripts still map to the physical letter.
const GREEK_ALPHA = { key: "α", code: "KeyA" };
const CYRILLIC_EF = { key: "ф", code: "KeyA" };
const DEAD_KEY = { key: "Dead", code: "KeyE" };
const LETTER_A = { key: "a", code: "KeyA" };
const LETTER_E = { key: "e", code: "KeyE" };

beforeAll(async () => { await ensureOclResources(); });

// The ChemDraft scheme binds + and - to the charge tools as well as to the hovered atom; the
// classic (ChemDraw) scheme binds them to the hovered atom only.
describe.each([
  { platform: "macos", scheme: "chemdraft" }, { platform: "windows", scheme: "chemdraft" },
  { platform: "macos", scheme: "chemdraw" }, { platform: "windows", scheme: "chemdraw" }
] as const)("hover charge keys on $platform, $scheme scheme", ({ platform, scheme }) => {
  let container: HTMLDivElement, root: Root;
  let frames: Map<number, FrameRequestCallback>, frameId: number;
  beforeEach(() => {
    const storage = new MemoryStorage();
    storage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify({ scheme }));
    vi.stubGlobal("localStorage", storage);
    frames = new Map(); frameId = 0;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function mount(document: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, { initialDocument: document,
      initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: true,
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform })));
    // The canvas region too, so the pointer counts as inside it and a key edit re-hits the hover.
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
  }
  const agent = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const snapshot = () => agent().document;
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  async function move(point: Point) {
    await act(async () => {
      const event = new MouseEvent("pointermove", { bubbles: true, cancelable: true, button: 0, buttons: 0,
        clientX: point.x, clientY: point.y });
      Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
      (container.querySelector(".native-molecule-object") ?? container.querySelector(".page")!).dispatchEvent(event);
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(performance.now()));
    });
  }
  const canvas = () => container.querySelector<HTMLElement>(".canvas-region")!;
  const key = (type: string, options: KeyboardEventInit) =>
    canvas().dispatchEvent(new KeyboardEvent(type, { ...options, bubbles: true, cancelable: true }));
  /**
   * What a real keyboard sends to the focused canvas: Shift first when the character needs it, then
   * the character, with no pointer move in between. `afterShift` runs while Shift is held.
   */
  async function press(init: KeyboardEventInit, afterShift?: () => Promise<void>) {
    canvas().focus();
    if (init.shiftKey) {
      await act(async () => key("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true }));
      await afterShift?.();
    }
    await act(async () => { key("keydown", init); key("keyup", init); });
    if (init.shiftKey) await act(async () => key("keyup", { key: "Shift", code: "ShiftLeft" }));
  }
  /** A benzene ring, whole-selected as it is right after placement (the hands-on state). */
  async function benzene(selected = true) {
    const inserted = workflow.insertNativeTemplateMolecule(workflow.createPhase4Document("Hover charge"), { x: 300, y: 300 }, "benzene");
    const moleculeId = inserted.selection.objectIds[0]!;
    await mount(selected ? inserted : workflow.selectDocumentObjects(inserted, inserted.pages[0].id, []));
    return moleculeId;
  }
  async function hoverAtom(moleculeId: string) {
    const owner = snapshot().pages[0].objects.find(object => object.id === moleculeId) as ReturnType<typeof dropMolecule>;
    await move(transformPointForObject(owner, owner.atoms.find(atom => atom.id === "atom_001")!));
    expect(agent().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: "atom_001" });
  }
  const marks = () => snapshot().pages[0].objects.filter(object => object.type === "electron-mark");
  const charge = () => dropMolecule(snapshot()).atoms.find(atom => atom.id === "atom_001")!.formalCharge;
  /** The concrete, comparable result of a key press over the hovered ring atom. */
  const fingerprint = () => {
    const molecule = dropMolecule(snapshot());
    const editor = container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]')?.value;
    return {
      elements: molecule.atoms.map(atom => atom.element),
      labelLiterals: molecule.atoms.map(atom => atom.labelLiteral === true),
      charges: molecule.atoms.map(atom => atom.formalCharge),
      label: editor ?? molecule.atoms.find(atom => atom.labelLiteral === true)?.element,
      marks: marks().length,
      charge: charge(),
      tool: agent().activeToolCommandId as string
    };
  };
  /**
   * The hover/chemistry part of the fingerprint, without the active tool. After the hover path runs,
   * the window shortcut registry still resolves by event.key (so "," on KeyM or "." on KeyE can pick a
   * different tool than the letter would): that is unchanged RC2 behavior, not what these tests guard.
   */
  const chemistry = () => { const { tool: _tool, ...rest } = fingerprint(); return rest; };
  const totalAtoms = () => snapshot().pages[0].objects.reduce((sum, object) =>
    sum + (object.type === "molecule" ? (object as ReturnType<typeof dropMolecule>).atoms.length : 0), 0);

  it.each([
    { name: "+ (Shift+=)", init: PLUS, value: 1, sign: "positive" },
    { name: "numpad +", init: NUMPAD_PLUS, value: 1, sign: "positive" },
    { name: "+ on a layout with an unshifted + key", init: UNSHIFTED_PLUS, value: 1, sign: "positive" },
    { name: "Shift+= injected as \"=\" with code NumpadEqual", init: NUMPAD_EQUAL_SHIFTED, value: 1, sign: "positive" },
    { name: "a typed + with placeholder code KeyA", init: TYPED_PLUS, value: 1, sign: "positive" },
    { name: "-", init: MINUS, value: -1, sign: "negative" },
    { name: "numpad -", init: NUMPAD_MINUS, value: -1, sign: "negative" }
  ])("hovering an atom of a selected ring and pressing $name charges that atom", async ({ init, value, sign }) => {
    const moleculeId = await benzene();
    await hoverAtom(moleculeId);
    await press(init);
    expect(marks()).toHaveLength(1);
    expect(charge()).toBe(value);
    expect(status()).toBe(`Placed ${sign} charge on hovered atom`);
    expect(agent().activeToolCommandId).toBe("tool.select");
    // Same selection result for + and -: the ring plus its new mark.
    expect([...snapshot().selection.objectIds].sort()).toEqual([moleculeId, marks()[0]!.id].sort());
  });

  it.runIf(scheme === "chemdraft").each([
    { name: "+ (Shift+=)", init: PLUS, tool: "tool.plus" },
    { name: "Shift+= reported as \"=\"", init: SHIFTED_EQUAL, tool: "tool.plus" },
    { name: "Shift+= injected with code NumpadEqual", init: NUMPAD_EQUAL_SHIFTED, tool: "tool.plus" },
    { name: "numpad +", init: NUMPAD_PLUS, tool: "tool.plus" },
    { name: "-", init: MINUS, tool: "tool.minus" }
  ])("with nothing hovered, $name picks $tool", async ({ init, tool }) => {
    await benzene(false);
    await move({ x: 700, y: 550 });
    expect(agent().hoveredNativeTarget).toBeUndefined();
    await press(init);
    expect(agent().activeToolCommandId).toBe(tool);
    expect(marks()).toHaveLength(0);
  });

  it.each([
    { name: "Shift+= reported as \"=\"", init: SHIFTED_EQUAL, selected: true },
    { name: "Shift+= reported as \"=\"", init: SHIFTED_EQUAL, selected: false },
    { name: "a literal + (control)", init: PLUS, selected: true },
    { name: "a literal + (control)", init: PLUS, selected: false }
  ])("$name over an atom of a ring (selected: $selected) charges that atom once", async ({ init, selected }) => {
    const moleculeId = await benzene(selected);
    await hoverAtom(moleculeId);
    await press(init, async () => {
      expect(agent().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: "atom_001" });
    });
    expect(marks()).toHaveLength(1);
    expect(charge()).toBe(1);
    expect(status()).toBe("Placed positive charge on hovered atom");
    expect(agent().activeToolCommandId).toBe("tool.select");
  });

  it("a bare = with nothing hovered keeps its existing meaning", async () => {
    await benzene(false);
    await move({ x: 700, y: 550 });
    expect(agent().hoveredNativeTarget).toBeUndefined();
    await press(BARE_EQUAL);
    expect(marks()).toHaveLength(0);
    expect(agent().activeToolCommandId).toBe(scheme === "chemdraft" ? "tool.plus" : "tool.select");
  });

  it.each([
    { name: "= on Equal", init: BARE_EQUAL },
    { name: "= on NumpadEqual", init: NUMPAD_EQUAL }
  ])("an unshifted $name over an atom is not the hover + key", async ({ init }) => {
    const moleculeId = await benzene();
    await hoverAtom(moleculeId);
    await press(init);
    expect(marks()).toHaveLength(0);
    expect(charge()).toBe(0);
  });

  it.each([
    { name: "Dvorak , on KeyW (nitrogen, as w)", init: DVORAK_COMMA },
    { name: "Dvorak ; on KeyZ (alkyne sprout, as z)", init: DVORAK_SEMICOLON },
    { name: "AZERTY , on KeyM (Me, as m)", init: AZERTY_COMMA }
  ])("$name over an atom acts exactly as its physical letter and never as typed punctuation", async ({ init }) => {
    const letter = { key: init.code.slice(3).toLowerCase(), code: init.code };
    const moleculeId = await benzene();
    await hoverAtom(moleculeId);
    await press(init);
    const viaPunctuation = chemistry();
    await act(async () => root.unmount());
    root = createRoot(container);
    await hoverAtom(await benzene());
    await press(letter);
    expect(viaPunctuation).toEqual(chemistry());
    // Typed "," ";" are never charge or radical keys.
    expect(viaPunctuation.marks).toBe(0);
    expect(viaPunctuation.charge).toBe(0);
  });

  it("AZERTY ; on Comma (not a letter code) is not a hover key and changes nothing", async () => {
    const moleculeId = await benzene();
    await hoverAtom(moleculeId);
    const before = fingerprint();
    await press(AZERTY_SEMICOLON);
    expect(fingerprint()).toEqual(before);
  });

  it("a dead key on KeyE keeps its base behavior (read by physical letter) and never charges", async () => {
    // key "Dead" is longer than one character, so the physical-letter mapping applies as before;
    // whatever "e" does in the scheme, it is not a charge.
    const moleculeId = await benzene();
    await hoverAtom(moleculeId);
    await press(DEAD_KEY);
    expect(marks()).toHaveLength(0);
    expect(charge()).toBe(0);
  });

  it("Dvorak . on KeyE acts exactly as the letter e (Et substituent in classic), not as the radical key", async () => {
    const moleculeId = await benzene();
    await hoverAtom(moleculeId);
    await press(LETTER_E);
    const viaLetter = chemistry();
    await act(async () => root.unmount());
    root = createRoot(container);
    await hoverAtom(await benzene());
    await press(DVORAK_PERIOD);
    const viaDvorak = chemistry();
    expect(viaDvorak).toEqual(viaLetter);
    // No radical was added and the ring atom was not charged by the typed ".".
    expect(viaDvorak.marks).toBe(0);
    expect(viaDvorak.charge).toBe(0);
    if (scheme === "chemdraw") {
      // The classic scheme's e attaches an Et nickname atom to the hovered ring carbon.
      expect(viaDvorak.elements).toEqual(["C", "C", "C", "C", "C", "C", "Et"]);
    } else {
      // The ChemDraft scheme's e has no hover action over an atom: the ring is untouched.
      expect(viaDvorak.elements).toEqual(["C", "C", "C", "C", "C", "C"]);
    }
  });

  it.runIf(scheme === "chemdraw").each([
    { name: "a (key a, code KeyA)", init: LETTER_A },
    { name: "a typed . with placeholder code KeyA (mapped to a, as in RC2)", init: { key: ".", code: "KeyA" } },
    { name: "a typed 3 with placeholder code KeyA (mapped to a, as in RC2)", init: { key: "3", code: "KeyA" } },
    { name: "Greek α on KeyA", init: GREEK_ALPHA },
    { name: "Cyrillic ф on KeyA", init: CYRILLIC_EF }
  ])("in the classic scheme $name over an atom still attaches a benzene ring", async ({ init }) => {
    const moleculeId = await benzene();
    await hoverAtom(moleculeId);
    const atomsBefore = totalAtoms();
    await press(init);
    expect(totalAtoms()).toBeGreaterThan(atomsBefore);
    expect(marks()).toHaveLength(0);
    expect(charge()).toBe(0);
  });

  it.runIf(scheme === "chemdraw")("in the classic scheme + on KeyA charges and never attaches benzene, unlike a", async () => {
    const moleculeId = await benzene();
    await hoverAtom(moleculeId);
    const atomsBefore = totalAtoms();
    await press(TYPED_PLUS);
    expect(totalAtoms()).toBe(atomsBefore);
    expect(charge()).toBe(1);
    expect(marks()).toHaveLength(1);
  });

  it.runIf(scheme === "chemdraft").each([
    { name: "Greek α on KeyA", init: GREEK_ALPHA },
    { name: "Cyrillic ф on KeyA", init: CYRILLIC_EF }
  ])("in the ChemDraft scheme $name over an atom charges nothing", async ({ init }) => {
    const moleculeId = await benzene();
    await hoverAtom(moleculeId);
    await press(init);
    expect(marks()).toHaveLength(0);
    expect(charge()).toBe(0);
  });

  it("a typed + with placeholder code KeyA charges the atom and attaches no ring in either scheme", async () => {
    const moleculeId = await benzene();
    await hoverAtom(moleculeId);
    const atomsBefore = dropMolecule(snapshot()).atoms.length;
    const moleculesBefore = snapshot().pages[0].objects.filter(object => object.type === "molecule").length;
    await press(TYPED_PLUS);
    expect(charge()).toBe(1);
    expect(marks()).toHaveLength(1);
    expect(dropMolecule(snapshot()).atoms).toHaveLength(atomsBefore);
    expect(snapshot().pages[0].objects.filter(object => object.type === "molecule")).toHaveLength(moleculesBefore);
    expect(agent().activeToolCommandId).toBe("tool.select");
  });

  it.each([
    { name: "Cmd+=", init: { key: "=", code: "Equal", metaKey: true }, mod: "macos" },
    { name: "Ctrl+=", init: { key: "=", code: "Equal", ctrlKey: true }, mod: "windows" }
  ])("$name charges nothing, and zooms only where bound", async ({ init, mod }) => {
    if (mod !== platform) return;
    const moleculeId = await benzene();
    await hoverAtom(moleculeId);
    const zoomBefore = (agent().viewport as { scale: number }).scale;
    await press(init);
    expect(marks()).toHaveLength(0);
    expect(charge()).toBe(0);
    expect(agent().activeToolCommandId).toBe("tool.select");
    const zoomAfter = (agent().viewport as { scale: number }).scale;
    // Classic scheme: zoom in is Shift+Cmd+> (keybindingScheme.ts "view.zoomIn"), so Cmd/Ctrl+= is
    // unbound there and leaves the zoom alone. ChemDraft binds Cmd/Ctrl+= to zoom in.
    if (scheme === "chemdraft") expect(zoomAfter).toBeGreaterThan(zoomBefore);
    else expect(zoomAfter).toBe(zoomBefore);
  });
});
