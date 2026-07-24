import { afterEach, describe, expect, it } from "vitest";
import {
  ensureRdkit,
  generate3DConformerProgressive,
  generateSmiles2DMolfile,
  resetRdkitForTesting,
  setRdkitModuleLoader,
  type RdkitJsMol,
  type RdkitMinimalModule
} from "./conformer";

/** Fixed-column V2000 molfile so the adapter's explicit-H detection (parseV2000AtomBlock) works. */
function v2000(
  atoms: { element: string; x?: number; y?: number; z?: number }[],
  bonds: { from: number; to: number; order?: number; stereo?: number }[] = []
): string {
  const f = (n: number) => n.toFixed(4).padStart(10);
  const counts = `${String(atoms.length).padStart(3)}${String(bonds.length).padStart(3)}  0  0  0  0  0  0  0  0999 V2000`;
  const lines = atoms.map(
    (a) => `${f(a.x ?? 0)}${f(a.y ?? 0)}${f(a.z ?? 0)} ${a.element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`
  );
  const bondLines = bonds.map((bond) =>
    `${String(bond.from).padStart(3)}${String(bond.to).padStart(3)}${String(bond.order ?? 1).padStart(3)}${String(bond.stereo ?? 0).padStart(3)}  0  0  0`
  );
  return ["", "  mock", "", counts, ...lines, ...bondLines, "M  END"].join("\n");
}

const EMBED_MOLBLOCK = "EMBED_MOLBLOCK_3D";

// Engine order: C(0) O(1) H-input(2) H-added(3) H-added(4); originals are 0,1,2.
const ENGINE_TO_ORIGINAL = [0, 1, 2, -1, -1];
const GENERATED_H = [3, 4];
const EMBED_ENGINE_COORDS = [0.1, 0.2, 0.3, 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3];
const REFINE_ENGINE_COORDS = [0.5, 0.6, 0.7, 1.5, 1.6, 1.7, 2.5, 2.6, 2.7, 3.5, 3.6, 3.7, 4.5, 4.6, 4.7];
const REFINE_ENGINE_COORDS_2 = REFINE_ENGINE_COORDS.map((value) => value + 0.1);
const REFINE_ENGINE_COORDS_3 = REFINE_ENGINE_COORDS.map((value) => value + 0.2);

interface MockOptimizeResponse {
  raw?: string;
  embedOk?: boolean;
  coords3dByEngineAtom?: number[];
  status?: string;
  energy?: number;
  iterations?: number;
}

interface MockHooks {
  embedPayload?: Partial<{
    embedOk: boolean;
    coords3dByEngineAtom: number[];
    engineToOriginalAtom: number[];
    generatedHydrogenEngineAtoms: number[];
    molblock: string;
  }>;
  parseReturnsNull?: boolean;
  /** Simulate a real ETKDG embed that only succeeds with `useRandomCoords:true` (a large,
   *  flexible molecule): the first attempt returns embedOk:false, the random-coords retry ok. */
  failUnlessRandomCoords?: boolean;
  optimizeResponses?: MockOptimizeResponse[];
}

function installMock(hooks: MockHooks = {}) {
  const deletes: string[] = [];
  const getMolMolblocks: string[] = [];
  const embedDetails: string[] = [];
  const optimizeDetails: string[] = [];

  const module: RdkitMinimalModule = {
    version: () => "test-rdkit",
    get_mol(molblock: string): RdkitJsMol | null {
      getMolMolblocks.push(molblock);
      if (hooks.parseReturnsNull) return null;
      const tag = molblock === EMBED_MOLBLOCK ? "work" : "input";
      let optimizeCall = 0;
      return {
        generate_3d_embed(details: string): string {
          embedDetails.push(details);
          const useRandomCoords = (JSON.parse(details) as { useRandomCoords?: boolean }).useRandomCoords === true;
          const embedOk = hooks.failUnlessRandomCoords ? useRandomCoords : true;
          return JSON.stringify({
            embedOk,
            coords3dByEngineAtom: EMBED_ENGINE_COORDS,
            engineToOriginalAtom: ENGINE_TO_ORIGINAL,
            generatedHydrogenEngineAtoms: GENERATED_H,
            molblock: EMBED_MOLBLOCK,
            ...hooks.embedPayload
          });
        },
        optimize_3d_conformer(details: string): string {
          optimizeDetails.push(details);
          const parsed = JSON.parse(details) as { forceField: string; maxIters?: number };
          const response = hooks.optimizeResponses?.[optimizeCall++] ?? {};
          if (response.raw !== undefined) return response.raw;
          return JSON.stringify({
            embedOk: response.embedOk ?? true,
            coords3dByEngineAtom: response.coords3dByEngineAtom ?? REFINE_ENGINE_COORDS,
            forceField: {
              name: parsed.forceField,
              status: response.status ?? "converged",
              energy: response.energy ?? -9.5,
              iterations: response.iterations ?? parsed.maxIters
            }
          });
        },
        delete() {
          deletes.push(tag);
        }
      };
    }
  };

  setRdkitModuleLoader(() => Promise.resolve(module));
  return { deletes, getMolMolblocks, embedDetails, optimizeDetails };
}

