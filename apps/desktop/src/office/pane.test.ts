// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { readChemDraftSelectionFromPng } from "@chemdraft/clipboard-adapter";
import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { Molecule } from "openchemlib";
import { describe, expect, it, vi } from "vitest";
import app from "../../package.json";
import {
  createPhase4Document, createSelectionClipboardPayload, insertNativeMolfileMolecule, insertNativeTextObject,
  parseSelectionClipboardPayload, serializeSelectionClipboardPayload,
} from "../documentWorkflow";
import { openOfficeDrawing, prepareOfficePicture } from "./drawing";
import { noStructure, type OfficeDocument, type OfficeHostAdapter, type SelectionResult } from "./host";
import { OfficePaneSession } from "./session";

vi.mock("../clipboard", async original => ({
  ...await original<typeof import("../clipboard")>(),
  rasterizeSvgInBrowser: async (svg: string) => new Resvg(svg).render().asPng(),
}));
vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

const source = insertNativeMolfileMolecule(createPhase4Document(), { x: 240, y: 240 },
  depictSmiles2D("[13CH3]/C=C/[C@@H]([NH3+])Cl").molfile, "molfile-v2000");
const json = serializeSelectionClipboardPayload(createSelectionClipboardPayload(source)!);

function chemistry(payload: string) {
  const molecule = parseSelectionClipboardPayload(payload)?.objects[0];
  if (molecule?.type !== "molecule") throw new Error("Expected a molecule in the carrier.");
  const structure = Molecule.fromMolfile(stereoPerceptionMolfile(molecule));
  return {
    smiles: structure.toIsomericSmiles(),
    formula: structure.getMolecularFormula().formula,
    charge: molecule.atoms.reduce((sum, atom) => sum + atom.formalCharge, 0),
    atoms: molecule.atoms.length,
    bonds: molecule.bonds.length,
  };
}

function paneSession() {
  const structure = { kind: "structure" as const, key: "original", json };
  const readSelectedStructure = vi.fn<OfficeHostAdapter["readSelectedStructure"]>().mockResolvedValue(structure);
  const replaceSelectedStructure = vi.fn<OfficeHostAdapter["replaceSelectedStructure"]>().mockResolvedValue({ kind: "replaced" });
  const session = new OfficePaneSession({ readSelectedStructure, replaceSelectedStructure });
  let listener: (() => void) | undefined;
  const officeDocument: OfficeDocument = {
    getFileAsync: vi.fn(),
    setSelectedDataAsync: vi.fn(),
    addHandlerAsync: (event, handle, done) => {
      expect(event).toBe("documentSelectionChanged");
      listener = handle;
      done({ status: "succeeded", value: undefined });
    },
    removeHandlerAsync: vi.fn((event, options, done) => {
      expect(event).toBe("documentSelectionChanged");
      expect(options.handler).toBe(listener);
      done({ status: "succeeded", value: undefined });
    }),
  };
  const cleanup = session.connect(officeDocument);
  return { session, cleanup, officeDocument, readSelectedStructure, replaceSelectedStructure, structure,
    select: (selection: SelectionResult) => {
      readSelectedStructure.mockResolvedValue(selection);
      listener?.();
    },
  };
}

