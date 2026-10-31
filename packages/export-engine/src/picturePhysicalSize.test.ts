import { createEmptyDocument, createImageGraphicObject, deserializeDocument, serializeDocument,
  type MoleculeObject } from "@chemdraft/chem-core";
import { applyDocumentStyle } from "@chemdraft/document-workflow-core";
import { DocumentStyleScale } from "@chemdraft/layout-engine";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { documentStyleSvg, exportDocumentToSvg } from "./svg";

// 288 × 144 transparent PNG with pHYs = 5669 pixels/m (144 dpi, quantized to integers).
const png = "iVBORw0KGgoAAAANSUhEUgAAASAAAACQCAYAAACoPrZBAAAACXBIWXMAABYlAAAWJQFJUiTwAAAAuElEQVR42u3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAFwOIrgABLLiMAwAAAABJRU5ErkJggg==";

function savedPictureDocument(bondLength = 44) {
  const document = createEmptyDocument();
  const molecule: MoleculeObject = { id: "m", type: "molecule", x: 100, y: 100,
    width: bondLength, height: 20, rotation: 0, structure: "CC", structureFormat: "smiles",
    style: {}, superatoms: [], rGroups: [],
    atoms: [{ id: "a", element: "C", x: 100, y: 110, formalCharge: 0 },
      { id: "b", element: "C", x: 100 + bondLength, y: 110, formalCharge: 0 }],
    bonds: [{ id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" }] };
  document.pages[0]!.objects = [molecule, createImageGraphicObject({ id: "picture", mimeType: "image/png",
    dataBase64: png, center: { x: 400, y: 300 } })];
  return deserializeDocument(serializeDocument(document));
}

function imageFrame(svg: string) {
  const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
  try {
    const image = dom.window.document.querySelector('[data-object-id="picture"] image')!;
    return Object.fromEntries(["x", "y", "width", "height"].map(key => [key, Number(image.getAttribute(key))]));
  } finally { dom.window.close(); }
}

describe("picture physical size on export", () => {
  it.each([22, 44])("retains physical dimensions through save and document styling with %s-unit bonds", bondLength => {
    const document = savedPictureDocument(bondLength);
    const picture = document.pages[0]!.objects[1]!;
    const styled = applyDocumentStyle(document);
    const styledPicture = styled.pages[0]!.objects[1]!;
    expect(styledPicture.width).toBe(picture.width);
    expect(styledPicture.height).toBe(picture.height);
    expect(styledPicture.x + styledPicture.width / 2).toBeCloseTo(400 * 22 / bondLength);
    expect(styledPicture.y + styledPicture.height / 2).toBeCloseTo(300 * 22 / bondLength);
    const ordinary = imageFrame(exportDocumentToSvg(document).contents);
    expect(ordinary.width * 72 / 96).toBeCloseTo(144, 1);
    expect(ordinary.height * 72 / 96).toBeCloseTo(72, 1);
    const page = styled.pages[0]!;
    const physical = imageFrame(documentStyleSvg(exportDocumentToSvg(styled).contents,
      { x: 0, y: 0, width: page.width, height: page.height }).svg);
    expect(physical.width * DocumentStyleScale.pointsPerUnit).toBeCloseTo(144, 1);
    expect(physical.height * DocumentStyleScale.pointsPerUnit).toBeCloseTo(72, 1);
    expect(physical.x + physical.width / 2).toBeCloseTo(styledPicture.x + styledPicture.width / 2);
    expect(physical.y + physical.height / 2).toBeCloseTo(styledPicture.y + styledPicture.height / 2);
  });

  it.each(["pixels", "inches", "millimetres"])("retains picture dimensions when SVG output is resized in %s", unit => {
    const document = savedPictureDocument();
    const options = unit === "pixels" ? { outputWidth: 1632, outputHeight: 2112 }
      : unit === "inches" ? { outputWidth: 17, outputHeight: 22, outputUnit: "in" as const }
      : { outputWidth: 431.8, outputHeight: 558.8, outputUnit: "mm" as const };
    const image = imageFrame(exportDocumentToSvg(document, options).contents);
    // Twice the original page size: a viewBox unit now represents 1.5 pt.
    expect(image.width * 1.5).toBeCloseTo(144, 1);
    expect(image.height * 1.5).toBeCloseTo(72, 1);
    expect(image.x + image.width / 2).toBeCloseTo(400);
    expect(image.y + image.height / 2).toBeCloseTo(300);
  });

  it.each(["transparent", "#ffffff"])("keeps a wide rotated picture inside the document-style crop with background %s", background => {
    const document = savedPictureDocument();
    const picture = document.pages[0]!.objects[1]!;
    picture.width = 600;
    picture.height = 10;
    picture.rotation = 30;
    const exported = exportDocumentToSvg(document, { background });
    const result = documentStyleSvg(exported.contents,
      { x: picture.x, y: picture.y, width: picture.width, height: picture.height });
    const cx = (picture.x + 300) * DocumentStyleScale.pointsPerUnit;
    const cy = (picture.y + 5) * DocumentStyleScale.pointsPerUnit;
    const halfWidth = (600 * Math.cos(Math.PI / 6) + 10 * Math.sin(Math.PI / 6)) * 0.75 / 2;
    const halfHeight = (600 * Math.sin(Math.PI / 6) + 10 * Math.cos(Math.PI / 6)) * 0.75 / 2;
    expect(result.viewBox.x).toBeLessThanOrEqual(cx - halfWidth - 4 + 1e-9);
    expect(result.viewBox.y).toBeLessThanOrEqual(cy - halfHeight - 4 + 1e-9);
    expect(result.viewBox.x + result.viewBox.width).toBeGreaterThanOrEqual(cx + halfWidth + 4 - 1e-9);
    expect(result.viewBox.y + result.viewBox.height).toBeGreaterThanOrEqual(cy + halfHeight + 4 - 1e-9);
    const dom = new JSDOM(result.svg, { contentType: "image/svg+xml" });
    try {
      const fill = dom.window.document.querySelector("svg > g > rect");
      if (background === "transparent") expect(fill).toBeNull();
      else for (const key of ["x", "y", "width", "height"] as const) {
        expect(Number(fill!.getAttribute(key)) * DocumentStyleScale.pointsPerUnit).toBeCloseTo(result.viewBox[key], 9);
      }
    } finally { dom.window.close(); }
  });

  it("exports the saved PNG at 144 × 72 pt through CLI render-document in default and document styles", () => {
    const directory = mkdtempSync(fileURLToPath(new URL("../.picture-export-test-", import.meta.url)));
    try {
      const input = join(directory, "saved.chemdraft");
      writeFileSync(input, serializeDocument(savedPictureDocument()));
      for (const style of [undefined, "document"]) {
        const output = join(directory, `${style ?? "default"}.svg`);
        const result = execFileSync(process.execPath, ["--import", "tsx", resolve("packages/chemdraft-cli/src/cli.ts"),
          "render-document", "--document", input, "--out", output, ...(style ? ["--style", style] : [])],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        expect(JSON.parse(result).ok).toBe(true);
        const image = imageFrame(readFileSync(output, "utf8"));
        const pointsPerUnit = style ? DocumentStyleScale.pointsPerUnit : 72 / 96;
        expect(image.width * pointsPerUnit).toBeCloseTo(144, 1);
        expect(image.height * pointsPerUnit).toBeCloseTo(72, 1);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 20_000);
});