// 3 original atoms incl. an explicit input H at index 2.
const INPUT = { molfile: v2000([{ element: "C" }, { element: "O" }, { element: "H" }]), originalAtomCount: 3 };

afterEach(() => resetRdkitForTesting());

describe("rdkit adapter — 2D SMILES depiction", () => {
  function install2dMock(options: {
    coordinates?: boolean;
    molfile?: string;
    standardMolfile?: string;
    coordGenMolfile?: string;
    canonicalIdentity?: (structure: string) => string;
  } = {}) {
    let input = "";
    let deleted = 0;
    const useCoordGen: Array<boolean | undefined> = [];
    setRdkitModuleLoader(() => Promise.resolve({
      get_mol(structure: string): RdkitJsMol {
        input = structure;
        let requestedUseCoordGen: boolean | undefined;
        return {
          generate_3d_embed: () => "{}",
          optimize_3d_conformer: () => "{}",
          set_new_coords: (useCoordGenCandidate) => {
            requestedUseCoordGen = useCoordGenCandidate;
            useCoordGen.push(useCoordGenCandidate);
            return options.coordinates ?? true;
          },
          get_molblock: () =>
            (requestedUseCoordGen ? options.coordGenMolfile : options.standardMolfile) ??
            options.molfile ??
            v2000([{ element: "C" }, { element: "O", x: 1.5 }]),
          ...(options.canonicalIdentity
            ? { get_smiles: () => options.canonicalIdentity!(structure) }
            : {}),
          delete: () => { deleted += 1; }
        };
      }
    }));
    return { input: () => input, deleted: () => deleted, useCoordGen: () => useCoordGen };
  }

  it("returns a generated molfile and always releases the WASM molecule", async () => {
    const state = install2dMock();
    const molfile = await generateSmiles2DMolfile("CO");
    expect(state.input()).toBe("CO");
    expect(molfile).toContain("V2000");
    expect(state.useCoordGen()).toEqual([false, true]);
    expect(state.deleted()).toBe(3);
  });

  it("fails explicitly and still releases the molecule when 2D generation fails", async () => {
    const state = install2dMock({ coordinates: false });
    await expect(generateSmiles2DMolfile("CO")).rejects.toThrow("could not generate 2D coordinates");
    expect(state.deleted()).toBe(1);
  });

  it("orients a wide depiction from left to right without reversing tetrahedral stereo", async () => {
    install2dMock({
      molfile: v2000(
        [
          { element: "C", x: 4, y: 0 },
          { element: "C", x: 3, y: 0.3 },
          { element: "C", x: 2, y: 0 },
          { element: "O", x: 0, y: 0 }
        ],
        [
          { from: 1, to: 2, stereo: 1 },
          { from: 2, to: 3 },
          { from: 3, to: 4 }
        ]
      )
    });

    const molfile = await generateSmiles2DMolfile("CCCO");
    const lines = molfile.split(/\r?\n/);
    const countsIndex = lines.findIndex((line) => /\bV2000\b/.test(line));
    expect(Number.parseFloat(lines[countsIndex + 1]!.slice(0, 10))).toBe(0);
    expect(Number.parseFloat(lines[countsIndex + 4]!.slice(0, 10))).toBe(4);
    expect(Number.parseInt(lines[countsIndex + 5]!.slice(9, 12).trim(), 10)).toBe(6);
  });

  it.each([
    ["lost", "FC(Cl)Br", 0],
    ["inverted", "F[C@@H](Cl)Br", 6]
  ])("rejects a clearer CoordGen candidate with %s tetrahedral stereo", async (
    _,
    coordGenIdentity,
    coordGenStereo
  ) => {
    const source = "F[C@H](Cl)Br";
    const standardMolfile = v2000(
      [
        { element: "F", x: 0, y: 0 },
        { element: "C", x: 1, y: 0 },
        { element: "Cl", x: 1, y: 1 },
        { element: "Br", x: 0, y: 1 }
      ],
      [
        { from: 2, to: 1, stereo: 1 },
        { from: 2, to: 3 },
        { from: 2, to: 4 }
      ]
    );
    const coordGenMolfile = v2000(
      [
        { element: "F", x: 0, y: 0 },
        { element: "C", x: 1, y: 0 },
        { element: "Cl", x: 2, y: 0 },
        { element: "Br", x: 3, y: 0 }
      ],
      [
        { from: 2, to: 1, stereo: coordGenStereo },
        { from: 2, to: 3 },
        { from: 2, to: 4 }
      ]
    );
    install2dMock({
      standardMolfile,
      coordGenMolfile,
      canonicalIdentity: (structure) => {
        if (structure === coordGenMolfile) return coordGenIdentity;
        return source;
      }
    });

    await expect(generateSmiles2DMolfile(source)).resolves.toBe(standardMolfile);
  });

  it.each([
    ["lost", "FC(Cl)Br", 0],
    ["inverted", "F[C@@H](Cl)Br", 6]
  ])("rejects when the standard depiction has %s tetrahedral stereo", async (
    _,
    standardIdentity,
    standardStereo
  ) => {
    const source = "F[C@H](Cl)Br";
    const standardMolfile = v2000(
      [
        { element: "F", x: 0, y: 0 },
        { element: "C", x: 1, y: 0 },
        { element: "Cl", x: 1, y: 1 },
        { element: "Br", x: 0, y: 1 }
      ],
      [
        { from: 2, to: 1, stereo: standardStereo },
        { from: 2, to: 3 },
        { from: 2, to: 4 }
      ]
    );
    const state = install2dMock({
      standardMolfile,
      canonicalIdentity: (structure) =>
        structure === standardMolfile ? standardIdentity : source
    });

    await expect(generateSmiles2DMolfile(source)).rejects.toThrow(
      "RDKit standard 2D depiction changed the source isomeric stereochemistry"
    );
    expect(state.useCoordGen()).toEqual([false]);
  });

  // Candidate-selection heuristic (preferCoordGenDepiction). Each fixture pair keeps atom/bond
  // counts equal and the first atom on the left so the orientation pass never rewrites the
  // molfile, letting `resolves.toBe` identify the selected candidate exactly.
  const CHAIN_BONDS = [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }];
  const horizontalChain = v2000(
    [
      { element: "C", x: 0, y: 0 },
      { element: "C", x: 1, y: 0 },
      { element: "C", x: 2, y: 0 },
      { element: "O", x: 3, y: 0 }
    ],
    CHAIN_BONDS
  );
  const verticalChain = v2000(
    [
      { element: "C", x: 0, y: 0 },
      { element: "C", x: 0, y: 1 },
      { element: "C", x: 0, y: 2 },
      { element: "O", x: 0, y: 3 }
    ],
    CHAIN_BONDS
  );
  // Bonds 1-2 and 3-4 properly cross at (0.5, 0.5); the chain stays connected via 2-3.
  const crossedChain = v2000(
    [
      { element: "C", x: 0, y: 0 },
      { element: "C", x: 1, y: 1 },
      { element: "C", x: 1, y: 0 },
      { element: "O", x: 0, y: 1 }
    ],
    CHAIN_BONDS
  );
  // Wide layout whose terminal O sits 0.42 units (≈0.34 bond lengths) from atom 1: a clear
  // non-bonded overlap that must veto the otherwise preferred wide aspect.
  const overlappingWideChain = v2000(
    [
      { element: "C", x: 0, y: 0 },
      { element: "C", x: 1, y: 0 },
      { element: "C", x: 2, y: 0 },
      { element: "O", x: 0.3, y: 0.3 }
    ],
    CHAIN_BONDS
  );

  it("prefers the CoordGen depiction when it removes a bond crossing with clear spacing", async () => {
    install2dMock({ standardMolfile: crossedChain, coordGenMolfile: horizontalChain });
    await expect(generateSmiles2DMolfile("CCCO")).resolves.toBe(horizontalChain);
  });

  it("keeps the standard depiction when CoordGen introduces a bond crossing", async () => {
    install2dMock({ standardMolfile: horizontalChain, coordGenMolfile: crossedChain });
    await expect(generateSmiles2DMolfile("CCCO")).resolves.toBe(horizontalChain);
  });

  it("keeps the standard depiction when the wider CoordGen candidate overlaps non-bonded atoms", async () => {
    install2dMock({ standardMolfile: verticalChain, coordGenMolfile: overlappingWideChain });
    await expect(generateSmiles2DMolfile("CCCO")).resolves.toBe(verticalChain);
  });

  it("prefers the horizontal CoordGen depiction when both candidates are equally clear", async () => {
    install2dMock({ standardMolfile: verticalChain, coordGenMolfile: horizontalChain });
    await expect(generateSmiles2DMolfile("CCCO")).resolves.toBe(horizontalChain);
  });
});

