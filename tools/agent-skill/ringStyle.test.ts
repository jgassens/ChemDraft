import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillRoot = join(root, "skills", "chemdraft");
const script = join(skillRoot, "scripts", "ring-style.mjs");
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ring-style");
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n?/g, "\n");

/** Real CLI output: `document` for cholesterol (PubChem CID 5997) and a phenyl-decalin. */
type Json = any; // the fixtures are untyped document JSON
interface Identity { canonicalSmiles: string; stereoCenters: number; unspecifiedStereoCenters: number }
interface RingStyle {
  CONVENTIONS: Record<string, Record<string, Json>>;
  style(doc: Json, buildMol: Json, options?: Json, tools?: { sources?: Json[]; verify?: (mol: Json) => string | null }): { carbon: Json; picture: Json; report: Json };
  model(mol: Json, buildMol?: Json): Json;
  stereoParities(m: Json): Map<string, number>;
  parseMolfile(text: string): Json;
  chemdraftCli(checkout: string): { identity(doc: Json): Identity[]; cleanup(): void };
  identityVerifier(identity: (doc: Json) => Identity[], doc: Json, molId: string): { reference: Identity; verify(mol: Json): string | null };
  collisions(svg: string): { kind: string; a: { text: string }; b: { text: string }; gapPx: number }[];
  letterColour(fill: string, opacity?: number): string;
  readText(file: string): string;
}
let ringStyle: RingStyle;
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
// The real CLI checks identity where the checkout is installed (CI, a developer checkout); an
// agent worktree without per-package node_modules skips those tests.
const cliReady = existsSync(join(root, "node_modules", "tsx", "dist", "cli.mjs")) &&
  existsSync(join(root, "packages", "chemdraft-cli", "node_modules"));

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
    // The leftmost terminal ring of this depiction is the cyclopentane.
    expect(walked.letters[0].ring).toMatch(/^5-ring/);
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
    expect(turned.report.layout.moved).toEqual([]);
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
      let cli: ReturnType<RingStyle["chemdraftCli"]>;
      beforeAll(() => { cli = ringStyle.chemdraftCli(root); });
      afterAll(() => cli?.cleanup());

      it("render-document reads the moved drawing as the same molecule", () => {
        const { build } = fixture("cholesterol");
        const doc = JSON.parse(read(join(fixtures, "cholesterol-methyl-in-b.json")));
        const { reference, verify } = ringStyle.identityVerifier(cli.identity, doc, build.objectId);
        expect(reference).toMatchObject({ stereoCenters: 8, unspecifiedStereoCenters: 0 });
        const { carbon, report } = ringStyle.style(structuredClone(doc), build, { ...steroid, fusionH: false }, { verify });
        expect(report.layout.moved.map((m: Json) => m.group)).toContain("a26 on a20");
        expect(verify(molecule(carbon))).toBeNull();
      }, 120_000);

      it("render-document confirms the undone move would have inverted C10", () => {
        const { build, doc: plain } = fixture("cholesterol");
        const doc = JSON.parse(read(join(fixtures, "cholesterol-methyl-in-a.json")));
        const { verify } = ringStyle.identityVerifier(cli.identity, doc, build.objectId);
        // Put C19 back where the plain drawing has it, keeping the hash on the fused bond.
        const moved = structuredClone(molecule(doc));
        Object.assign(moved.atoms.find((a: Json) => a.id === "a26"), (({ x, y }) => ({ x, y }))(molecule(plain).atoms.find((a: Json) => a.id === "a26")));
        expect(verify(moved)).toMatch(/^reads /);
        const { report } = ringStyle.style(structuredClone(doc), build, steroid, { verify });
        expect(report.layout.stuck.map((x: Json) => x.group)).toEqual(["a26 on a20"]);
      }, 120_000);
    });
  });

  describe("command line", () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "ring-style-cli-"));
      for (const file of ["phenyldecalin.json", "phenyldecalin-build.jsonl"]) copyFileSync(join(fixtures, file), join(dir, file));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

    it("refuses to style without a checkout to verify moves with", () => {
      const result = run("style", dir, "phenyldecalin");
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/style needs --checkout/);
    });

    it.skipIf(!cliReady)("writes the carbon and picture documents from the build output", () => {
      const result = run("style", dir, "phenyldecalin", "--checkout", root);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^Layout: /m);
      for (const file of ["phenyldecalin-carbon.json", "phenyldecalin-nicolaou.json", "phenyldecalin-style.json"]) {
        expect(existsSync(join(dir, file)), file).toBe(true);
      }
      expect(result.stdout).toMatch(/^A {2}#e53935/m);
    }, 120_000);

    it("builds identity jobs that put the carbon back under each Me", () => {
      const line = (document: string, smiles: string) => JSON.stringify({ name: "x", ok: true, document: join(dir, document), files: [],
        molecules: [{ canonicalSmiles: smiles, stereoCenters: 2, unspecifiedStereoCenters: 0, unspecifiedDoubleBonds: 0 }] });
      writeFileSync(join(dir, "phenyldecalin-render.jsonl"),
        `${line("phenyldecalin-carbon.json", "CC1CCCC1")}\n${line("phenyldecalin-nicolaou.json", "*C1CCCC1")}\n`);
      expect(run("identity-jobs", dir, "phenyldecalin").status).toBe(0);
      const jobs = JSON.parse(read(join(dir, "phenyldecalin-identity-jobs.json")));
      expect(jobs.map((j: Json) => j.smiles)).toEqual(["CC1CCCC1", "CC1CCCC1"]);
      expect(new Set(jobs.map((j: Json) => j.name)).size).toBe(2);
    });

    // Installed skills are symlinks (junctions on Windows, where symlinks need privileges).
    it.skipIf(process.platform === "win32")("runs when reached through a symlinked skill directory", () => {
      const link = join(dir, "linked-skill");
      symlinkSync(skillRoot, link, "dir");
      const result = spawnSync(process.execPath, [join(link, "scripts", "ring-style.mjs"), "relayout", dir, "phenyldecalin"], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Wrote phenyldecalin-job\.json/);
    });

    it("rejects an unsafe name and a missing directory", () => {
      expect(run("style", dir, "../escape").status).toBe(2);
      expect(run("style", join(dir, "missing"), "phenyldecalin").status).toBe(2);
    });
  });
});
