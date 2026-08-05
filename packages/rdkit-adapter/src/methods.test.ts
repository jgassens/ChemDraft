import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MethodRegistry, elementsOutsideParameterization, methodKey } from "@chemdraft/analysis-core";

import {
  descriptorBindings,
  PINNED_PKA_MODEL_SHA256,
  PINNED_RDKIT_VERSION,
  PINNED_RDKIT_WASM_SHA256,
  rdkitMethodContracts
} from "./methods";

const buildDoc = readFileSync(new URL("../vendor/BUILD.md", import.meta.url), "utf8");

describe("the vendored artifact pin", () => {
  it("matches the SHA-256 recorded in vendor/BUILD.md", () => {
    // The hash travels in every AnalysisRun's engine environment, so a rebuilt WASM changes the run
    // fingerprint and invalidates cached numbers. That only works if the constant and BUILD.md agree —
    // hence this test rather than a comment asking someone to remember.
    expect(buildDoc).toContain(PINNED_RDKIT_WASM_SHA256);
  });

  it("matches the bytes actually committed at vendor/RDKit_minimal.wasm", () => {
    // The two tests either side of this one only prove the constant agrees with prose. Prose and
    // constant can agree with each other and both be wrong about the file — which is exactly the
    // failure a rebuild invites, since the artifact is the one thing that changes. Hash the bytes.
    const wasm = readFileSync(new URL("../vendor/RDKit_minimal.wasm", import.meta.url));
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(PINNED_RDKIT_WASM_SHA256);
  });

  it("matches the RDKit release recorded in vendor/BUILD.md", () => {
    expect(buildDoc).toContain(`Release_${PINNED_RDKIT_VERSION.replace(/\./g, "_")}`);
  });
});

/**
 * The pKa artifacts, pinned the same three ways.
 *
 * They decide every pKa the app reports and reached no run fingerprint at all until now, so two builds
 * could produce different numbers under identical provenance.
 */
describe("the vendored pKa model pin", () => {
  const RUNTIME_ARTIFACTS = [
    "calibration.json",
    "consensus-calibration.json",
    "coupling.json",
    // Weights every rung of the macroscopic fold. It moves polyprotic answers without moving a single
    // per-site value, so it is exactly the kind of artifact that could drift unnoticed.
    "edge-variance.json",
    "external-validation.json",
    "hammett-sigma.json",
    // Decides every reported interval, and through the interval every confidence ring, every rung's
    // weight in the fold, and which sites the consensus trusts.
    "interval-calibration.json",
    "site-pka-gnn.json"
  ];

  /** sha256 over `${name}  ${sha256hex}\n` per file, names sorted. */
  function manifest(): { digest: string; perFile: Map<string, string> } {
    const perFile = new Map<string, string>();
    let lines = "";
    for (const name of [...RUNTIME_ARTIFACTS].sort()) {
      const bytes = readFileSync(new URL(`../vendor/pka-model/${name}`, import.meta.url));
      const digest = createHash("sha256").update(bytes).digest("hex");
      perFile.set(name, digest);
      lines += `${name}  ${digest}\n`;
    }
    return { digest: createHash("sha256").update(lines).digest("hex"), perFile };
  }

  const pkaBuildDoc = readFileSync(new URL("../vendor/pka-model/BUILD.md", import.meta.url), "utf8");

  it("matches the manifest recorded in vendor/pka-model/BUILD.md", () => {
    expect(pkaBuildDoc).toContain(PINNED_PKA_MODEL_SHA256);
  });

  it("matches the bytes actually committed under vendor/pka-model/", () => {
    // Prose and constant can agree with each other and both be wrong about the files, which is exactly
    // what a retrain invites. On failure, name the artifact that moved rather than just the manifest.
    const { digest, perFile } = manifest();
    if (digest !== PINNED_PKA_MODEL_SHA256) {
      const drifted = [...perFile].filter(([name, hash]) => !pkaBuildDoc.includes(hash)).map(([name]) => name);
      expect.fail(
        `pKa artifact manifest is ${digest}, pinned as ${PINNED_PKA_MODEL_SHA256}. ` +
          (drifted.length > 0
            ? `Regenerated: ${drifted.join(", ")}. Update BUILD.md and PINNED_PKA_MODEL_SHA256.`
            : "Every per-file hash still matches BUILD.md, so the manifest rule itself changed.")
      );
    }
  });

  it("records every runtime artifact's own hash in BUILD.md, so a failure can name one", () => {
    for (const [name, digest] of manifest().perFile) {
      expect(pkaBuildDoc, `${name} is not listed in BUILD.md`).toContain(digest);
    }
  });
});

