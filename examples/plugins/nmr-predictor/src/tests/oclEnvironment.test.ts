import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import { atomEnvironmentCodes, environmentKey, sphereDepthOf } from "../providers/ocl/environmentCode";

describe("environment code helpers", () => {
  it("namespaces keys by nucleus", () => {
    expect(environmentKey("13C", "Cq0h3()")).toBe("13C@Cq0h3()");
    expect(environmentKey("1H", "Cq0h3()")).toBe("1H@Cq0h3()");
  });

  it("counts sphere groups as depth", () => {
    expect(sphereDepthOf("Cq0h3(1Ch0)")).toBe(1);
    expect(sphereDepthOf("Cq0h3(1Ch0)(1Ch3,2Oh0)")).toBe(2);
    expect(sphereDepthOf("Caq0h1()()()()")).toBe(4);
  });

  it("returns codes deepest-first, one per sphere depth", () => {
    const mol = OCL.Molecule.fromSmiles("CCO");
    mol.ensureHelperArrays(OCL.Molecule.cHelperRings);
    const codes = atomEnvironmentCodes(mol, 0, 4);
    expect(codes).toHaveLength(4);
    expect(sphereDepthOf(codes[0])).toBe(4); // deepest first
    expect(sphereDepthOf(codes[3])).toBe(1); // shallowest last
  });
});