describe("rdkit conformer adapter — embed mapping", () => {
  it("scatters engine-order coords onto original atoms and maps hydrogens", async () => {
    installMock();
    const { embedded } = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" });

    expect(embedded.embed.status).toBe("ok");
    expect([...embedded.mapping.coords3dByOriginalAtom]).toEqual([0.1, 0.2, 0.3, 1.1, 1.2, 1.3, 2.1, 2.2, 2.3]);
    expect(embedded.mapping.engineToOriginalAtom).toEqual(ENGINE_TO_ORIGINAL);
    expect(embedded.mapping.originalToEngineAtom).toEqual([0, 1, 2]); // engine H 3,4 dropped
    expect(embedded.mapping.generatedHydrogenEngineAtoms).toEqual(GENERATED_H);
    expect(embedded.generatedAtomCount).toBe(2);
    expect(embedded.engine.name).toBe("rdkit-wasm");
    expect(embedded.forceField).toEqual({ name: "none", status: "not-run" });
  });

  it("preserves explicit input hydrogens (mapped, not -1) and flags them", async () => {
    installMock();
    const { embedded } = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" });
    // The input H (original atom 2) keeps an engine mapping; only RDKit-added H are -1.
    expect(embedded.mapping.engineToOriginalAtom[2]).toBe(2);
    expect(embedded.hydrogens).toEqual({ added: true, explicitInputHydrogensPreserved: true });
  });

  it("passes the embed seed + timeout rail to the binding", async () => {
    const mock = installMock();
    await generate3DConformerProgressive(INPUT, { optimize: "mmff94", seed: 42 });
    expect(JSON.parse(mock.embedDetails[0])).toEqual({ seed: 42, timeoutSeconds: 10, useRandomCoords: false });
  });
});