describe("Office task-pane selection", () => {
  it("loads the current selection and prompts before replacing a dirty draft", async () => {
    const { session, cleanup, officeDocument, select, structure, replaceSelectedStructure } = paneSession();
    await vi.waitFor(() => expect(session.snapshot().document).toBeDefined());
    let drawing = session.snapshot().document!;
    const startingLoad = session.snapshot().loadId;
    const detach = session.attachEditor(startingLoad, () => drawing);
    await session.update();
    expect(replaceSelectedStructure).not.toHaveBeenCalled();

    drawing = insertNativeTextObject(drawing, { x: 100, y: 100 }, "Figure label");
    session.observeEditor();
    expect(session.snapshot().dirty).toBe(true);
    select({ ...structure, key: "other" });
    await vi.waitFor(() => expect(session.snapshot().confirmDiscard).toBe(true));
    expect(session.snapshot().loadId).toBe(startingLoad);
    session.keepEditing();
    expect(session.snapshot()).toMatchObject({ dirty: true, selected: false, confirmDiscard: false });
    await session.update();
    expect(replaceSelectedStructure).not.toHaveBeenCalled();

    select(structure);
    await vi.waitFor(() => expect(session.snapshot().selected).toBe(true));
    expect(session.snapshot().dirty).toBe(true);
    select({ ...structure, key: "other" });
    await vi.waitFor(() => expect(session.snapshot().confirmDiscard).toBe(true));
    await session.cancel();
    expect(session.snapshot()).toMatchObject({ dirty: false, selected: true, confirmDiscard: false, loadId: startingLoad + 1 });
    expect(session.snapshot().document?.pages[0]?.objects).toHaveLength(1);

    select(noStructure);
    await vi.waitFor(() => expect(session.snapshot().status).toBe("Select a ChemDraft structure"));
    detach();
    cleanup();
    await vi.waitFor(() => expect(officeDocument.removeHandlerAsync).toHaveBeenCalledOnce());
  });

  it("ignores an older selection read that completes after a newer selection", async () => {
    const { session, readSelectedStructure, structure } = paneSession();
    await vi.waitFor(() => expect(session.snapshot().selected).toBe(true));
    let finish!: (result: SelectionResult) => void;
    readSelectedStructure.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const older = session.refresh();
    readSelectedStructure.mockResolvedValue(noStructure);
    await session.refresh();
    finish({ ...structure, key: "slow" });
    await older;
    expect(session.snapshot()).toMatchObject({ document: undefined, status: "Select a ChemDraft structure", busy: false });
  });

  it("runs a style-only or annotation edit through the ordinary update payload", async () => {
    const { session, replaceSelectedStructure, readSelectedStructure, structure } = paneSession();
    await vi.waitFor(() => expect(session.snapshot().selected).toBe(true));
    let document = session.snapshot().document!;
    session.attachEditor(session.snapshot().loadId, () => document);
    document = insertNativeTextObject(document, { x: 100, y: 100 }, "Figure label");
    session.observeEditor();
    replaceSelectedStructure.mockImplementation(async (_png, replacement) => {
      readSelectedStructure.mockResolvedValue({ ...structure, json: replacement });
      return { kind: "replaced" };
    });
    await session.update();
    const [png, replacement] = replaceSelectedStructure.mock.calls[0]!;
    expect(parseSelectionClipboardPayload(replacement)?.objects.map(object => object.type)).toEqual(["molecule", "text"]);
    expect(await readChemDraftSelectionFromPng(png)).toMatchObject({ kind: "found", json: replacement });
    expect(chemistry(replacement)).toEqual(chemistry(json));
    expect(session.snapshot().status).toBe("Structure updated.");
  });

  it("shows the host's warning about shape state it could not carry over after Update", async () => {
    const { session, replaceSelectedStructure, readSelectedStructure, structure } = paneSession();
    await vi.waitFor(() => expect(session.snapshot().selected).toBe(true));
    let document = session.snapshot().document!;
    session.attachEditor(session.snapshot().loadId, () => document);
    document = insertNativeTextObject(document, { x: 100, y: 100 }, "Figure label");
    session.observeEditor();
    const warning = "Not carried over from the old picture: animations.";
    replaceSelectedStructure.mockImplementation(async (_png, replacement) => {
      readSelectedStructure.mockResolvedValue({ ...structure, json: replacement });
      return { kind: "replaced", warnings: [warning] };
    });
    await session.update();
    expect(session.snapshot().status).toBe("Structure updated. " + warning);
  });

  it("preserves canonical isomeric SMILES through an edit-free open and PNG update payload", async () => {
    const opened = openOfficeDrawing(json);
    const expected = chemistry(json);
    expect(expected.smiles).toContain("13C");
    expect(expected.smiles).toMatch(/[@/\\]/);
    expect(expected.charge).toBe(1);
    const picture = await prepareOfficePicture(opened.document);
    expect(picture.size.width).toBeGreaterThan(0);
    expect(chemistry(picture.json)).toEqual(expected);
    expect(await readChemDraftSelectionFromPng(picture.png)).toMatchObject({ kind: "found", json: picture.json });
  });

  it("does not write if the host selection changes while preparing the image", async () => {
    let finish!: (value: Awaited<ReturnType<typeof prepareOfficePicture>>) => void;
    const structure = { kind: "structure" as const, key: "original", json };
    const readSelectedStructure = vi.fn<OfficeHostAdapter["readSelectedStructure"]>().mockResolvedValue(structure);
    const replaceSelectedStructure = vi.fn<OfficeHostAdapter["replaceSelectedStructure"]>();
    const session = new OfficePaneSession({ readSelectedStructure, replaceSelectedStructure },
      () => new Promise(resolve => { finish = resolve; }));
    await session.refresh();
    let document = session.snapshot().document!;
    session.attachEditor(session.snapshot().loadId, () => document);
    document = insertNativeTextObject(document, { x: 80, y: 80 }, "Unsaved edit");
    const update = session.update();
    readSelectedStructure.mockResolvedValue(noStructure);
    await session.refresh();
    finish(await prepareOfficePicture(document));
    await update;
    expect(replaceSelectedStructure).not.toHaveBeenCalled();
    expect(session.snapshot()).toMatchObject({ confirmDiscard: true, selected: false });
  });
});

