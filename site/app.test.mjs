import test from "node:test";
import assert from "node:assert/strict";
import { findMacAsset } from "./app.js";

test("Mac assets match only their architecture", () => {
  const arm = { name: "ChemDraft_1.0_AARCH64.dmg" };
  const intel = { name: "ChemDraft_1.0_x86_64.dmg" };
  const other = { name: "ChemDraft_universal.dmg" };
  assert.equal(findMacAsset([intel, arm], "apple-silicon"), arm);
  assert.equal(findMacAsset([arm, intel], "intel"), intel);
  assert.equal(findMacAsset([arm], "intel"), undefined);
  assert.equal(findMacAsset([intel], "apple-silicon"), undefined);
  assert.equal(findMacAsset([other], "intel"), undefined);
  assert.equal(findMacAsset([other], "apple-silicon"), undefined);
  assert.ok(findMacAsset([{ name: "app_ARM64.DMG" }], "apple-silicon"));
  assert.ok(findMacAsset([{ name: "app_x64.dmg" }], "intel"));
  assert.ok(findMacAsset([{ name: "app_Intel.dmg" }], "intel"));
});

test("missing Mac downloads are hidden and Windows still selects x64", async () => {
  class Element { hidden = false; textContent = ""; }
  class Anchor extends Element { href = "fallback"; option = new Element(); closest() { return this.option; } }
  globalThis.HTMLElement = Element;
  globalThis.HTMLAnchorElement = Anchor;
  const elements = Object.fromEntries(["mac-apple", "mac-intel", "windows"].flatMap((name) => [
    [`#download-${name}`, new Anchor()], [`#release-meta-${name}`, new Element()],
  ]));
  globalThis.document = { querySelector: (selector) => elements[selector] };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ assets: [
    { name: "app_arm64.dmg", browser_download_url: "arm" },
    { name: "app-other-setup.exe", browser_download_url: "other" },
    { name: "app-x64-setup.exe", browser_download_url: "windows" },
  ] }) });
  try {
    await import("./app.js?integration");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(elements["#download-mac-apple"].href, "arm");
    assert.equal(elements["#download-mac-intel"].option.hidden, true);
    assert.equal(elements["#download-windows"].href, "windows");
  } finally {
    delete globalThis.document;
    delete globalThis.fetch;
    delete globalThis.HTMLElement;
    delete globalThis.HTMLAnchorElement;
  }
});
