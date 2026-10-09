import { describe, expect, it } from "vitest";

import { nativeArtToolForCommand } from "./documentWorkflow";

type Point = { x: number; y: number };
type PathNode = {
  point: Point;
  inControl?: Point;
  outControl?: Point;
};

const tolerance = 1e-9;

function orbitalPathNodes(commandId: string): readonly PathNode[] {
  const nodes = nativeArtToolForCommand(commandId)?.data.pathNodes;
  if (!nodes) {
    throw new Error(`${commandId} must define path nodes`);
  }
  return nodes;
}

function expectPointEqual(actual: Point | undefined, expected: Point | undefined): void {
  expect(actual).toBeDefined();
  expect(expected).toBeDefined();
  expect(actual!.x).toBeCloseTo(expected!.x, 9);
  expect(actual!.y).toBeCloseTo(expected!.y, 9);
}

function mirrorAcrossY(point: Point, centreY: number): Point {
  return { x: point.x, y: 2 * centreY - point.y };
}

function expectMirroredPoint(actual: Point | undefined, source: Point | undefined, centreY: number): void {
  expect(source).toBeDefined();
  expectPointEqual(actual, mirrorAcrossY(source!, centreY));
}

function expectCollinearHandles(node: PathNode): void {
  expect(node.inControl).toBeDefined();
  expect(node.outControl).toBeDefined();
  const inX = node.inControl!.x - node.point.x;
  const inY = node.inControl!.y - node.point.y;
  const outX = node.outControl!.x - node.point.x;
  const outY = node.outControl!.y - node.point.y;

  expect(Math.abs(inX * outY - inY * outX)).toBeLessThanOrEqual(tolerance);
  expect(inX * outX + inY * outY).toBeLessThan(0);
}

describe("orbital lobe geometry", () => {
  it("places single-lobe tips exactly on their box edge", () => {
    for (const commandId of ["tool.lobe", "tool.shadedLobe"]) {
      const tool = nativeArtToolForCommand(commandId);
      const tip = orbitalPathNodes(commandId)[0]!;

      expect(tip.point.x).toBeCloseTo(tool!.width / 2, 9);
      expect(tip.point.y).toBeCloseTo(tool!.height, 9);
    }
  });

  it("builds the p orbital from two mirrored single-lobe contours meeting at its centre", () => {
    const lobe = nativeArtToolForCommand("tool.lobe")!;
    const singleLobe = orbitalPathNodes("tool.lobe");
    const pOrbital = nativeArtToolForCommand("tool.pOrbital")!;
    const nodes = orbitalPathNodes("tool.pOrbital");
    const centre = { x: pOrbital.width / 2, y: pOrbital.height / 2 };

    expect(pOrbital.height).toBeCloseTo(lobe.height * 2, 9);
    expect(nodes.filter((node) => node.point.x === centre.x && node.point.y === centre.y)).toHaveLength(2);
    expectPointEqual(nodes[0]?.point, centre);
    expectPointEqual(nodes[3]?.point, centre);

    // The upper p lobe has the single-lobe's exact contour. Its centre endpoint uses the second
    // coincident node, whose incoming handle completes that contour.
    expectPointEqual(nodes[0]?.outControl, singleLobe[0]?.outControl);
    expectPointEqual(nodes[1]?.point, singleLobe[1]?.point);
    expectPointEqual(nodes[1]?.inControl, singleLobe[1]?.inControl);
    expectPointEqual(nodes[1]?.outControl, singleLobe[1]?.outControl);
    expectPointEqual(nodes[2]?.point, singleLobe[2]?.point);
    expectPointEqual(nodes[2]?.inControl, singleLobe[2]?.inControl);
    expectPointEqual(nodes[2]?.outControl, singleLobe[2]?.outControl);
    expectPointEqual(nodes[3]?.inControl, singleLobe[0]?.inControl);

    // The remaining contour is its reflection about the p orbital's centre line.
    expectMirroredPoint(nodes[3]?.outControl, nodes[0]?.outControl, centre.y);
    expectMirroredPoint(nodes[4]?.point, nodes[1]?.point, centre.y);
    expectMirroredPoint(nodes[4]?.inControl, nodes[1]?.inControl, centre.y);
    expectMirroredPoint(nodes[4]?.outControl, nodes[1]?.outControl, centre.y);
    expectMirroredPoint(nodes[5]?.point, nodes[2]?.point, centre.y);
    expectMirroredPoint(nodes[5]?.inControl, nodes[2]?.inControl, centre.y);
    expectMirroredPoint(nodes[5]?.outControl, nodes[2]?.outControl, centre.y);
    expectMirroredPoint(nodes[0]?.inControl, nodes[3]?.inControl, centre.y);
  });

  it("keeps every lobe outer node smooth", () => {
    for (const [commandId, outerNodeIndexes] of [
      ["tool.lobe", [1, 2]],
      ["tool.shadedLobe", [1, 2]],
      ["tool.pOrbital", [1, 2, 4, 5]]
    ] as const) {
      const nodes = orbitalPathNodes(commandId);
      for (const index of outerNodeIndexes) {
        expectCollinearHandles(nodes[index]!);
      }
    }
  });
});
