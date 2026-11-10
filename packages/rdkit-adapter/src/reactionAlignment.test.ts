import { beforeAll, expect, it, vi } from "vitest";
import { installNodeRdkitModuleLoader } from "./node";
import { ensureRdkit, generateSmiles2DMolfile } from "./conformer";
import { createReactionProductAligner } from "./reactionAlignment";

beforeAll(() => installNodeRdkitModuleLoader());

it("keeps a completed core when a later pair times out and stops at the shared budget", async () => {
  const rdkit = await ensureRdkit() as Awaited<ReturnType<typeof ensureRdkit>> & {
    get_mcs_as_json(list: unknown, options: string): string;
  };
  const search = rdkit.get_mcs_as_json.bind(rdkit);
  const reference = await generateSmiles2DMolfile("OC(=O)c1ccccc1O");
  const product = await generateSmiles2DMolfile("CC(=O)Oc1ccccc1C(=O)O");
  let now = 0, calls = 0, yields = 0;
  const spy = vi.spyOn(rdkit, "get_mcs_as_json").mockImplementation((list, options) => {
    expect(JSON.parse(options).Timeout).toBe(1);
    calls++;
    now += calls === 1 ? 400 : 1000;
    return calls === 1 ? search(list, options) : JSON.stringify({ canceled: true });
  });
  try {
    const align = await createReactionProductAligner();
    const result = await align([reference, reference, reference], product, {
      deadline: 1500, now: () => now, yieldControl: async () => { yields++; }
    });
    expect(result!.matchedAtomCount).toBeGreaterThanOrEqual(6);
    expect(calls).toBe(2);
    expect(yields).toBe(3);
    expect(now).toBeLessThanOrEqual(1500);
  } finally { spy.mockRestore(); }
});

it("refuses an aligned molfile whose directed wedge was inverted", async () => {
  const rdkit = await ensureRdkit();
  const reference = await generateSmiles2DMolfile("OC[C@H](O)c1ccccc1");
  const product = await generateSmiles2DMolfile("CC(=O)OC[C@H](O)c1ccccc1");
  const parse = rdkit.get_mol.bind(rdkit);
  let inverted = false;
  const spy = vi.spyOn(rdkit, "get_mol").mockImplementation((value, options) => {
    const molecule = parse(value, options);
    if (value === product && molecule?.get_molblock) {
      const block = molecule.get_molblock.bind(molecule);
      molecule.get_molblock = () => {
        const lines = block().split("\n");
        const atomCount = Number(lines[3]!.slice(0, 3)), bondCount = Number(lines[3]!.slice(3, 6));
        for (let i = 4 + atomCount; i < 4 + atomCount + bondCount; i++) {
          const stereo = lines[i]!.slice(9, 12).trim();
          if (stereo === "1" || stereo === "6") {
            lines[i] = lines[i]!.slice(0, 9) + (stereo === "1" ? "  6" : "  1") + lines[i]!.slice(12);
            inverted = true;
            break;
          }
        }
        return lines.join("\n");
      };
    }
    return molecule;
  });
  try {
    const align = await createReactionProductAligner();
    await expect(align([reference], product)).rejects.toThrow("canonical isomeric SMILES changed");
    expect(inverted).toBe(true);
  } finally { spy.mockRestore(); }
});
