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

test("selects the three 1.2 release installers and displays the version", async () => {
  class Element { hidden = false; textContent = ""; }
  class Anchor extends Element { href = "fallback"; option = new Element(); closest() { return this.option; } }
  globalThis.HTMLElement = Element;
  globalThis.HTMLAnchorElement = Anchor;
  const ids = ["mac-apple", "mac-intel", "windows"];
  const elements = Object.fromEntries(ids.flatMap((id) => [
    [`#download-${id}`, new Anchor()], [`#release-meta-${id}`, new Element()],
  ]));
  const names = ["ChemDraft_1.2.2_aarch64.dmg", "ChemDraft_1.2.2_x86_64.dmg", "ChemDraft_1.2.2_x64-setup.exe"];
  const decoys = ["ChemDraft_1.2.2_x64-setup.exe.sig", "ChemDraft_1.2.2_aarch64.app.tar.gz", "latest.json", "appcast.xml", "appcast-intel.xml", "ChemDraft_1.2.2_arm64-setup.exe"];
  const assets = [...decoys, names[1], names[2], names[0]].map((name) => ({
    name, browser_download_url: `https://example.test/${name}`, size: 1024,
  }));
  globalThis.document = { querySelector: (selector) => elements[selector] };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    tag_name: "v1.2.2", published_at: "2026-11-23T00:00:00Z", assets,
  }) });
  try {
    await import("./app.js?release-1.2");
    await new Promise((resolve) => setImmediate(resolve));
    for (const [index, id] of ids.entries()) {
      assert.equal(elements[`#download-${id}`].href, `https://example.test/${names[index]}`);
      assert.equal(elements[`#download-${id}`].option.hidden, false);
      assert.match(elements[`#release-meta-${id}`].textContent, /v1\.2\.2/);
      assert.equal(elements[`#release-meta-${id}`].hidden, false);
    }
  } finally {
    delete globalThis.document;
    delete globalThis.fetch;
    delete globalThis.HTMLElement;
    delete globalThis.HTMLAnchorElement;
  }
});