describe("rdkit conformer adapter — refine", () => {
  it("derives a refinement from the pristine embed molblock and reports the force field", async () => {
    const mock = installMock();
    const { refineFromEmbedded } = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" });
    expect(refineFromEmbedded).toBeDefined();
    const refined = refineFromEmbedded!(200);

    expect([...refined.mapping.coords3dByOriginalAtom]).toEqual([0.5, 0.6, 0.7, 1.5, 1.6, 1.7, 2.5, 2.6, 2.7]);
    expect(refined.forceField).toEqual({ name: "MMFF94", status: "converged", energy: -9.5, iterations: 160 });
    // Refine re-parsed the embed molblock (not the input) — pristine per call.
    expect(mock.getMolMolblocks[1]).toBe(EMBED_MOLBLOCK);
    expect(JSON.parse(mock.optimizeDetails[0])).toEqual({ forceField: "mmff94", maxIters: 160 });
  });

  it("converges on the third focused pass without exceeding the total budget", async () => {
    const mock = installMock({
      optimizeResponses: [
        { status: "not-converged", coords3dByEngineAtom: REFINE_ENGINE_COORDS, energy: -7.0 },
        { status: "not-converged", coords3dByEngineAtom: REFINE_ENGINE_COORDS_2, energy: -8.5 },
        { status: "converged", coords3dByEngineAtom: REFINE_ENGINE_COORDS_3, energy: -9.5 }
      ]
    });
    const { refineFromEmbedded } = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" });
    const refined = refineFromEmbedded!(120);

    expect(mock.optimizeDetails.map((details) => JSON.parse(details))).toEqual([
      { forceField: "mmff94", maxIters: 96 },
      { forceField: "mmff94", maxIters: 12 },
      { forceField: "mmff94", maxIters: 12 }
    ]);
    expect(mock.getMolMolblocks).toEqual([INPUT.molfile, EMBED_MOLBLOCK]);
    expect(mock.deletes).toEqual(["input", "work"]);
    expect([...refined.mapping.coords3dByOriginalAtom]).toEqual(REFINE_ENGINE_COORDS_3.slice(0, 9));
    expect(refined.forceField).toEqual({
      name: "MMFF94",
      status: "converged",
      energy: -9.5,
      iterations: 120
    });
  });

  it("stops after three non-converged passes while preserving the total budget", async () => {
    const mock = installMock({
      optimizeResponses: [
        { status: "not-converged", coords3dByEngineAtom: REFINE_ENGINE_COORDS },
        { status: "not-converged", coords3dByEngineAtom: REFINE_ENGINE_COORDS_2 },
        { status: "not-converged", coords3dByEngineAtom: REFINE_ENGINE_COORDS_3 },
        { status: "converged" }
      ]
    });
    const { refineFromEmbedded } = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" });
    const refined = refineFromEmbedded!(50);

    expect(mock.optimizeDetails.map((details) => JSON.parse(details).maxIters)).toEqual([40, 5, 5]);
    expect(refined.forceField?.status).toBe("not-converged");
    expect(refined.forceField?.iterations).toBe(50);
    expect([...refined.mapping.coords3dByOriginalAtom]).toEqual(REFINE_ENGINE_COORDS_3.slice(0, 9));
  });

  it("keeps the last valid coordinates when a later pass returns malformed JSON", async () => {
    const mock = installMock({
      optimizeResponses: [
        { status: "not-converged", coords3dByEngineAtom: REFINE_ENGINE_COORDS },
        { raw: "{" }
      ]
    });
    const { refineFromEmbedded } = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" });
    const refined = refineFromEmbedded!(60);

    expect(mock.optimizeDetails).toHaveLength(2);
    expect([...refined.mapping.coords3dByOriginalAtom]).toEqual(REFINE_ENGINE_COORDS.slice(0, 9));
    expect(refined.forceField).toEqual({
      name: "MMFF94",
      status: "not-converged",
      energy: -9.5,
      iterations: 48
    });
  });

  it("keeps the last valid coordinates when a later pass changes coordinate count", async () => {
    const mock = installMock({
      optimizeResponses: [
        { status: "not-converged", coords3dByEngineAtom: REFINE_ENGINE_COORDS },
        { status: "converged", coords3dByEngineAtom: REFINE_ENGINE_COORDS_2.slice(0, -3) }
      ]
    });
    const { refineFromEmbedded } = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" });
    const refined = refineFromEmbedded!(60);

    expect(mock.optimizeDetails).toHaveLength(2);
    expect([...refined.mapping.coords3dByOriginalAtom]).toEqual(REFINE_ENGINE_COORDS.slice(0, 9));
    expect(refined.forceField?.status).toBe("not-converged");
    expect(refined.forceField?.iterations).toBe(48);
  });

  it("returns embedded coordinates with setup-failed when the first pass is malformed", async () => {
    const mock = installMock({ optimizeResponses: [{ raw: "{" }] });
    const { embedded, refineFromEmbedded } = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" });
    const refined = refineFromEmbedded!(60);

    expect(mock.optimizeDetails).toHaveLength(1);
    expect([...refined.mapping.coords3dByOriginalAtom]).toEqual([...embedded.mapping.coords3dByOriginalAtom]);
    expect(refined.forceField).toEqual({ name: "MMFF94", status: "setup-failed" });
  });

  it("starts every public refinement from an independent pristine work molecule", async () => {
    const mock = installMock({
      optimizeResponses: [
        { status: "not-converged", coords3dByEngineAtom: REFINE_ENGINE_COORDS },
        { status: "converged", coords3dByEngineAtom: REFINE_ENGINE_COORDS_2 }
      ]
    });
    const { refineFromEmbedded } = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" });
    const first = refineFromEmbedded!(60);
    const second = refineFromEmbedded!(60);

    expect(mock.getMolMolblocks).toEqual([INPUT.molfile, EMBED_MOLBLOCK, EMBED_MOLBLOCK]);
    expect(mock.deletes).toEqual(["input", "work", "work"]);
    expect(mock.optimizeDetails.map((details) => JSON.parse(details).maxIters)).toEqual([48, 6, 48, 6]);
    expect([...second.mapping.coords3dByOriginalAtom]).toEqual([...first.mapping.coords3dByOriginalAtom]);
    expect(second.forceField).toEqual(first.forceField);
  });

  it("honours a per-refine force-field override (UFF) without re-embedding", async () => {
    const mock = installMock();
    const { refineFromEmbedded } = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" });
    const refined = refineFromEmbedded!(120, { forceField: "uff" });

    expect(refined.forceField?.name).toBe("UFF");
    expect(JSON.parse(mock.optimizeDetails[0])).toMatchObject({ forceField: "uff", maxIters: 96 });
    // Two get_mol calls total: one embed (input), one refine (embed molblock). No re-embed.
    expect(mock.getMolMolblocks).toHaveLength(2);
  });

  it("defaults the refine force field to UFF when optimize:'uff'", async () => {
    const mock = installMock();
    const { refineFromEmbedded } = await generate3DConformerProgressive(INPUT, { optimize: "uff" });
    refineFromEmbedded!(80);
    expect(JSON.parse(mock.optimizeDetails[0]).forceField).toBe("uff");
  });

  it("omits refineFromEmbedded when optimize:'none'", async () => {
    installMock();
    const result = await generate3DConformerProgressive(INPUT, { optimize: "none" });
    expect(result.refineFromEmbedded).toBeUndefined();
    expect(result.embedded.embed.status).toBe("ok");
  });
});

