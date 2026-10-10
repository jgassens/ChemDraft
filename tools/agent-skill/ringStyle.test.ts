import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillRoot = join(root, "skills", "chemdraft");
const script = join(skillRoot, "scripts", "ring-style.mjs");
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ring-style");
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n?/g, "\n");

/** Real CLI output: `document` for cholesterol (PubChem CID 5997), paclitaxel (CID 36314), morphine
 * (CID 5288826), strychnine (CID 441071) and a phenyl-decalin. */
type Json = any; // the fixtures are untyped document JSON
interface Identity { canonicalSmiles: string; stereoCenters: number; unspecifiedStereoCenters: number }
interface RingStyle {
  CONVENTIONS: Record<string, Record<string, Json>>;
  style(doc: Json, buildMol: Json, options?: Json, tools?: { sources?: Json[]; verify?: (mol: Json) => string | null }): { carbon: Json; picture: Json; report: Json };
  model(mol: Json, buildMol?: Json): Json;
  stereoParities(m: Json): Map<string, number>;
  parseMolfile(text: string): Json;
  chemdraftCli(checkout: string): { identity(doc: Json): Identity[]; inchiKey(smiles: string): string; cleanup(): void };
  identityVerifier(identity: (doc: Json) => Identity[], doc: Json, molId: string, inchiKey?: (smiles: string) => string):
    { reference: Identity; verify(mol: Json): string | null };
  collisions(svg: string, nearPx?: number, incident?: ((label: Json, bondId: string) => boolean) | null): { kind: string; a: Json; b: { text: string }; gapPx: number }[];
  LIMITS: Record<string, number>;
  letterColour(fill: string, opacity?: number): string;
  readText(file: string): string;
}
let ringStyle: RingStyle;
interface ProcessResult { status: number | null; stdout: string; stderr: string }
/** Run process work outside Vitest's worker event loop. */
function runNode(args: string[], cwd?: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
const runScript = (...args: string[]) => runNode([script, ...args]);
/**
 * chemdraftCli deliberately uses spawnSync. Keep that contract in ring-style.mjs, but invoke it
 * only in this dedicated Node process so Vitest can continue servicing worker RPC updates.
 */
async function runRingStyleChild<T>(body: string, checkout: string): Promise<T> {
  const source = `
    import * as ringStyle from ${JSON.stringify(pathToFileURL(script).href)};
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    const fixtures = ${JSON.stringify(fixtures)};
    const read = (file) => readFileSync(file, "utf8").replace(/\\r\\n?/g, "\\n");
    const fixture = (name) => {
      const build = JSON.parse(read(join(fixtures, \`${"${name}"}-build.jsonl\`)).trim());
      return { build: build.molecules[0], doc: JSON.parse(read(join(fixtures, \`${"${name}"}.json\`))) };
    };
    const molecule = (doc) => doc.pages[0].objects.find((object) => object.type === "molecule");
    const cli = ringStyle.chemdraftCli(${JSON.stringify(checkout)});
    try {
      const result = await (async () => { ${body} })();
      process.stdout.write(JSON.stringify(result));
    } finally {
      cli.cleanup();
    }
  `;
  const result = await runNode(["--input-type=module", "--eval", source]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}
const fixture = (name: string) => {
  const build = JSON.parse(read(join(fixtures, `${name}-build.jsonl`)).trim());
  return { build: build.molecules[0], doc: JSON.parse(read(join(fixtures, `${name}.json`))) };
};
const molecule = (doc: Json) => doc.pages[0].objects.find((o: Json) => o.type === "molecule");
const letterObjects = (doc: Json) => doc.pages[0].objects.filter((o: Json) => o.type === "text" && /^ring-letter-/.test(o.id));
function inside(point: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** Atom positions of a ring in cycle order, from the build's ring record. */
function ringPolygon(mol: Json, ring: Json): { x: number; y: number }[] {
  const bonds = ring.bondIds.map((id: string) => mol.bonds.find((b: Json) => b.id === id));
  const order = [ring.atomIds[0]];
  while (order.length < ring.atomIds.length) {
    const last = order[order.length - 1];
    order.push(bonds.map((b: Json) => b.fromAtomId === last ? b.toAtomId : b.toAtomId === last ? b.fromAtomId : null)
      .find((id: string | null) => id && !order.includes(id)));
  }
  return order.map((id: string) => mol.atoms.find((a: Json) => a.id === id));
}
// The real CLI checks identity where a checkout is installed: this one (CI, a developer checkout),
// or the installed checkout CHEMDRAFT_CHECKOUT names (an agent worktree without per-package
// node_modules). Without either, the real-CLI tests skip, and say so.
const installed = (dir: string) => existsSync(join(dir, "node_modules", "tsx", "dist", "cli.mjs")) &&
  existsSync(join(dir, "packages", "chemdraft-cli", "node_modules"));
const cliCheckout = [root, process.env.CHEMDRAFT_CHECKOUT].find((dir): dir is string => !!dir && installed(dir));
const cliReady = !!cliCheckout;
if (!cliReady) {
  console.warn("ringStyle.test.ts: SKIPPING the real-CLI tests (render-document identity, rotate and fusion-H " +
    "regressions, the style command): this checkout has no packages/chemdraft-cli/node_modules. Install it, or set " +
    "CHEMDRAFT_CHECKOUT to an installed ChemDraft checkout.");
}

beforeAll(async () => {
  // A computed specifier: the script is plain JavaScript and has no type declarations.
  ringStyle = await import(pathToFileURL(script).href) as RingStyle;
});

describe("ring-style.mjs (Nicolaou-style rings for any molecule)", () => {
  it("is dependency-free Node: only node: built-ins, no shell", () => {
    const source = read(script);
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((name) => !name.startsWith("node:"))).toEqual([]);
    expect(source).not.toMatch(/\brequire\(|execSync|execFile|(?<!\.)\bexec\(|\bspawn\(|shell:\s*true/);
    // The one child process is the ChemDraft CLI, started with this Node and an argument list.
    const spawns = [...source.matchAll(/spawnSync\(([^,]+),/g)].map((m) => m[1]!.trim());
    expect(spawns).toEqual(["process.execPath"]);
  });

  it("is documented where the skill sends agents, with modes and conventions the script has", () => {
    const source = read(script);
    const modes = new Set([...source.matchAll(/command === "([a-z-]+)"/g)].map((m) => m[1]!));
    const docs = ["references/recipes.md", "references/art.md", "SKILL.md"].map((p) => read(join(skillRoot, p)));
    for (const doc of docs) expect(doc).toContain("scripts/ring-style.mjs");
    const used = docs.flatMap((doc) => [...doc.matchAll(/ring-style\.mjs"?\s+([a-z-]+)\s/g), ...doc.matchAll(/\$ringStyle\s+([a-z-]+)\s/g)].map((m) => m[1]!));
    expect(used.length).toBeGreaterThan(4);
    for (const mode of used) expect(modes, `undocumented mode ${mode}`).toContain(mode);
    const recipes = docs[0]!;
    for (const name of Object.keys(ringStyle.CONVENTIONS)) expect(recipes).toContain(`\`${name}\``);
    // The style belongs to no single molecule: the recipe's heading names none.
    expect(recipes).toMatch(/^## 11\. A structure in the Nicolaou style, for any molecule$/m);
  });

  it("letters a steroid by chemistry, colours touching rings apart and moves fusion stereo onto H", () => {
    const { build, doc } = fixture("cholesterol");
    const before = molecule(doc);
    const { carbon, picture, report } = ringStyle.style(structuredClone(doc), build, { convention: "steroid" });
    expect(report.letters.map((l: Json) => l.letter)).toEqual(["A", "B", "C", "D"]);
    const ring = (L: string) => report.letters.find((l: Json) => l.letter === L);
    expect(ring("D").ring).toMatch(/^5-ring \(carbocycle\)/);
    expect(ring("B").ring).toMatch(/1 ring double bond/);
    expect(ring("A").ring).toMatch(/0 ring double bond/);
    expect(new Set(report.letters.map((l: Json) => l.fill)).size).toBe(4);
    for (const l of report.letters) expect(l.letterColour).toBe(ringStyle.letterColour(l.fill, 0.9));

    // Three CH fusion stereocentres; each wedge or hash moved onto its new H with the opposite style.
    expect(report.fusionHydrogens).toHaveLength(3);
    const mol = molecule(carbon);
    for (const h of report.fusionHydrogens) {
      const bond = mol.bonds.find((b: Json) => b.toAtomId === h.h);
      expect(bond.fromAtomId).toBe(h.atom);
      const [movedStyle, movedId] = h.movedFrom.split(" ");
      expect(bond.display.bondStyle).toBe(movedStyle === "wedge" ? "hashed" : "wedge");
      expect(mol.bonds.find((b: Json) => b.id === movedId).display.bondStyle).toBeUndefined();
    }
    expect(mol.atoms).toHaveLength(before.atoms.length + 3);

    // Two ring methyls: carbons drawn CH3 in the editable copy, Me placeholders only in the picture.
    expect(report.methyls).toHaveLength(2);
    for (const { atom } of report.methyls) {
      expect(mol.atoms.find((a: Json) => a.id === atom).element).toBe("C");
      expect(mol.style.atomLabelShowTerminalCarbonsByAtomId[atom]).toBe(true);
      expect(molecule(picture).atoms.find((a: Json) => a.id === atom).element).toBe("Me");
    }

    // Each letter is italic serif and sits inside its own ring, in both copies.
    for (const copy of [carbon, picture]) {
      const letters = letterObjects(copy);
      expect(letters.map((t: Json) => t.text).sort()).toEqual(["A", "B", "C", "D"]);
      for (const t of letters) {
        const entry = ring(t.text);
        const atoms = build.rings.find((r: Json) => r.ringKey === entry.ringKey).atomIds
          .map((id: string) => molecule(copy).atoms.find((a: Json) => a.id === id));
        const centre = { x: t.x + t.width / 2, y: t.y + 0.64 * t.style.fontSizePx };
        // Ring atoms in cycle order: walk the ring's bonds.
        const bonds = build.rings.find((r: Json) => r.ringKey === entry.ringKey).bondIds
          .map((id: string) => molecule(copy).bonds.find((b: Json) => b.id === id));
        const order = [atoms[0].id];
        while (order.length < atoms.length) {
          const last = order[order.length - 1];
          const next = bonds.map((b: Json) => b.fromAtomId === last ? b.toAtomId : b.toAtomId === last ? b.fromAtomId : null)
            .find((id: string | null) => id && !order.includes(id));
          order.push(next);
        }
        const poly = order.map((id: string) => molecule(copy).atoms.find((a: Json) => a.id === id));
        expect(inside(centre, poly), `letter ${t.text} outside its ring`).toBe(true);
        expect(t.style).toMatchObject({ fontStyle: "italic", fontFamily: expect.stringMatching(/serif/) });
      }
    }
  });

  it("fails loudly when a convention does not fit, and walks when none is given", () => {
    const { build, doc } = fixture("cholesterol");
    expect(() => ringStyle.style(structuredClone(doc), build, { convention: "taxane" })).toThrow(/no ring matches/);
    expect(() => ringStyle.style(structuredClone(doc), build, { letters: { A: { size: 6 } } })).toThrow(/several rings match/);
    const walked = ringStyle.style(structuredClone(doc), build).report;
    expect(walked.letters).toHaveLength(4);
    expect(walked.notes.join(" ")).toMatch(/breadth-first walk/);
    // Terminal rings are the cyclohexanol and the cyclopentane; the larger ranks first, so the walk
    // runs A to D as the steroid convention does.
    expect(walked.letters[0].ring).toMatch(/^6-ring/);
    const steroid = ringStyle.style(structuredClone(doc), build, { convention: "steroid" }).report;
    expect(walked.letters.map((l: Json) => l.ringKey)).toEqual(steroid.letters.map((l: Json) => l.ringKey));
  });

  it("letters the same rings however the drawing is turned or mirrored on the page", () => {
    // The walk reads chemistry and topology only, never coordinates.
    for (const name of ["cholesterol", "strychnine", "paclitaxel", "morphine"]) {
      const { build, doc } = fixture(name);
      const lettersOf = (d: Json) => Object.fromEntries(ringStyle.style(d, build, { fusionH: false, declutter: false }).report.letters
        .map((l: Json) => [l.letter, l.ringKey]));
      const base = lettersOf(structuredClone(doc));
      expect(Object.keys(base).length, name).toBeGreaterThan(1);
      // Quarter and half turns, a mirror, and a mirror with a 53-degree turn.
      for (const [cos, sin, flip] of [[0, 1, 1], [-1, 0, 1], [1, 0, -1], [0.6, 0.8, -1]] as const) {
        const d = structuredClone(doc);
        for (const a of molecule(d).atoms) {
          const x = flip * a.x, y = a.y;
          a.x = 600 + cos * x - sin * y; a.y = 600 + sin * x + cos * y;
        }
        expect(lettersOf(d), `${name} turned (${cos}, ${sin}), mirror ${flip}`).toEqual(base);
      }
    }
  });

  it("letters paclitaxel by the taxane convention and keeps labels left on a fill legible", () => {
    const { build, doc } = fixture("paclitaxel");
    const { carbon, picture, report } = ringStyle.style(structuredClone(doc), build, { convention: "taxane" });
    const ring = (L: string) => report.letters.find((l: Json) => l.letter === L);
    expect(report.letters.map((l: Json) => l.letter)).toEqual(["A", "B", "C", "D"]);
    expect(ring("A").ring).toMatch(/^6-ring \(carbocycle\), 1 ring double bond/);
    expect(ring("B").ring).toMatch(/^8-ring \(carbocycle\)/);
    expect(ring("C").ring).toMatch(/^6-ring \(carbocycle\), 0 ring double bond/);
    expect(ring("D").ring).toMatch(/^4-ring \(O1\)/);
    // The three phenyls are pendant, not core: plain.
    expect(report.unlettered).toHaveLength(3);
    expect(report.unlettered.every((r: string) => /aromatic/.test(r))).toBe(true);
    // C15's gem-dimethyl cannot leave ring B's fill; its labels take B's letter colour, and no
    // box, halo or label background is added for them.
    expect(report.layout.stuck).toHaveLength(2);
    const fillB = ring("B").fill;
    for (const [copy, list] of [[carbon, report.labelsOnFills.carbon], [picture, report.labelsOnFills.picture]] as const) {
      const stuck = report.layout.stuck.map((x: Json) => x.group.split(" ")[0]);
      expect(list.map((l: Json) => l.atom).sort()).toEqual(stuck.sort());
      const style = molecule(copy).style;
      for (const l of list) {
        expect(l.on).toBe("B");
        expect(l.colour).toBe(ringStyle.letterColour(fillB, 0.9));
        expect(style.atomLabelColors[l.atom]).toBe(l.colour);
      }
      expect(style.atomLabelBackgroundColor).toBe("transparent");
      expect(style.atomLabelBackgroundColors).toBeUndefined();
      // Labels off the fills keep the default colour.
      expect(Object.keys(style.atomLabelColors)).toHaveLength(list.length);
    }
    expect(report.labelsOnFills.picture.map((l: Json) => l.label)).toEqual(["Me", "Me"]);
  });

  it("leaves pendant rings plain unless asked, and turns a substituent with rotate", () => {
    const { build, doc } = fixture("phenyldecalin");
    const core = ringStyle.style(structuredClone(doc), build).report;
    expect(core.letters).toHaveLength(2);
    expect(core.unlettered).toHaveLength(1);
    expect(core.unlettered[0]).toMatch(/aromatic/);
    const all = ringStyle.style(structuredClone(doc), build, { rings: "all" }).report;
    expect(all.letters).toHaveLength(3);

    const methyl = core.methyls[0].atom;
    const base = molecule(doc);
    const anchor = base.bonds.find((b: Json) => b.fromAtomId === methyl || b.toAtomId === methyl);
    const about = anchor.fromAtomId === methyl ? anchor.toAtomId : anchor.fromAtomId;
    const turned = ringStyle.style(structuredClone(doc), build, { rotate: [{ atom: methyl, about, degrees: 20 }], declutter: false });
    expect(turned.report.layout.moved.map((m: Json) => m.move)).toEqual(["turned 20 degrees (rotate option)"]);
    const at = (copy: Json, id: string) => molecule(copy).atoms.find((a: Json) => a.id === id);
    const pivot = at(doc, about), from = at(doc, methyl), to = at(turned.carbon, methyl);
    expect(Math.hypot(to.x - pivot.x, to.y - pivot.y)).toBeCloseTo(Math.hypot(from.x - pivot.x, from.y - pivot.y), 6);
    // Clockwise on the page (y down): (dx, dy) turns by +20 degrees.
    const t = 20 * Math.PI / 180, dx = from.x - pivot.x, dy = from.y - pivot.y;
    expect(to.x - pivot.x).toBeCloseTo(dx * Math.cos(t) - dy * Math.sin(t), 6);
    expect(to.y - pivot.y).toBeCloseTo(dx * Math.sin(t) + dy * Math.cos(t), 6);
    // Turned 90 degrees it lands on ring B's fill, and the fill rule turns it back out.
    const into = ringStyle.style(structuredClone(doc), build, { rotate: [{ atom: methyl, about, degrees: 90 }] });
    expect(into.report.layout.moved.map((m: Json) => m.group)).toContain(`${methyl} on ${about}`);
    expect(into.report.layout.faults.onFills).toEqual([]);
    const ringBond = base.bonds.find((b: Json) => b.fromAtomId === about && b.toAtomId !== methyl);
    expect(() => ringStyle.style(structuredClone(doc), build, { rotate: [{ atom: ringBond.toAtomId, about, degrees: 30 }] }))
      .toThrow(/only a substituent can be turned/);
  });

  it("finds nearly touching labels in a rendered SVG", () => {
    // Rendered by ChemDraft from cholesterol before its C19 methyl was turned (molfile attributes stripped).
    const found = ringStyle.collisions(read(join(fixtures, "cholesterol-unrotated-carbon.svg")));
    expect(found.map((c) => [c.kind, [c.a.text, c.b.text].sort().join("/")])).toEqual([["label-label", "CH3/H"]]);
  });

  it("chooses letter colours by luminance and reads UTF-16 and BOM files", () => {
    expect(ringStyle.letterColour("#e53935", 0.9)).toBe("#ffffff");
    expect(ringStyle.letterColour("#1e88e5", 0.9)).toBe("#ffffff");
    expect(ringStyle.letterColour("#fdd835", 0.9)).toBe("#1a1a1a");
    expect(ringStyle.letterColour("#00acc1", 0.9)).toBe("#1a1a1a");
    const dir = mkdtempSync(join(tmpdir(), "ring-style-text-"));
    try {
      writeFileSync(join(dir, "a.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"ok":true}', "utf16le")]));
      writeFileSync(join(dir, "b.txt"), '﻿{"ok":true}');
      expect(ringStyle.readText(join(dir, "a.txt"))).toBe('{"ok":true}');
      expect(ringStyle.readText(join(dir, "b.txt"))).toBe('{"ok":true}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("figure checks: a failing figure is flagged, not delivered as finished", () => {
    const at = (mol: Json, id: string) => mol.atoms.find((a: Json) => a.id === id);
    const failures = (report: Json) => report.quality.failures as string[];
    /** Move atom `id` along its bond from `from` to `ratio` times the bond's length. */
    const stretch = (mol: Json, from: string, id: string, ratio: number) => {
      const p = at(mol, from), q = at(mol, id);
      Object.assign(q, { x: p.x + (q.x - p.x) * ratio, y: p.y + (q.y - p.y) * ratio });
    };

    it("passes clean drawings: cholesterol and paclitaxel", () => {
      const chol = fixture("cholesterol"), pac = fixture("paclitaxel");
      expect(failures(ringStyle.style(structuredClone(chol.doc), chol.build, { convention: "steroid" }).report)).toEqual([]);
      expect(failures(ringStyle.style(structuredClone(pac.doc), pac.build, { convention: "taxane" }).report)).toEqual([]);
      expect(ringStyle.LIMITS).toMatchObject({ ringArea: 0.75, ringAngle: 0.6, bondStretch: 1.3, wedgeStretch: 1.3, letterPx: 14, hiddenRing: 0.4 });
    });

    it("fails a sliver ring", () => {
      // Cholesterol with C16 pulled into the middle of ring D.
      const { build, doc } = fixture("cholesterol");
      const d = structuredClone(doc), mol = molecule(d);
      const ringD = build.rings.find((r: Json) => r.atomIds.length === 5);
      const own = ringD.atomIds.filter((id: string) => build.rings.filter((r: Json) => r.atomIds.includes(id)).length === 1);
      const bonded = (u: string, v: string) => mol.bonds.some((b: Json) => [b.fromAtomId, b.toAtomId].sort().join() === [u, v].sort().join());
      const c16 = own.find((id: string) => own.filter((o: string) => o !== id && bonded(o, id)).length === 2);
      const ring = ringD.atomIds.map((id: string) => at(mol, id));
      Object.assign(at(mol, c16), { x: ring.reduce((s: number, a: Json) => s + a.x, 0) / 5, y: ring.reduce((s: number, a: Json) => s + a.y, 0) / 5 });
      const { report } = ringStyle.style(d, build, { convention: "steroid" });
      expect(failures(report).join("\n")).toMatch(/^ring D is a sliver: area 0\.\d+ of a regular 5-ring/m);
      expect(report.quality.measures.rings.find((r: Json) => r.letter === "D").areaRatio).toBeLessThan(0.75);
    });

    it("fails a stretched bond", () => {
      const { build, doc } = fixture("cholesterol");
      const d = structuredClone(doc), mol = molecule(d);
      // A side-chain methyl on a plain bond, away from the rings.
      const ringAtoms = new Set(build.rings.flatMap((r: Json) => r.atomIds));
      const bondsOf = (id: string) => mol.bonds.filter((b: Json) => b.fromAtomId === id || b.toAtomId === id);
      const bond = mol.bonds.find((b: Json) => !b.display?.bondStyle && [b.fromAtomId, b.toAtomId].some((id) => bondsOf(id).length === 1) &&
        ![b.fromAtomId, b.toAtomId].some((id) => ringAtoms.has(id)));
      const tip = bondsOf(bond.fromAtomId).length === 1 ? bond.fromAtomId : bond.toAtomId;
      stretch(mol, tip === bond.fromAtomId ? bond.toAtomId : bond.fromAtomId, tip, 1.6);
      const { report } = ringStyle.style(d, build, { convention: "steroid" });
      expect(failures(report)).toContainEqual(expect.stringMatching(new RegExp(`^bond ${bond.id} \\(.*\\) is stretched to 1\\.60x the median bond length`)));
    });

    it("fails an oversized wedge", () => {
      // C10's wedge sits on its own methyl bond (a20-a26); draw it 1.7 times as long.
      const { build, doc } = fixture("cholesterol");
      const d = structuredClone(doc), mol = molecule(d);
      const wedge = mol.bonds.find((b: Json) => b.fromAtomId === "a20" && b.toAtomId === "a26");
      expect(wedge.display.bondStyle).toMatch(/^(wedge|hashed)$/);
      stretch(mol, "a20", "a26", 1.7);
      const { report } = ringStyle.style(d, build, { convention: "steroid" });
      expect(failures(report)).toContainEqual(expect.stringMatching(new RegExp(`^(wedge|hash) ${wedge.id} \\(a20-a26\\) is drawn 1\\.70x the median`)));
    });

    it("fails a dropped fusion H, unless fusion H were not asked for", () => {
      const { build, doc } = fixture("cholesterol");
      const all = ringStyle.style(structuredClone(doc), build, { convention: "steroid" }).report.fusionHydrogens;
      const bad = all[0];
      const verify = (mol: Json) => mol.atoms.some((a: Json) => a.id === bad.h) ? "reads C, not CC" : null;
      const { report } = ringStyle.style(structuredClone(doc), build, { convention: "steroid" }, { verify });
      expect(failures(report)).toEqual([`fusion H dropped at ${bad.atom} (SMILES atom ${bad.smilesAtom}): render-document reads C, not CC; its stereo stays on a ring bond`]);
      const off = ringStyle.style(structuredClone(doc), build, { convention: "steroid", fusionH: false }).report;
      expect(failures(off)).toEqual([]);
    });

    it("flags strychnine's and morphine's real faults", () => {
      const s = fixture("strychnine");
      const strychnine = failures(ringStyle.style(structuredClone(s.doc), s.build).report);
      expect(strychnine).toContainEqual(expect.stringMatching(/^ring E is a sliver: area 0\.3\d/));
      expect(strychnine).toContainEqual(expect.stringMatching(/^bond b17 \(a17-a18\) is stretched to 2\.\d+x/));
      expect(strychnine).toContainEqual(expect.stringMatching(/^wedge b24 \(a18-a0\) is drawn 2\.\d+x the median/));
      expect(strychnine).toContainEqual(expect.stringMatching(/^ring E's letter is shrunk to 1[01] px/));
      expect(strychnine.filter((f) => /^fusion H dropped at a1[3457] .*no room for an H/.test(f))).toHaveLength(4);

      const m = fixture("morphine");
      const sdf = ringStyle.parseMolfile(read(join(fixtures, "morphine-pubchem.sdf")));
      const morphine = failures(ringStyle.style(structuredClone(m.doc), m.build, { convention: "morphinan" },
        { sources: [{ name: "PubChem 2D", yUp: true, ...sdf }] }).report);
      expect(morphine).toContainEqual(expect.stringMatching(/^ring D is a sliver/));
      expect(morphine).toContainEqual(expect.stringMatching(/^ring [BD]'s fill covers \d+% of ring [BD]/));
      expect(morphine.filter((f) => /^bond .* is stretched to 1\.[34]\dx/.test(f))).toHaveLength(2);
      expect(morphine).toContainEqual(expect.stringMatching(/^ring B's letter is shrunk to 1[0-3] px/));
      expect(morphine).toContainEqual(expect.stringMatching(/^fusion H dropped at /));
    });

    it("forces a layout by name, and names why one is not available", () => {
      const m = fixture("morphine");
      const sdf = ringStyle.parseMolfile(read(join(fixtures, "morphine-pubchem.sdf")));
      const sources = [{ name: "PubChem 2D", yUp: true, ...sdf }];
      // ChemDraft's own morphine layout draws ring D inside ring B: no room for its letter, which is a
      // figure failure, not a crash.
      const build = ringStyle.style(structuredClone(m.doc), m.build, { convention: "morphinan", layout: "build" }, { sources }).report;
      expect(build.layout.chosen).toBe("build");
      expect(build.layout.candidates.map((c: Json) => c.name)).toEqual(["build"]);
      expect(failures(build)).toContainEqual("ring D has no room for its letter, even at 10 px");
      const pubchem = ringStyle.style(structuredClone(m.doc), m.build, { convention: "morphinan", layout: "pubchem" }, { sources }).report;
      expect(pubchem.layout.chosen).toBe("PubChem 2D");
      expect(() => ringStyle.style(structuredClone(m.doc), m.build, { convention: "morphinan", layout: "pubchem" })).toThrow(/layout "pubchem" is not available: no PubChem 2D record/);
      expect(() => ringStyle.style(structuredClone(m.doc), m.build, { layout: "sideways" })).toThrow(/layout must be "search", "build", "canonical", "pubchem"/);
    });

    it("finds a bond running into a label: a hash tick on strychnine's N", () => {
      const svg = read(join(fixtures, "strychnine-pubchem-layout-nicolaou.svg"));
      const mol = molecule(JSON.parse(read(join(fixtures, "strychnine-pubchem-layout-nicolaou.json"))));
      const incident = (label: Json, bondId: string) => {
        const a = mol.atoms.find((x: Json) => Math.hypot(x.x - label.x, x.y - label.y) < 1);
        const b = mol.bonds.find((x: Json) => x.id === bondId);
        return !!a && !!b && (b.fromAtomId === a.id || b.toAtomId === a.id);
      };
      const found = ringStyle.collisions(svg, 1.5, incident).filter((c) => c.kind === "bond-label");
      expect(found.map((c) => `${c.a.text} ${c.b.text}`)).toEqual(["N bond b12"]);
      expect(mol.bonds.find((b: Json) => b.id === "b12").display.bondStyle).toBe("hashed");
      // Without knowing which bonds belong to which atom, bonds are not checked against labels.
      expect(ringStyle.collisions(svg).filter((c) => c.kind === "bond-label")).toEqual([]);
    });
  });

  describe("no substituent on a filled ring", () => {
    const steroid = { convention: "steroid" };
    const parities = (doc: Json, build: Json) => ringStyle.stereoParities(ringStyle.model(molecule(doc), build));
    const rings = (build: Json, ids: string[]) => build.rings.filter((r: Json) => r.atomIds.length === 6 && ids.every((id) => r.atomIds.includes(id)));

    it("turns a methyl drawn inside a filled ring back out, bond length and stereo kept", () => {
      // Cholesterol with its C19 methyl (a26 on C10, a20) drawn inside ring B; render-document still
      // reads it as cholesterol, since the wedge sits on the methyl's own bond.
      const { build } = fixture("cholesterol");
      const doc = JSON.parse(read(join(fixtures, "cholesterol-methyl-in-b.json")));
      const ringB = rings(build, ["a16", "a15", "a20"])[0];
      expect(inside(molecule(doc).atoms.find((a: Json) => a.id === "a26"), ringPolygon(molecule(doc), ringB))).toBe(true);

      const { carbon, report } = ringStyle.style(structuredClone(doc), build, steroid);
      expect(report.layout.moved.map((m: Json) => m.group)).toContain("a26 on a20");
      expect(report.layout.faults.onFills).toEqual([]);
      const out = molecule(carbon), me = out.atoms.find((a: Json) => a.id === "a26"), c10 = out.atoms.find((a: Json) => a.id === "a20");
      for (const ring of build.rings) expect(inside(me, ringPolygon(out, ring))).toBe(false);
      const was = molecule(doc).atoms.find((a: Json) => a.id === "a26");
      expect(Math.hypot(me.x - c10.x, me.y - c10.y)).toBeCloseTo(Math.hypot(was.x - c10.x, was.y - c10.y), 6);
      expect(parities(carbon, build).get("a20")).toBe(parities(doc, build).get("a20"));
    });

    it("undoes a move that would change the stereochemistry and reports the substituent as stuck", () => {
      // C19 drawn inside ring A with C10's hash on the fused C10-C5 bond: still cholesterol, but
      // every placement off the fills puts C19 across the C1...C9 line and inverts C10.
      const { build } = fixture("cholesterol");
      const doc = JSON.parse(read(join(fixtures, "cholesterol-methyl-in-a.json")));
      const { carbon, report } = ringStyle.style(structuredClone(doc), build, steroid);
      expect(report.layout.moved.filter((m: Json) => m.group === "a26 on a20")).toEqual([]);
      expect(report.layout.reverted.length).toBeGreaterThan(0);
      for (const r of report.layout.reverted) expect(r.reason).toMatch(/a20 now reads as the other stereoisomer/);
      expect(report.layout.stuck.map((x: Json) => x.group)).toEqual(["a26 on a20"]);
      const before = molecule(doc).atoms.find((a: Json) => a.id === "a26"), after = molecule(carbon).atoms.find((a: Json) => a.id === "a26");
      expect([after.x, after.y]).toEqual([before.x, before.y]);
      expect(parities(carbon, build).get("a20")).toBe(parities(doc, build).get("a20"));
    });

    it("undoes every move render-document disagrees with", () => {
      const { build } = fixture("cholesterol");
      const doc = JSON.parse(read(join(fixtures, "cholesterol-methyl-in-b.json")));
      const verify = () => "reads C, not CC"; // stands in for a render-document mismatch
      const { carbon, report } = ringStyle.style(structuredClone(doc), build, steroid, { verify });
      expect(report.layout.moved).toEqual([]);
      expect(report.layout.reverted.map((r: Json) => r.reason)).toContain("render-document reads C, not CC");
      const before = molecule(doc).atoms.find((a: Json) => a.id === "a26"), after = molecule(carbon).atoms.find((a: Json) => a.id === "a26");
      expect([after.x, after.y]).toEqual([before.x, before.y]);
      expect(report.layout.faults.onFills.join(" ")).toMatch(/a26 in B/);
    });

    it("undoes a rotate that would invert a stereocentre and reports it, not silently accepted", () => {
      // C19 inside ring A with C10's hash on the fused bond: turned 100 degrees it crosses the
      // C1...C9 line and C10 reads inverted (render-document agrees; see the real-CLI test).
      const { build } = fixture("cholesterol");
      const doc = JSON.parse(read(join(fixtures, "cholesterol-methyl-in-a.json")));
      const rotate = [{ atom: "a26", about: "a20", degrees: 100 }];
      const { carbon, report } = ringStyle.style(structuredClone(doc), build, { ...steroid, rotate });
      const turn = report.layout.reverted.find((r: Json) => r.move === "turned 100 degrees (rotate option)");
      expect(turn).toMatchObject({ group: "a26 on a20", reason: expect.stringMatching(/a20 now reads as the other stereoisomer/) });
      expect(report.layout.moved.filter((m: Json) => m.group === "a26 on a20")).toEqual([]);
      expect(parities(carbon, build).get("a20")).toBe(parities(doc, build).get("a20"));
    });

    it("undoes a rotate render-document rejects even when the drawing looks right locally", () => {
      const { build, doc } = fixture("cholesterol");
      const rotate = [{ atom: "a26", about: "a20", degrees: 20 }];
      const was = molecule(doc).atoms.find((a: Json) => a.id === "a26");
      // Stands in for render-document: any drawing with C19 moved reads as another molecule.
      const verify = (mol: Json) => { const a = mol.atoms.find((x: Json) => x.id === "a26"); return a.x !== was.x || a.y !== was.y ? "reads C, not CC" : null; };
      const { carbon, report } = ringStyle.style(structuredClone(doc), build, { ...steroid, rotate, fusionH: false }, { verify });
      expect(report.layout.reverted.map((r: Json) => `${r.move}: ${r.reason}`)).toContain("turned 20 degrees (rotate option): render-document reads C, not CC");
      expect(report.layout.moved.filter((m: Json) => m.group === "a26 on a20")).toEqual([]);
      const after = molecule(carbon).atoms.find((a: Json) => a.id === "a26");
      expect([after.x, after.y]).toEqual([was.x, was.y]);
    });

    it("re-verifies a partial set of moves one by one, keeping those render-document accepts", () => {
      // Two moves: the user's turn of the C18 methyl and the fill rule's move of C19 out of ring B.
      // render-document (stubbed) rejects the drawing only while C18 is turned.
      const { build } = fixture("cholesterol");
      const doc = JSON.parse(read(join(fixtures, "cholesterol-methyl-in-b.json")));
      const c18 = ringStyle.style(structuredClone(doc), build, steroid).report.methyls.map((m: Json) => m.atom).find((id: string) => id !== "a26");
      const anchor = molecule(doc).bonds.find((b: Json) => b.fromAtomId === c18 || b.toAtomId === c18);
      const about = anchor.fromAtomId === c18 ? anchor.toAtomId : anchor.fromAtomId;
      const was = molecule(doc).atoms.find((a: Json) => a.id === c18);
      const seen: string[] = [];
      const verify = (mol: Json) => {
        const a = mol.atoms.find((x: Json) => x.id === c18), b = mol.atoms.find((x: Json) => x.id === "a26");
        const orig = molecule(doc).atoms.find((x: Json) => x.id === "a26");
        seen.push(`${a.x !== was.x ? "C18 turned" : "C18 kept"}, ${b.x !== orig.x ? "C19 moved" : "C19 kept"}`);
        return a.x !== was.x || a.y !== was.y ? "counts 7 specified / 1 unspecified stereocentres, not 8 / 0" : null;
      };
      const { carbon, report } = ringStyle.style(structuredClone(doc), build,
        { ...steroid, fusionH: false, declutter: false, rotate: [{ atom: c18, about, degrees: 15 }] }, { verify });
      // All at once (rejected), then each move alone in order: the turn (rejected), then C19's move.
      expect(seen).toEqual(["C18 turned, C19 moved", "C18 turned, C19 kept", "C18 kept, C19 moved"]);
      expect(report.layout.reverted.map((r: Json) => r.move)).toEqual(["turned 15 degrees (rotate option)"]);
      expect(report.layout.reverted[0].reason).toMatch(/^render-document counts 7 specified/);
      expect(report.layout.moved.map((m: Json) => m.group)).toEqual(["a26 on a20"]);
      const out = molecule(carbon);
      expect(out.atoms.find((a: Json) => a.id === c18)).toMatchObject({ x: was.x, y: was.y });
      expect(report.layout.faults.onFills).toEqual([]);
    });

    it("takes back a fusion H render-document rejects, giving its ring bond the wedge again", () => {
      const { build, doc } = fixture("cholesterol");
      const all = ringStyle.style(structuredClone(doc), build, steroid).report.fusionHydrogens;
      expect(all).toHaveLength(3);
      const bad = all[1];
      const verify = (mol: Json) => mol.atoms.some((a: Json) => a.id === bad.h) ? "reads C, not CC" : null;
      const { carbon, report } = ringStyle.style(structuredClone(doc), build, steroid, { verify });
      expect(report.fusionHydrogens.map((h: Json) => h.atom)).toEqual(all.filter((h: Json) => h !== bad).map((h: Json) => h.atom));
      expect(report.fusionHydrogensUndone.map((h: Json) => h.atom)).toEqual([bad.atom]);
      expect(report.warnings.join(" ")).toMatch(new RegExp(`UNDONE: fusion H at ${bad.atom}: render-document reads C, not CC`));
      const mol = molecule(carbon);
      expect(mol.atoms.some((a: Json) => a.id === bad.h)).toBe(false);
      expect(mol.bonds.some((b: Json) => b.toAtomId === bad.h || b.fromAtomId === bad.h)).toBe(false);
      const [style, id] = bad.movedFrom.split(" ");
      expect(mol.bonds.find((b: Json) => b.id === id).display.bondStyle).toBe(style);
      expect(parities(carbon, build).get(bad.atom)).toBe(parities(doc, build).get(bad.atom));
    });

    it("chooses the layout with fewest crossings and fills crossed, with wedges re-drawn to keep stereo", () => {
      // Morphine: ChemDraft's own layout draws the piperidine inside another ring; PubChem's 2D
      // record has one unavoidable crossing. Wedges are re-chosen for the new coordinates.
      const { build, doc } = fixture("morphine");
      const sdf = ringStyle.parseMolfile(read(join(fixtures, "morphine-pubchem.sdf")));
      const { carbon, report } = ringStyle.style(structuredClone(doc), build, { convention: "morphinan", fusionH: false },
        { sources: [{ name: "PubChem 2D", yUp: true, ...sdf }] });
      expect(report.layout.chosen).toBe("PubChem 2D");
      const score = (name: string) => report.layout.candidates.find((c: Json) => c.name === name).score;
      expect(score("PubChem 2D")).toBeLessThan(score("build"));
      expect(report.layout.faults.crossings).toHaveLength(1);
      expect([...parities(carbon, build)]).toEqual([...parities(doc, build)]);
      const mol = molecule(carbon), L = mol.style.bondLengthPx;
      for (const b of mol.bonds.filter((x: Json) => x.display?.bondStyle === "wedge" || x.display?.bondStyle === "hashed")) {
        const p = mol.atoms.find((a: Json) => a.id === b.fromAtomId), q = mol.atoms.find((a: Json) => a.id === b.toAtomId);
        expect(Math.hypot(p.x - q.x, p.y - q.y) / L).toBeLessThan(1.25);
      }
      // A source that is another molecule is refused, not forced onto the document.
      const chol = fixture("cholesterol");
      const wrong = ringStyle.style(structuredClone(chol.doc), chol.build, { convention: "steroid" }, { sources: [{ name: "other", yUp: true, ...sdf }] });
      expect(wrong.report.layout.chosen).toBe("build");
      expect(wrong.report.layout.rejected.join(" ")).toMatch(/could not be matched/);
    });

    describe.skipIf(!cliReady)("with the real CLI", () => {
      it("render-document reads the moved drawing as the same molecule", async () => {
        const result = await runRingStyleChild<{ reference: Identity; moved: string[]; verified: string | null }>(`
          const { build } = fixture("cholesterol");
          const doc = JSON.parse(read(join(fixtures, "cholesterol-methyl-in-b.json")));
          const { reference, verify } = ringStyle.identityVerifier(cli.identity, doc, build.objectId);
          const { carbon, report } = ringStyle.style(structuredClone(doc), build, { convention: "steroid", fusionH: false }, { verify });
          return { reference, moved: report.layout.moved.map((move) => move.group), verified: verify(molecule(carbon)) };
        `, cliCheckout!);
        expect(result.reference).toMatchObject({ stereoCenters: 8, unspecifiedStereoCenters: 0 });
        expect(result.moved).toContain("a26 on a20");
        expect(result.verified).toBeNull();
      }, 120_000);

      it("render-document confirms the undone move would have inverted C10", async () => {
        const result = await runRingStyleChild<{ moved: string | null; stuck: string[] }>(`
          const { build, doc: plain } = fixture("cholesterol");
          const doc = JSON.parse(read(join(fixtures, "cholesterol-methyl-in-a.json")));
          const { verify } = ringStyle.identityVerifier(cli.identity, doc, build.objectId);
          const moved = structuredClone(molecule(doc));
          Object.assign(moved.atoms.find((atom) => atom.id === "a26"), (({ x, y }) => ({ x, y }))(molecule(plain).atoms.find((atom) => atom.id === "a26")));
          const { report } = ringStyle.style(structuredClone(doc), build, { convention: "steroid" }, { verify });
          return { moved: verify(moved), stuck: report.layout.stuck.map((entry) => entry.group) };
        `, cliCheckout!);
        expect(result.moved).toMatch(/^reads /);
        expect(result.stuck).toEqual(["a26 on a20"]);
      }, 120_000);

      it("a rotate that inverts C10 is undone, and render-document reads the result as cholesterol", async () => {
        const result = await runRingStyleChild<{ turned: string | null; reverted: string[]; fusionHydrogens: number; verified: string | null }>(`
          const { build } = fixture("cholesterol");
          const doc = JSON.parse(read(join(fixtures, "cholesterol-methyl-in-a.json")));
          const { verify } = ringStyle.identityVerifier(cli.identity, doc, build.objectId, cli.inchiKey);
          const turned = structuredClone(molecule(doc));
          const a = turned.atoms.find((atom) => atom.id === "a26"), c = turned.atoms.find((atom) => atom.id === "a20");
          const t = 100 * Math.PI / 180, dx = a.x - c.x, dy = a.y - c.y;
          Object.assign(a, { x: c.x + dx * Math.cos(t) - dy * Math.sin(t), y: c.y + dx * Math.sin(t) + dy * Math.cos(t) });
          const rotate = [{ atom: "a26", about: "a20", degrees: 100 }];
          const { carbon, report } = ringStyle.style(structuredClone(doc), build, { convention: "steroid", rotate }, { verify });
          return { turned: verify(turned), reverted: report.layout.reverted.map((entry) => entry.move), fusionHydrogens: report.fusionHydrogens.length, verified: verify(molecule(carbon)) };
        `, cliCheckout!);
        expect(result.turned).toMatch(/^reads /);
        expect(result.reverted).toContain("turned 100 degrees (rotate option)");
        expect(result.fusionHydrogens).toBe(3);
        expect(result.verified).toBeNull();
      }, 180_000);

      it("render-document reads the fusion H drawing as the same molecule (InChIKey for explicit H)", async () => {
        const result = await runRingStyleChild<{ fusionHydrogens: number; undone: Json[]; verified: string | null; withoutKey: string | null }>(`
          const { build, doc } = fixture("cholesterol");
          const { verify } = ringStyle.identityVerifier(cli.identity, doc, build.objectId, cli.inchiKey);
          const { carbon, report } = ringStyle.style(structuredClone(doc), build, { convention: "steroid" }, { verify });
          return {
            fusionHydrogens: report.fusionHydrogens.length,
            undone: report.fusionHydrogensUndone,
            verified: verify(molecule(carbon)),
            withoutKey: ringStyle.identityVerifier(cli.identity, doc, build.objectId).verify(molecule(carbon))
          };
        `, cliCheckout!);
        expect(result.fusionHydrogens).toBe(3);
        expect(result.undone).toEqual([]);
        expect(result.verified).toBeNull();
        expect(result.withoutKey).toMatch(/^reads .*\[H\]/);
      }, 180_000);
    });
  });

  describe("command line", () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "ring-style-cli-"));
      for (const file of ["phenyldecalin.json", "phenyldecalin-build.jsonl"]) copyFileSync(join(fixtures, file), join(dir, file));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const run = (...args: string[]) => runScript(...args);

    it("refuses to style without a checkout to verify moves with", async () => {
      const result = await run("style", dir, "phenyldecalin");
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/style needs --checkout/);
    }, 120_000);

    it.skipIf(!cliReady)("writes the carbon and picture documents from the build output", async () => {
      const result = await run("style", dir, "phenyldecalin", "--checkout", cliCheckout!);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^Layout: /m);
      for (const file of ["phenyldecalin-carbon.json", "phenyldecalin-nicolaou.json", "phenyldecalin-style.json"]) {
        expect(existsSync(join(dir, file)), file).toBe(true);
      }
      expect(result.stdout).toMatch(/^A {2}#e53935/m);
    }, 120_000);

    it("builds identity jobs that put the carbon back under each Me", async () => {
      const line = (document: string, smiles: string) => JSON.stringify({ name: "x", ok: true, document: join(dir, document), files: [],
        molecules: [{ canonicalSmiles: smiles, stereoCenters: 2, unspecifiedStereoCenters: 0, unspecifiedDoubleBonds: 0 }] });
      writeFileSync(join(dir, "phenyldecalin-render.jsonl"),
        `${line("phenyldecalin-carbon.json", "CC1CCCC1")}\n${line("phenyldecalin-nicolaou.json", "*C1CCCC1")}\n`);
      expect((await run("identity-jobs", dir, "phenyldecalin")).status).toBe(0);
      const jobs = JSON.parse(read(join(dir, "phenyldecalin-identity-jobs.json")));
      expect(jobs.map((j: Json) => j.smiles)).toEqual(["CC1CCCC1", "CC1CCCC1"]);
      expect(new Set(jobs.map((j: Json) => j.name)).size).toBe(2);
    }, 120_000);

    // Installed skills are symlinks (junctions on Windows, where symlinks need privileges).
    it.skipIf(process.platform === "win32")("runs when reached through a symlinked skill directory", async () => {
      const link = join(dir, "linked-skill");
      symlinkSync(skillRoot, link, "dir");
      const result = await runNode([join(link, "scripts", "ring-style.mjs"), "relayout", dir, "phenyldecalin"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Wrote phenyldecalin-job\.json/);
    }, 120_000);

    it("names the file and line of invalid JSON", async () => {
      writeFileSync(join(dir, "broken-build.jsonl"), '{"name":"broken","ok":true}\n{"name": broken}\n');
      const result = await run("relayout", dir, "broken");
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`${join(dir, "broken-build.jsonl")} line 2 is not valid JSON`);
    }, 120_000);

    it("gives the CLI's exit status and stderr when render-document fails", async () => {
      // A stand-in checkout whose CLI fails the way a broken install does.
      const fake = join(dir, "fake-checkout");
      mkdirSync(join(fake, "node_modules", "tsx", "dist"), { recursive: true });
      mkdirSync(join(fake, "packages", "chemdraft-cli", "src"), { recursive: true });
      writeFileSync(join(fake, "node_modules", "tsx", "dist", "cli.mjs"), 'process.stderr.write("Cannot find module zod\\n"); process.exit(3);\n');
      writeFileSync(join(fake, "packages", "chemdraft-cli", "src", "cli.ts"), "");
      const result = await runRingStyleChild<string>(`
        try {
          cli.identity(fixture("phenyldecalin").doc);
          return "";
        } catch (error) {
          return error.message;
        }
      `, fake);
      expect(result).toMatch(/render-document could not read a candidate drawing \(.*check-1\.json\): "no output" \(exit status 3; stderr: Cannot find module zod\)/);
    }, 120_000);

    it("prints its commands, options and figure-check limits with --help", async () => {
      const result = await run("--help");
      expect(result.status).toBe(0);
      for (const text of ["ring-style.mjs pubchem", "ring-style.mjs check", "Figure checks", "layout", "terminal ring"]) expect(result.stdout).toContain(text);
    }, 120_000);

    /** A finished run's files for `check`, written from the styled fixture: one carbon and one
     * picture render line, identity results that match PubChem, no SVGs. */
    const checkRun = (name: string, options: Json) => {
      const run = join(dir, `check-${name}`);
      mkdirSync(run, { recursive: true });
      const { build, doc } = fixture(name);
      copyFileSync(join(fixtures, `${name}-build.jsonl`), join(run, `${name}-build.jsonl`));
      const { carbon, picture, report } = ringStyle.style(structuredClone(doc), build, options);
      writeFileSync(join(run, `${name}-carbon.json`), JSON.stringify(carbon));
      writeFileSync(join(run, `${name}-nicolaou.json`), JSON.stringify(picture));
      writeFileSync(join(run, `${name}-style.json`), JSON.stringify(report));
      writeFileSync(join(run, `${name}-pubchem.json`), JSON.stringify({ CID: 1, Title: name, InChIKey: "KEY", DefinedAtomStereoCount: 2, UndefinedAtomStereoCount: 0 }));
      const line = (file: string) => JSON.stringify({ name, ok: true, document: join(run, file), files: [],
        molecules: [{ canonicalSmiles: "C", stereoCenters: 2, unspecifiedStereoCenters: 0, unspecifiedDoubleBonds: 0 }] });
      writeFileSync(join(run, `${name}-render.jsonl`), `${line(`${name}-carbon.json`)}\n${line(`${name}-nicolaou.json`)}\n`);
      const key = (job: string) => JSON.stringify({ name: job, ok: true, summary: { inchiKey: { value: "KEY" }, formula: { value: "C" } } });
      writeFileSync(join(run, `${name}-identity.jsonl`), `${key(`1-${name}`)}\n${key(`2-${name}`)}\n`);
      return run;
    };

    it("check passes a clean figure and says when no labels touch", async () => {
      const result = await run("check", checkRun("cholesterol", { convention: "steroid" }), "cholesterol");
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^No near-touching labels/m);
      expect(result.stdout).toMatch(/^Figure checks passed/m);
      expect(result.stdout).toMatch(/picture: Me read as C; its stereo counts are the carbon document's/);
      expect(result.status).toBe(0);
    }, 120_000);

    it("check fails loudly on a figure that fails the figure checks, even when the identity matches", async () => {
      const where = checkRun("strychnine", {});
      const result = await run("check", where, "strychnine");
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/^Identity check passed\.$/m);
      expect(result.stdout).toMatch(/^Figure checks FAILED \(\d+\):$/m);
      expect(result.stdout).toMatch(/^ {2}FAILED ring E is a sliver: .* \(strychnine-carbon\.json, strychnine-nicolaou\.json\)$/m);
      expect(result.stdout).toMatch(/^ {2}FAILED fusion H dropped at a13 /m);
      expect(result.stdout).toMatch(/not finished: do not deliver it as finished/);
      const saved = JSON.parse(read(join(where, "strychnine-check.json")));
      expect(saved.failures).toEqual([]);
      expect(saved.figureFailures.length).toBeGreaterThan(4);
    }, 120_000);

    it("rejects an unsafe name and a missing directory", async () => {
      expect((await run("style", dir, "../escape")).status).toBe(2);
      expect((await run("style", join(dir, "missing"), "phenyldecalin")).status).toBe(2);
    }, 120_000);
  });
});
