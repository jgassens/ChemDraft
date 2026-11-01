import type { Plugin3DModel } from "@chemdraft/plugin-api";

export const CBPQT = "C1c2ccc(cc2)C[n+]2ccc(cc2)-c2cc[n+](cc2)Cc2ccc(cc2)C[n+]2ccc(cc2)-c2cc[n+]1cc2";
export function pegTtf(repeats: number): string {
  const arm = `CO${"CCO".repeat(repeats)}C`;
  return `C1(${arm})=C(${arm})SC(S1)=C1SC(${arm})=C(${arm})S1`;
}

/** Place the full explicit-H guest centroid on the host centroid, with no rotation. */
export function centerGuest(input: Plugin3DModel): Plugin3DModel {
  const model = structuredClone(input);
  const centroids = model.components.map(component => {
    const center = [0, 0, 0];
    for (let i = component.atomStart; i < component.atomStart + component.atomCount; i++) {
      for (let axis = 0; axis < 3; axis++) center[axis] += model.coords[i * 3 + axis] / component.atomCount;
    }
    return center;
  });
  const guest = model.components[1];
  for (let i = guest.atomStart; i < guest.atomStart + guest.atomCount; i++) {
    for (let axis = 0; axis < 3; axis++) model.coords[i * 3 + axis] += centroids[0][axis] - centroids[1][axis];
  }
  return model;
}
