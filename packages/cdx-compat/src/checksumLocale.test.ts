import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@chemdraft/chem-core";
import {
  CdxmlEnvelopeCodecVersion,
  CdxmlEnvelopeCodecVersionV1,
  CdxmlEnvelopeCodecVersionV2,
  ChemDraftObjectTags,
  canonicalVisibleCdxml,
  exportDocumentToCdxml,
  openChemDraftPayload,
  visibleHashForCdxml
} from "./index";

const document = createEmptyDocument({ title: "Locale — Δ", now: "2026-10-29T00:00:00.000Z" });
const text = '<t id="t1" p="0 0"><s>Δ &amp; Café</s></t>';
// Literal pre-v3 projections exercise the historical orders independently of today's writer.
// Both represent identical XML and differ only in where the lowercase "id" sorts against "Width".
const englishVisible = `<CDXML CreationProgram="Checksum Test" id="root" Width="900"><page BoundingBox="0 0 612 792" id="page_001">${text}</page></CDXML>`;
const posixVisible = `<CDXML CreationProgram="Checksum Test" Width="900" id="root"><page BoundingBox="0 0 612 792" id="page_001">${text}</page></CDXML>`;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function withTag(contents: string, name: string, value: string): string {
  return contents.replace(new RegExp(`(<objecttag Name="${name}"[^>]*Value=")[^"]*`), `$1${value}`);
}

function envelope(version: string, visible: string): string {
  const tags = exportDocumentToCdxml(document).contents.match(/<objecttag\b[^>]*\/>/g)?.join("") ?? "";
  let contents = posixVisible.replace("</page>", `${tags}</page>`);
  contents = withTag(contents, ChemDraftObjectTags.codecVersion, version);
  return withTag(contents, ChemDraftObjectTags.visibleCdxmlHash, digest(visible));
}