describe("Office manifest", () => {
  it("declares stable identity, hosts, permissions, commands and HTTPS resources", () => {
    const template = readFileSync("apps/desktop/office/manifest.xml", "utf8");
    const version = app.version + ".0";
    const manifest = new DOMParser().parseFromString(
      template.replaceAll("{{AppVersion}}", app.version).replaceAll("{{ManifestVersion}}", version),
      "application/xml",
    );
    expect(manifest.getElementsByTagNameNS("*", "parsererror")).toHaveLength(0);
    const root = manifest.documentElement;
    expect(root.getAttributeNS("http://www.w3.org/2001/XMLSchema-instance", "type")).toBe("TaskPaneApp");
    const named = (local: string) => [...root.getElementsByTagNameNS("*", local)];
    expect(named("Id")[0]?.textContent).toBe("c2b05f5c-0724-4438-bff6-229da8041c57");
    expect(named("Version")[0]?.textContent).toBe(version);
    expect(named("Host").slice(0, 2).map(node => node.getAttribute("Name"))).toEqual(["Document", "Presentation"]);
    expect(named("Permissions")[0]?.textContent).toBe("ReadWriteDocument");
    expect(named("OfficeTab").map(node => node.getAttribute("id"))).toEqual(["TabHome", "TabHome"]);
    expect(named("Control")).toHaveLength(2);
    expect(named("String").find(node => node.getAttribute("id") === "ChemDraft.Label")?.getAttribute("DefaultValue"))
      .toBe("Edit Structure");
    const url = "https://chemdraft.ai/office/" + app.version + "/taskpane";
    expect(named("SourceLocation")[0]?.getAttribute("DefaultValue")).toBe(url);
    expect(named("Url")[0]?.getAttribute("DefaultValue")).toBe(url);
    for (const resource of ["IconUrl", "HighResolutionIconUrl", "SupportUrl", "Url", "Image"]) {
      const values = named(resource).flatMap(node => node.getAttribute("DefaultValue") ?? []);
      for (const value of values) expect(new URL(value).protocol).toBe("https:");
    }
    const html = readFileSync("apps/desktop/office.html", "utf8");
    const pane = new DOMParser().parseFromString(html, "text/html");
    expect(pane.querySelector('meta[name="robots"]')?.getAttribute("content")).toContain("noindex");
    expect(pane.getElementById("office-js")?.getAttribute("src")).toBe("https://appsforoffice.microsoft.com/lib/1/hosted/office.js");
  });
});
