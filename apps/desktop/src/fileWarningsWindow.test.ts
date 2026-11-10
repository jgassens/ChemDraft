import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import type { OpenWarningsReport } from "./openWarnings";
import { createFileWarningsSession, fileWarningsAssembler, fileWarningsSnapshot, routeFileWarningsAction, type FileWarningsAction, type FileWarningsTransport } from "./fileWarningsProtocol";

function fixture() {
  const document = openChemDraftPayload(readFileSync("packages/fixtures/cdxml/invalid-element.cdxml", "utf8")).document!;
  const object = document.pages[0].objects[0]!;
  const reports: OpenWarningsReport[] = [
    { displayName: "a.cdxml", sourceLabel: "CDXML", warnings: [
      { code: "target", message: "Original converter message", sourceObjectId: object.id },
      { code: "whole", message: "Whole file warning" }
    ] },
    { operation: "save", displayName: "a.chemdraft", sourceLabel: "ChemDraft", warnings: [{ code: "save", message: "Saved with a warning", sourceObjectId: object.id }] }
  ];
  return { document, object, reports, snapshot: fileWarningsSnapshot("session-1", 3, reports, document) };
}

describe("native file warnings", () => {
  it("snapshots both original reports and resolved display targets without document authority", () => {
    const { snapshot } = fixture();
    expect(snapshot.reports.map(report => report.heading)).toEqual(["Opened a.cdxml as CDXML: 2 warnings", "Saved a.chemdraft: 1 warning"]);
    expect(snapshot.reports[0]!.rows[0]).toMatchObject({ message: "Original converter message", code: "target", canShow: true, missing: false });
    expect(snapshot.reports[0]!.rows[1]).toMatchObject({ target: "Whole file", canShow: false });
    expect(JSON.stringify(snapshot)).not.toContain('"objectId"');
    expect(JSON.stringify(snapshot)).not.toContain('"pages"');
  });

  it("routes Show from either report and revalidates against the current document", () => {
    const { snapshot, reports, document, object } = fixture();
    const show = vi.fn(), close = vi.fn();
    const action = { kind: "show" as const, sessionId: "session-1", revision: 3, reportIndex: 1, warningIndex: 0 };
    routeFileWarningsAction(action, snapshot, reports, document, show, close);
    expect(show).toHaveBeenCalledWith({ objectId: object.id, atomIds: [], bondIds: [] }, expect.any(String));
    show.mockClear();
    for (const invalid of [{ ...action, sessionId: "old" }, { ...action, revision: 2 }, { ...action, warningIndex: 99 },
      { ...action, reportIndex: 0, warningIndex: 1 }, { ...action, reportIndex: -1 }]) {
      routeFileWarningsAction(invalid, snapshot, reports, document, show, close);
    }
    routeFileWarningsAction(action, snapshot, reports, { ...document, pages: document.pages.map(page => ({ ...page, objects: [] })) }, show, close);
    expect(show).not.toHaveBeenCalled();
    routeFileWarningsAction({ kind: "close", sessionId: "session-1", revision: 2 }, snapshot, reports, document, show, close);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reassembles only complete ordered request snapshots, including Unicode and escaped text", () => {
    const { snapshot } = fixture();
    snapshot.reports[0]!.rows[0]!.message = '🧪 "quoted"\n\\'.repeat(2000);
    const receive = vi.fn(), assemble = fileWarningsAssembler(receive);
    const json = JSON.stringify(snapshot), parts = [json.slice(0, 200), json.slice(200)];
    const chunk = (index: number) => ({ sessionId: snapshot.sessionId, revision: 3, total: 2, index, json: parts[index]! });
    assemble(chunk(1));
    expect(receive).not.toHaveBeenCalled();
    assemble(chunk(0));
    assemble({ ...chunk(1), revision: 2 });
    expect(receive).not.toHaveBeenCalled();
    assemble(chunk(0)); assemble(chunk(1));
    expect(receive).toHaveBeenCalledExactlyOnceWith(snapshot);
  });

  it("routes atom and bond selections from an open-report row without sending their IDs to the host", () => {
    const { document, object, reports } = fixture();
    if (object.type !== "molecule") throw new Error("Expected the molecule fixture");
    const atomIds = [object.atoms[0]!.id], bondIds = [object.bonds[0]!.id];
    reports[0]!.warnings = [{ code: "parts", message: "Atom and bond warning", sourceObjectId: object.id, atomIds, bondIds }];
    const snapshot = fileWarningsSnapshot("session-1", 3, reports, document), show = vi.fn();
    routeFileWarningsAction({ kind: "show", sessionId: "session-1", revision: 3, reportIndex: 0, warningIndex: 0 }, snapshot, reports, document, show, vi.fn());
    expect(show).toHaveBeenCalledWith({ objectId: object.id, atomIds, bondIds }, expect.any(String));
    expect(snapshot.reports[0]!.rows[0]).not.toHaveProperty("atomIds");
  });

  it("serializes cold open and close, and ignores actions after disposal", async () => {
    const { snapshot } = fixture();
    const calls: string[] = [];
    let opened!: () => void, deliver!: (action: FileWarningsAction) => void;
    const transport: FileWarningsTransport = {
      open: async (_snapshot, _anchor, _focus, action) => { calls.push("open"); deliver = action; await new Promise<void>(resolve => { opened = resolve; }); },
      publish: async () => { calls.push("publish"); },
      close: async () => { calls.push("close"); }
    };
    const action = vi.fn(), error = vi.fn();
    const session = createFileWarningsSession(snapshot, { x: 20, y: 40 }, true, action, error, transport);
    await Promise.resolve();
    session.publish({ ...snapshot, revision: 4 });
    session.dispose();
    deliver({ kind: "close", sessionId: "session-1", revision: 3 });
    opened();
    await session.settled();
    expect(calls).toEqual(["open", "close"]);
    expect(action).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("publishes updates after open and reports native failures to the presentation owner", async () => {
    const { snapshot } = fixture();
    const transport = { open: vi.fn().mockResolvedValue(undefined), publish: vi.fn().mockRejectedValue(new Error("native failure")), close: vi.fn().mockResolvedValue(undefined) };
    const error = vi.fn();
    const session = createFileWarningsSession(snapshot, { x: 20, y: 40 }, false, vi.fn(), error, transport);
    session.publish({ ...snapshot, revision: 4 });
    await session.settled();
    expect(transport.publish).toHaveBeenCalledWith({ ...snapshot, revision: 4 });
    expect(error).toHaveBeenCalledWith(new Error("native failure"));
    session.dispose(); await session.settled();
  });

  it("finishes closing a slow disposed opening before reusing the window for a new one", async () => {
    const { snapshot } = fixture();
    const calls: string[] = [];
    let release!: () => void;
    const transport: FileWarningsTransport = {
      open: async value => {
        calls.push(`open:${value.sessionId}`);
        if (value.sessionId === "session-1") await new Promise<void>(resolve => { release = resolve; });
      },
      publish: async () => {},
      close: async id => { calls.push(`close:${id}`); }
    };
    const first = createFileWarningsSession(snapshot, { x: 0, y: 0 }, false, vi.fn(), vi.fn(), transport);
    await Promise.resolve();
    first.dispose();
    const second = createFileWarningsSession({ ...snapshot, sessionId: "session-2" }, { x: 0, y: 0 }, false, vi.fn(), vi.fn(), transport);
    release();
    await second.settled();
    expect(calls).toEqual(["open:session-1", "close:session-1", "open:session-2"]);
    second.dispose(); await second.settled();
  });
});

describe("warnings presentation source guards", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  it("keeps desktop warning presentation native and the toggle command-backed", () => {
    const main = source("./MainWindow.tsx");
    expect(main).toContain("useHtmlFileWarnings && openWarningsListShown && openWarnings");
    expect(main).toContain("aria-controls={useHtmlFileWarnings && openWarningsListShown");
    expect(main).toContain("invokeCommandRef.current(TOGGLE_OPEN_WARNINGS_COMMAND_ID)");
    expect(main).toContain("useNativeFileWarnings(openWarningsListShown, activeDocumentTabId");
    expect(source("./App.tsx")).toContain('get("window") === "fileWarnings"');
  });
  it("keeps the warnings host outside generic event/command/menu capabilities", () => {
    const host = JSON.parse(source("../src-tauri/capabilities/file-warnings-host.json"));
    expect(host.windows).toEqual(["file-warnings"]);
    expect(host.permissions).toEqual(["allow-file-warnings-request", "allow-file-warnings-ready", "allow-file-warnings-action"]);
    const native = source("../src-tauri/src/file_warnings_window.rs");
    expect(native).not.toContain("install_app_menu(");
    expect(native).not.toContain("addChildWindow_");
    expect(native).toContain("native.orderFront(None)");
    expect(native).toContain("super::raise_among_owned_windows(window)");
    expect(native).toContain("native.setLevel(window_level(NSFloatingWindowLevel))");
    expect(source("./App.tsx")).toContain('window.addEventListener("pointerdown", dismiss, true)');
  });
});