describe("rdkitMethodContracts", () => {
  const contracts = rdkitMethodContracts();

  it("registers every contract without a schema violation", () => {
    // MethodRegistry.register validates, so this covers: a unit on every scalar, a non-empty
    // declinesWhen, named conventions on every convention-dependent method, citations on every
    // calibrated one, and version-increment triggers throughout.
    const registry = new MethodRegistry();
    for (const contract of contracts) expect(() => registry.register(contract)).not.toThrow();
    expect(registry.list()).toHaveLength(contracts.length);
  });

  it("covers the Release 1 scope", () => {
    const ids = new Set(contracts.map((contract) => contract.id));
    for (const required of [
      "rdkit.composition",
      "rdkit.average-mass",
      "rdkit.monoisotopic-mass",
      "rdkit.inchi",
      "rdkit.inchikey",
      "rdkit.canonical-smiles",
      "rdkit.tpsa",
      "rdkit.crippen-logp",
      "rdkit.crippen-mr",
      "rdkit.hbd",
      "rdkit.hba",
      "rdkit.rotatable-bonds",
      "rdkit.ring-count",
      "rdkit.atom-stereocentre-count",
      "rdkit.fraction-csp3",
      "rdkit.kappa1",
      "rdkit.chi0n",
      "rdkit.chi4v",
      "rdkit.hall-kier-alpha",
      "rdkit.labute-asa"
    ]) {
      expect(ids.has(required), `missing contract "${required}"`).toBe(true);
    }
  });

  it("has unique ids", () => {
    const ids = contracts.map((contract) => contract.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("binds every descriptor contract to a get_descriptors key", () => {
    const ids = new Set(contracts.map((contract) => contract.id));
    for (const binding of descriptorBindings()) {
      expect(ids.has(binding.methodId), `binding for unregistered "${binding.methodId}"`).toBe(true);
      expect(binding.descriptorKey.length).toBeGreaterThan(0);
    }
  });

  it("marks every descriptor convention-dependent, because every one of them is", () => {
    // Ring counts go through SSSR, rotatable bonds and HBD/HBA are SMARTS choices, kappa and chi are
    // particular published formulations, and average mass depends on the standard atomic weights in
    // force. None of these is a property of the molecule alone.
    for (const contract of contracts) {
      expect(contract.classification.flags.conventionDependent, `${contract.id}`).toBe(true);
      expect(contract.conventions.length, `${contract.id} conventions`).toBeGreaterThan(0);
    }
  });

  it("marks only the Crippen models as experimentally calibrated", () => {
    const calibrated = contracts
      .filter((contract) => contract.classification.flags.experimentallyCalibrated)
      .map((contract) => contract.id)
      .sort();
    // Ertl's TPSA fragments were fitted to *computed* 3D polar surface areas, not measurements, so it
    // does not belong on this list even though it is a fragment method.
    expect(calibrated).toEqual(["rdkit.crippen-logp", "rdkit.crippen-mr"]);
  });

  it("trains nothing on experimental data — no learned model ships in this adapter", () => {
    expect(contracts.every((contract) => !contract.classification.flags.trainedOnExperimentalData)).toBe(true);
  });

  it("declares element parameterisation only where an unparameterised element would take a fallback", () => {
    const parameterised = contracts
      .filter((contract) => contract.parameterizedElements)
      .map((contract) => contract.id)
      .sort();
    expect(parameterised).toEqual(["rdkit.crippen-logp", "rdkit.crippen-mr", "rdkit.tpsa"]);

    const crippen = contracts.find((contract) => contract.id === "rdkit.crippen-logp")!;
    expect(elementsOutsideParameterization(crippen, ["C", "H", "O"])).toEqual([]);
    expect(elementsOutsideParameterization(crippen, ["C", "H", "O", "Na"])).toEqual(["Na"]);
    expect(elementsOutsideParameterization(crippen, ["B", "C", "H", "O", "Fe"])).toEqual(["B", "Fe"]);
  });

  it("leaves topological counts unparameterised, so they never decline on element grounds", () => {
    const ringCount = contracts.find((contract) => contract.id === "rdkit.ring-count")!;
    expect(ringCount.parameterizedElements).toBeUndefined();
    expect(elementsOutsideParameterization(ringCount, ["Pt", "Fe", "U"])).toEqual([]);
  });

  it("records includeSandP on every descriptor, so patch #6 moves every cache key", () => {
    // The flag is a property of the binding rather than of TPSA alone: patch #6 rebuilds the artifact,
    // and anything computed through it must not be served from the old cache.
    const tpsa = contracts.find((contract) => contract.id === "rdkit.tpsa")!;
    expect(tpsa.implementation.parameters.includeSandP).toBe(false);
    expect(tpsa.conventions.some((convention) => convention.includes("includeSandP"))).toBe(true);
    expect(tpsa.versionIncrementTriggers.some((trigger) => trigger.includes("patch #6"))).toBe(true);

    const before = methodKey(tpsa);
    const after = methodKey({
      ...tpsa,
      version: "2.0.0",
      implementation: { ...tpsa.implementation, parameters: { ...tpsa.implementation.parameters, includeSandP: true } }
    });
    expect(before).not.toBe(after);
  });

  it("threads the live engine version into every method key", () => {
    const pinned = rdkitMethodContracts(PINNED_RDKIT_VERSION);
    const bumped = rdkitMethodContracts("2026.09.1");
    for (const [index, contract] of pinned.entries()) {
      expect(methodKey(contract)).not.toBe(methodKey(bumped[index]!));
    }
  });

  it("names the disagreement with OpenChemLib where one exists", () => {
    const rotatable = contracts.find((contract) => contract.id === "rdkit.rotatable-bonds")!;
    expect(rotatable.conventions.join(" ")).toMatch(/OpenChemLib/);
    const logP = contracts.find((contract) => contract.id === "rdkit.crippen-logp")!;
    expect(logP.declinesWhen.join(" ")).toMatch(/sodium benzoate/);
  });
});

describe("vendor patch #6 — TPSA includeSandP", () => {
  const unpatched = rdkitMethodContracts(PINNED_RDKIT_VERSION, { descriptorIncludeSandP: false });
  const patched = rdkitMethodContracts(PINNED_RDKIT_VERSION, { descriptorIncludeSandP: true });
  const tpsaOf = (contracts: ReturnType<typeof rdkitMethodContracts>) =>
    contracts.find((contract) => contract.id === "rdkit.tpsa")!;

  it("says so when the loaded artifact cannot select the convention", () => {
    // The committed WASM predates the patch. Saying "S and P excluded" without saying it is not
    // currently selectable would leave a reader unable to tell a choice from a limitation.
    const tpsa = tpsaOf(unpatched);
    expect(tpsa.version).toBe("1.0.0");
    expect(tpsa.implementation.parameters.includeSandP).toBe(false);
    expect(tpsa.conventions.join(" ")).toMatch(/predates vendor patch #6/);
    expect(tpsa.conventions.join(" ")).toMatch(/EXCLUDED/);
  });

  it("bumps its own version when the capability is really present", () => {
    // The contract's versionIncrementTriggers name this bump; doing it here rather than in a literal
    // means the version cannot lag the artifact.
    const tpsa = tpsaOf(patched);
    expect(tpsa.version).toBe("2.0.0");
    expect(tpsa.implementation.parameters.includeSandP).toBe(true);
    expect(tpsa.conventions.join(" ")).toMatch(/INCLUDED/);
    expect(tpsa.conventions.join(" ")).not.toMatch(/predates vendor patch #6/);
  });

  it("changes the method key, so a rebuild cannot serve S-excluded numbers from the cache", () => {
    expect(methodKey(tpsaOf(unpatched))).not.toBe(methodKey(tpsaOf(patched)));
  });

  it("leaves every other contract untouched by the capability", () => {
    const others = (contracts: ReturnType<typeof rdkitMethodContracts>) =>
      contracts.filter((contract) => contract.id !== "rdkit.tpsa").map(methodKey);
    expect(others(unpatched)).toEqual(others(patched));
  });

  it("keeps the registry happy under both capabilities", () => {
    for (const contracts of [unpatched, patched]) {
      const registry = new MethodRegistry();
      for (const contract of contracts) expect(() => registry.register(contract)).not.toThrow();
    }
  });
});