describe("rdkit conformer adapter — lifecycle + failure", () => {
  it("deletes every WASM handle it creates (embed + each refine)", async () => {
    const mock = installMock();
    const { refineFromEmbedded } = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" });
    refineFromEmbedded!(50);
    refineFromEmbedded!(50, { forceField: "uff" });
    expect(mock.deletes).toEqual(["input", "work", "work"]); // embed handle + one per refine
  });

  it("reports a failed embed when RDKit returns embedOk:false (no refine offered)", async () => {
    installMock({ embedPayload: { embedOk: false } });
    const result = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" });
    expect(result.embedded.embed.status).toBe("failed");
    expect(result.refineFromEmbedded).toBeUndefined();
  });

  it("retries a large molecule's failed embed with useRandomCoords and succeeds", async () => {
    const mock = installMock({ failUnlessRandomCoords: true });
    const result = await generate3DConformerProgressive(
      { molfile: INPUT.molfile, originalAtomCount: 64 },
      { optimize: "mmff94" }
    );
    expect(result.embedded.embed.status).toBe("ok");
    expect(mock.embedDetails).toHaveLength(2); // default start failed, random-coords retry ran
    expect(JSON.parse(mock.embedDetails[0]).useRandomCoords).toBe(false);
    expect(JSON.parse(mock.embedDetails[1]).useRandomCoords).toBe(true);
  });

  it("does NOT retry a small molecule's failed embed (random coords only helps large ones)", async () => {
    const mock = installMock({ failUnlessRandomCoords: true });
    const result = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" }); // 3 atoms
    expect(result.embedded.embed.status).toBe("failed");
    expect(mock.embedDetails).toHaveLength(1); // no second attempt
  });

  it("reports a failed embed when the molfile cannot be parsed", async () => {
    installMock({ parseReturnsNull: true });
    const result = await generate3DConformerProgressive(INPUT, { optimize: "mmff94" });
    expect(result.embedded.embed.status).toBe("failed");
    expect(result.embedded.embed.failureReason).toMatch(/could not parse/);
  });

  it("rejects when the module loader is not set", async () => {
    resetRdkitForTesting();
    await expect(ensureRdkit()).rejects.toThrow(/loader not set/);
  });

  it("retries module loading after a failed load", async () => {
    let attempts = 0;
    setRdkitModuleLoader(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("boom")) : Promise.resolve({ get_mol: () => null } as RdkitMinimalModule);
    });
    await expect(ensureRdkit()).rejects.toThrow(/boom/);
    await expect(ensureRdkit()).resolves.toBeTruthy();
    expect(attempts).toBe(2);
  });
});