describe("CDXML checksum locale migration", () => {
  it("opens the committed pre-v3 desktop drawing and preserves its chemistry on upgrade", () => {
    const contents = readFileSync(new URL("../../../scripts/test-resources/linux-desktop-v2.chemdraft", import.meta.url), "utf8");
    const opened = openChemDraftPayload(contents);
    expect(opened.source).toBe("native-payload");
    expect(opened.warnings).toEqual([]);
    const molecules = opened.document!.pages[0]!.objects.filter((object) => object.type === "molecule");
    expect(molecules.map((molecule) => ({
      structure: molecule.structure, atoms: molecule.atoms.length, bonds: molecule.bonds.length,
      charge: molecule.chemistry?.totalCharge
    }))).toEqual([
      { structure: "C1=CC=CC=C1", atoms: 6, bonds: 6, charge: 0 },
      { structure: "CC", atoms: 2, bonds: 1, charge: 0 }
    ]);
    const upgraded = exportDocumentToCdxml(opened.document!);
    expect(openChemDraftPayload(upgraded.contents).document).toEqual(opened.document);
    expect(openChemDraftPayload(contents.replace('Order="2"', 'Order="1"')).conflict?.kind)
      .toBe("visible-layer-modified");
  });

  it("defines an exact code-unit order, including unknown non-ASCII XML attributes", () => {
    const input = '<CDXML é="7" a="4" _="3" z="5" Z="2" Ä="6" A="1"/>';
    const expected = '<CDXML A="1" Z="2" _="3" a="4" z="5" Ä="6" é="7"/>';
    expect(canonicalVisibleCdxml(input)).toBe(expected);
    expect(visibleHashForCdxml(input)).toBe(digest(expected));
  });

  it("writes and reads v3 without consulting any locale collation", () => {
    const expected = exportDocumentToCdxml(document);
    const compare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("A v3 checksum must not consult localeCompare");
    });
    const collator = vi.spyOn(Intl, "Collator").mockImplementation(() => {
      throw new Error("A v3 checksum must not construct a collator");
    });
    try {
      const actual = exportDocumentToCdxml(document);
      expect(CdxmlEnvelopeCodecVersion).toBe("chemdraft.cdxml.v3");
      expect(actual.contents).toBe(expected.contents);
      expect(openChemDraftPayload(actual.contents)).toMatchObject({
        source: "native-payload", document, warnings: []
      });
    } finally {
      compare.mockRestore();
      collator.mockRestore();
    }
  });

  it.each([CdxmlEnvelopeCodecVersionV1, CdxmlEnvelopeCodecVersionV2])(
    "opens existing %s English and POSIX hashes as the same native document",
    (version) => {
      expect(digest(englishVisible)).not.toBe(digest(posixVisible));
      for (const visible of [englishVisible, posixVisible]) {
        const opened = openChemDraftPayload(envelope(version, visible));
        expect(opened.source).toBe("native-payload");
        expect(opened.warnings).toEqual([]);
        expect(opened.conflict).toBeUndefined();
        expect(opened.document).toEqual(document);
        // A save upgrades the checksum contract, without changing the native document.
        const saved = exportDocumentToCdxml(opened.document!);
        expect(saved.contents).toContain('Value="chemdraft.cdxml.v3"');
        expect(openChemDraftPayload(saved.contents).document).toEqual(document);
      }
    }
  );

  it.each([CdxmlEnvelopeCodecVersionV1, CdxmlEnvelopeCodecVersionV2])(
    "still detects visible changes and corrupted native JSON in legacy %s",
    (version) => {
      for (const visible of [englishVisible, posixVisible]) {
        const contents = envelope(version, visible);
        const edited = openChemDraftPayload(contents.replace('Width="900"', 'Width="901"'));
        expect(edited.document).toBeUndefined();
        expect(edited.conflict?.kind).toBe("visible-layer-modified");
        expect(edited.warnings[0]?.code).toBe("cdxml.visible_layer_modified");
        const corrupted = openChemDraftPayload(withTag(contents, ChemDraftObjectTags.nativePayloadHash, "0".repeat(64)));
        expect(corrupted.document).toBeUndefined();
        expect(corrupted.conflict).toBeUndefined();
        expect(corrupted.warnings[0]?.code).toBe("cdxml.native_payload_hash_mismatch");
      }
    }
  );

  it("requires the deterministic hash for v3 instead of accepting a legacy locale fallback", () => {
    expect(openChemDraftPayload(envelope(CdxmlEnvelopeCodecVersion, englishVisible)).conflict?.kind)
      .toBe("visible-layer-modified");
    expect(openChemDraftPayload(envelope(CdxmlEnvelopeCodecVersion, posixVisible))).toMatchObject({
      source: "native-payload", document, warnings: []
    });
  });

  it("exports one checksum and opens both legacy variants under different process locales", () => {
    const moduleUrl = pathToFileURL(resolve("packages/cdx-compat/src/index.ts")).href;
    const coreUrl = pathToFileURL(resolve("packages/chem-core/src/index.ts")).href;
    const script = `
      import { exportDocumentToCdxml, openChemDraftPayload, visibleHashForCdxml } from ${JSON.stringify(moduleUrl)};
      import { createEmptyDocument } from ${JSON.stringify(coreUrl)};
      import { readFileSync } from 'node:fs';
      const inputs = JSON.parse(readFileSync(0, 'utf8'));
      const doc = createEmptyDocument({ title: 'Locale — Δ', now: '2026-10-29T00:00:00.000Z' });
      const saved = exportDocumentToCdxml(doc);
      console.log(JSON.stringify({ hash: visibleHashForCdxml(saved.contents), reopened: openChemDraftPayload(saved.contents).source,
        legacy: inputs.map(contents => { const result = openChemDraftPayload(contents); return { source: result.source, warnings: result.warnings }; }) }));
    `;
    const inputs = [englishVisible, posixVisible].map((visible) => envelope(CdxmlEnvelopeCodecVersionV2, visible));
    const results = ["C.UTF-8", "en_US.UTF-8", "tr_TR.UTF-8"].map((locale) => {
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        encoding: "utf8", input: JSON.stringify(inputs),
        env: { ...process.env, LANG: locale, LC_ALL: locale }, timeout: 15_000
      });
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout);
    });
    expect(results.every((result) => result.hash === results[0].hash)).toBe(true);
    for (const result of results) {
      expect(result.reopened).toBe("native-payload");
      expect(result.legacy).toEqual([
        { source: "native-payload", warnings: [] },
        { source: "native-payload", warnings: [] }
      ]);
    }
  }, 30_000);
});
