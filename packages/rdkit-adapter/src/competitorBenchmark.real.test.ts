/**
 * The contract states where this method stands against the alternatives, and states it accurately.
 *
 * Until this landed, `ionizationContract()` published accuracy relative to nothing — "MAE 1.13" tells a
 * reader whether the number is small, not whether it is good. The risk in fixing that is the opposite one:
 * a comparison that quietly flatters. So these tests pin the direction of the comparison, not just its
 * presence, and they fail if the transcribed figures drift from their published sources.
 */
import { describe, expect, it } from "vitest";

import {
  COMPETITOR_BENCHMARK,
  EXTERNAL_VALIDATION,
  ionizationContract
} from "./ionization";

const NOVARTIS = "novartis_qupkake_pka.sdf";
const LITERATURE = "literature_qupkake_pka.sdf";

describe("the competitor comparison in the contract", () => {
  it("keeps the transcribed figures at their published values", () => {
    // Baltruschat & Czodrowski 2020 Table 2, and QupKake 2024 Figure 3b. Hand-transcribed, so pinned.
    const byName = new Map(COMPETITOR_BENCHMARK.map((entry) => [entry.name, entry]));
    expect(byName.get("ChemAxon Marvin V20.1.0")).toMatchObject({
      novartisMae: 0.856, novartisRmse: 1.166, literatureMae: 0.566, literatureRmse: 0.865
    });
    expect(byName.get("OPERA V2.5")).toMatchObject({ novartisMae: 2.274, literatureMae: 1.737 });
    expect(byName.get("QupKake")).toMatchObject({ novartisRmse: 0.79, literatureRmse: 0.54 });
    expect(byName.get("Schrodinger Epik Classic")).toMatchObject({ novartisRmse: 1.16 });
    // Every row must carry a citation, or the figure is unverifiable.
    for (const entry of COMPETITOR_BENCHMARK) {
      expect(entry.citationId, entry.name).toMatch(/baltruschat-czodrowski-2020|qupkake-2024/);
    }
  });

  it("cites both sources it transcribes from", () => {
    const ids = ionizationContract().citations.map((entry) => entry.id);
    expect(ids).toContain("baltruschat-czodrowski-2020");
    expect(ids).toContain("qupkake-2024");
  });

  it("reads OUR figures from the artifact rather than restating them", () => {
    // The contract's own doc records that hand-typed external figures went stale twice.
    const claims = ionizationContract().accuracyClaims;
    const novartis = EXTERNAL_VALIDATION.perSet[NOVARTIS]!;
    const literature = EXTERNAL_VALIDATION.perSet[LITERATURE]!;
    expect(claims.some((c) => c.value === novartis.mae)).toBe(true);
    expect(claims.some((c) => c.value === literature.mae)).toBe(true);
    expect(novartis.rmse).toBeGreaterThan(0);
    expect(literature.rmse).toBeGreaterThan(0);
  });

  it("states that this method is behind, and does not bury it", () => {
    const text = [
      ...ionizationContract().conventions,
      ...ionizationContract().accuracyClaims.map((c) => c.basis)
    ].join(" ");
    expect(text).toMatch(/LAST BUT ONE|BEHIND EVERY ONE OF THEM/);
    expect(text, "names the tool a reader most likely already has").toMatch(/Marvin/);
    expect(text, "quantifies the gap rather than gesturing at it").toMatch(/0\.34/);
    // And the direction must be arithmetically true, not just asserted.
    const marvin = COMPETITOR_BENCHMARK.find((e) => e.name.startsWith("ChemAxon Marvin"))!;
    expect(EXTERNAL_VALIDATION.perSet[NOVARTIS]!.mae).toBeGreaterThan(marvin.novartisMae!);
    expect(EXTERNAL_VALIDATION.perSet[LITERATURE]!.mae).toBeGreaterThan(marvin.literatureMae!);
    // OPERA is the one it beats; if that ever reverses, the claim must be rewritten.
    const opera = COMPETITOR_BENCHMARK.find((e) => e.name.startsWith("OPERA"))!;
    expect(EXTERNAL_VALIDATION.perSet[NOVARTIS]!.mae).toBeLessThan(opera.novartisMae!);
    expect(EXTERNAL_VALIDATION.perSet[LITERATURE]!.mae).toBeLessThan(opera.literatureMae!);
  });

  it("also states what it does that the more accurate methods do not", () => {
    const conventions = ionizationContract().conventions.join(" ");
    expect(conventions).toMatch(/in-process/);
    expect(conventions, "the speed contrast that motivates the trade").toMatch(/2\.36 s/);
    expect(conventions, "site detection is measured, which none of them publish").toMatch(/91\.6%/);
    expect(conventions, "carbon acids are a capability QupKake lacks").toMatch(/carbon acids/i);
  });
});
