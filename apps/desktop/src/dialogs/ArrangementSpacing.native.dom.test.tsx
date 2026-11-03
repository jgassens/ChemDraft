import { defaultArrangementDraft } from "@chemdraft/layout-engine";
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dialogEnvelope, type DialogMessage, type DialogSnapshot } from "./dialogProtocol";
import { ArrangementSpacingForm } from "./ArrangementSpacingForm";
const host = vi.hoisted(() => ({ receive: undefined as ((message: DialogMessage) => void) | undefined, send: vi.fn() }));
vi.mock("./dialogTransport", () => ({ subscribeDialogHost: async (_id: string, callback: typeof host.receive) => { host.receive = callback; return () => {}; }, sendDialogMessage: host.send }));
import { DialogWindow } from "./DialogWindow";
const snapshot: DialogSnapshot = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "arrangementSpacing", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data: { title: "Drawing B", minPercent: 40, maxPercent: 150 } };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); vi.clearAllMocks(); host.send.mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount(value: DialogSnapshot = snapshot) {
  await act(async () => root.render(createElement(DialogWindow, { hostId: "opaque" })));
  await act(async () => host.receive!(value));
  await act(async () => vi.advanceTimersByTimeAsync(1));
}
function latestPreview(): DialogMessage { return host.send.mock.calls.map(call => call[1] as DialogMessage).filter(m => m.type === "action" && m.data.action === "preview").at(-1)!; }
async function image(request: DialogMessage, index = 0, count = 1, chunk = "PHN2Zy8+") {
  await act(async () => host.receive!({ ...dialogEnvelope(snapshot), requestId: request.requestId, type: "preview", data: { percent: request.type === "action" && "percent" in request.data ? request.data.percent : 100, index, count, chunk } }));
}
it("assembles only complete current previews and saves the chosen percent once", async () => {
  await mount(); const initial = latestPreview();
  expect(host.send.mock.calls.map(call => call[1] as DialogMessage).filter(message => message.type === "ready")).toHaveLength(1);
  expect(container.textContent).toContain("Drawing B"); expect(document.activeElement).toBe(container.querySelector('input'));
  const save = () => container.querySelectorAll<HTMLButtonElement>('button')[1]!;
  expect(save().disabled).toBe(true);
  await image(initial, 0, 2, "PHN2"); expect(save().disabled).toBe(true);
  await image(initial, 1, 2, "Zy8+"); expect(save().disabled).toBe(false);
  const slider = container.querySelector('input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '80'); slider.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(save().disabled).toBe(true);
  await image(initial); expect(save().disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(121));
  const current = latestPreview(); expect(current.data).toEqual({ action: 'preview', percent: 80 });
  await image(current); expect(save().disabled).toBe(false);
  await act(async () => { save().click(); save().click(); });
  const applies = host.send.mock.calls.map(call=>call[1] as DialogMessage).filter(m=>m.type==='action' && m.data.action==='apply');
  expect(applies).toHaveLength(1); expect(applies[0].data).toEqual({ action: 'apply', percent: 80 });
  await act(async () => host.receive!({ ...dialogEnvelope(applies[0]), type: "result", data: { status: "accepted" } }));
  await act(async () => vi.advanceTimersByTimeAsync(10001));
  expect(save().disabled).toBe(true);
  expect(container.textContent).not.toContain("did not acknowledge");
});
it("rejects incomplete delivery and reports a missing preview without enabling Save", async () => {
  await mount(); const request = latestPreview();
  await image(request, 1, 2); expect(container.textContent).toContain('delivery was incomplete');
  expect(container.querySelectorAll<HTMLButtonElement>('button')[1]!.disabled).toBe(true);
});
it.each(['macos', 'windows'] as const)("supports %s close and reload keys in the shared form", async platform => {
  const cancel = vi.fn(), save = vi.fn();
  await act(async()=>root.render(createElement(ArrangementSpacingForm,{...snapshot.data,percent:100,preview:'data:image/svg+xml;base64,PHN2Zy8+',onChange:vi.fn(),onCancel:cancel,onSave:save,platform})));
  const field = container.querySelector('input')!;
  const modifier = platform==='macos'?{metaKey:true}:{ctrlKey:true};
  for (const key of ['F5','r']) { const event=new KeyboardEvent('keydown',{key,...modifier,bubbles:true,cancelable:true}); await act(async()=>field.dispatchEvent(event)); expect(event.defaultPrevented).toBe(true); }
  await act(async()=>field.dispatchEvent(new KeyboardEvent('keydown',{key:'w',...modifier,bubbles:true,cancelable:true})));
  expect(cancel).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
});

it("previews arrangement drafts, discards a stale image after changing arrows and saves only the current draft", async () => {
  await mount({ ...snapshot, data: { ...snapshot.data, arrangement: { ...defaultArrangementDraft } } } as DialogSnapshot);
  expect(container.textContent).toContain("Arrange selection");
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  expect(container.querySelector('input[type="range"]')).toBeNull();
  const initial = latestPreview(); await image(initial);
  const save = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(save().disabled).toBe(false);
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(save().disabled).toBe(true);
  await image(initial); expect(save().disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  const current = latestPreview();
  expect(current.data).toEqual({ action: "preview", percent: 100, arrangement: { ...defaultArrangementDraft, arrows: true } });
  await image(current); expect(save().disabled).toBe(false);
  const length=container.querySelector<HTMLInputElement>('input[type="range"]')!;
  expect(length).not.toBeNull();
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(length,'70');length.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(save().disabled).toBe(true);
  await act(async()=>vi.advanceTimersByTimeAsync(1));
  const shorter=latestPreview();expect(shorter.data).toEqual({action:'preview',percent:100,arrangement:{...defaultArrangementDraft,arrows:true,arrowLength:70}});
  await image(current);expect(save().disabled).toBe(true);
  await image(shorter);expect(save().disabled).toBe(false);
  await act(async () => { save().click(); save().click(); });
  const applies = host.send.mock.calls.map(call => call[1] as DialogMessage).filter(m => m.type === "action" && m.data.action === "apply");
  expect(applies).toHaveLength(1);
  expect(applies[0].data).toEqual({ action: "apply", percent: 100, arrangement: { ...defaultArrangementDraft, arrows: true,arrowLength:70 } });
});