describe("rdkit conformer adapter — best-of-K embedding", () => {
  // Each ETKDG seed yields a distinct embed (seed tagged into molblock + atom-0 x-coord) and a
  // distinct short-MMFF energy, so the lowest-energy winner is observable in the final embed.
  function installSeedScoredMock(energyBySeed: Map<number, number>) {
    const embedSeeds: number[] = [];
    const scoredMolblocks: string[] = [];
    const module: RdkitMinimalModule = {
      version: () => "test-rdkit",
      get_mol(molblock: string): RdkitJsMol | null {
        return {
          generate_3d_embed(details: string): string {
            const seed = (JSON.parse(details) as { seed: number }).seed;
            embedSeeds.push(seed);
            const coords = [...EMBED_ENGINE_COORDS];
            coords[0] = seed; // tag atom 0's x with the seed so the chosen embed is identifiable
            return JSON.stringify({
              embedOk: true,
              coords3dByEngineAtom: coords,
              engineToOriginalAtom: ENGINE_TO_ORIGINAL,
              generatedHydrogenEngineAtoms: GENERATED_H,
              molblock: `EMBED_${seed}`
            });
          },
          optimize_3d_conformer(details: string): string {
            scoredMolblocks.push(molblock);
            const seed = Number(molblock.replace("EMBED_", ""));
            return JSON.stringify({
              embedOk: true,
              coords3dByEngineAtom: EMBED_ENGINE_COORDS,
              forceField: {
                name: (JSON.parse(details) as { forceField: string }).forceField,
                status: "converged",
                energy: energyBySeed.get(seed) ?? 0
              }
            });
          },
          delete() {}
        };
      }
    };
    setRdkitModuleLoader(() => Promise.resolve(module));
    return { embedSeeds, scoredMolblocks };
  }

  it("keeps the lowest-energy candidate among K deterministic embeds", async () => {
    const { embedSeeds, scoredMolblocks } = installSeedScoredMock(
      new Map([[42, -5], [43, -10], [44, -7]])
    );
    const result = await generate3DConformerProgressive(INPUT, {
      optimize: "auto",
      seed: 42,
      embedCandidates: 3
    });
    // Baseline seed 42 plus two more deterministic candidates (43, 44), each scored once.
    expect(embedSeeds).toEqual([42, 43, 44]);
    expect(scoredMolblocks).toEqual(["EMBED_42", "EMBED_43", "EMBED_44"]);
    // Atom 0's x carries the seed; the lowest-energy winner is seed 43.
    expect(result.embedded.mapping.coords3dByOriginalAtom[0]).toBe(43);
  });

  it("is deterministic: same molfile + seed + count picks the same winner", async () => {
    const energies = new Map([[42, -5], [43, -10], [44, -7]]);
    installSeedScoredMock(energies);
    const first = await generate3DConformerProgressive(INPUT, { optimize: "auto", seed: 42, embedCandidates: 3 });
    installSeedScoredMock(energies);
    const second = await generate3DConformerProgressive(INPUT, { optimize: "auto", seed: 42, embedCandidates: 3 });
    expect(second.embedded.mapping.coords3dByOriginalAtom[0]).toBe(first.embedded.mapping.coords3dByOriginalAtom[0]);
    expect(first.embedded.mapping.coords3dByOriginalAtom[0]).toBe(43);
  });

  it("does a single embed and no scoring when candidates are not requested", async () => {
    const { embedSeeds, scoredMolblocks } = installSeedScoredMock(new Map([[42, -5]]));
    const result = await generate3DConformerProgressive(INPUT, { optimize: "auto", seed: 42 });
    expect(embedSeeds).toEqual([42]);
    expect(scoredMolblocks).toEqual([]); // best-of-K never ran
    expect(result.embedded.mapping.coords3dByOriginalAtom[0]).toBe(42);
  });

  it("skips best-of-K (single embed) for molecules above the atom cap", async () => {
    const { embedSeeds, scoredMolblocks } = installSeedScoredMock(new Map([[42, -5]]));
    await generate3DConformerProgressive(
      { molfile: INPUT.molfile, originalAtomCount: 200 },
      { optimize: "auto", seed: 42, embedCandidates: 4 }
    );
    expect(embedSeeds).toEqual([42]);
    expect(scoredMolblocks).toEqual([]);
  });
});
