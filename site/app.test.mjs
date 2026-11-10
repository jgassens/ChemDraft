import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const script = await readFile(new URL("./app.js", import.meta.url), "utf8");
const names = ["ChemDraft_1.2.0_aarch64.dmg", "ChemDraft_1.2.0_x86_64.dmg", "ChemDraft_1.2.0_x64-setup.exe"];

async function render(assetNames) {
  class Element {
    hidden = false;
    textContent = "";
  }
  class Anchor extends Element {
    href = "fallback";
    option = new Element();
    closest() { return this.option; }
  }
  const elements = {};
  for (const id of ["mac-apple", "mac-intel", "windows"]) {
    elements[`#download-${id}`] = new Anchor();
    elements[`#release-meta-${id}`] = new Element();
  }
  const assets = assetNames.map((name) => ({ name, browser_download_url: `https://example.test/${name}`, size: 1024 }));
  const release = { tag_name: "v1.2.0", published_at: "2026-11-10T00:00:00Z", assets };
  const done = new Promise((resolve) => {
    vm.runInNewContext(script, {
      document: { querySelector: (selector) => elements[selector] },
      HTMLAnchorElement: Anchor,
      HTMLElement: Element,
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(release) }),
    });
    setImmediate(resolve);
  });
  await done;
  return elements;
}

const decoys = ["ChemDraft_1.2.0_x64-setup.exe.sig", "ChemDraft_1.2.0_aarch64.app.tar.gz", "latest.json", "appcast.xml", "appcast-intel.xml", "ChemDraft_1.2.0_arm64-setup.exe"];

test("selects the three release installers and displays the version", async () => {
  const elements = await render([...decoys, names[1], names[2], names[0]]);
  for (const [index, id] of ["mac-apple", "mac-intel", "windows"].entries()) {
    assert.equal(elements[`#download-${id}`].href, `https://example.test/${names[index]}`);
    assert.match(elements[`#release-meta-${id}`].textContent, /v1\.2\.0/);
    assert.equal(elements[`#download-${id}`].option.hidden, false);
  }
});

test("a missing Intel installer hides only its download option", async () => {
  const elements = await render([names[0], names[2], ...decoys]);
  assert.equal(elements["#download-mac-intel"].option.hidden, true);
  assert.equal(elements["#download-mac-apple"].option.hidden, false);
  assert.equal(elements["#download-windows"].option.hidden, false);
});
