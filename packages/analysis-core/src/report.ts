/**
 * The provenance report (PLANS.md §9 Release 1, §10).
 *
 * "A copyable/exportable provenance report" — the artifact that makes Release 1's numbers reviewable
 * by someone who was not watching them being computed. It answers, for every value on screen: which
 * molecule is this about, which method produced it, what convention did that method choose, and what
 * did the run decline to answer.
 *
 * Two decisions worth stating.
 *
 * **Grouping reads `classification.claim`.** §2 says the enums are "for display and grouping" and the
 * flags are what code branches on. This module is the display side of that bargain and the only place
 * a claim class decides anything — everything behavioural here reads the flags instead.
 *
 * **Declined methods get their own section rather than being omitted.** A report that silently drops
 * what it could not compute is how "TPSA unavailable" becomes indistinguishable from "TPSA not asked
 * for". §10 is blunt about which of those is the dangerous one.
 *
 * Engine- and UI-neutral: it consumes an `AnalysisRun` and emits a small section model plus text and
 * Markdown renderings. The desktop maps the same model onto its panel renderer.
 */
import {
  requiresConventionDisclosure,
  requiresEmpiricalProvenance,
  type Classification
} from "./classification";
import { interpretationChangesIdentity, type MolecularInterpretation } from "./interpretation";
import { statusHasValue, type AnalysisResult, type AnalysisRun } from "./results";
import { unit as unitDefinition, unitSymbol, type UnitId } from "./units";
import { ionizationBand, ionizationFigureSvg } from "./ionizationFigure";

/**
 * The category a section belongs to in a grouped view, when that is not simply its own title.
 *
 * The mass-spectrometry sections — the ion series, the isotope envelope, and the mass methods that
 * declined — are three sections because they render differently, but one subject. A reader looking for
 * "the mass spec stuff" should find it in one place rather than in three scattered categories.
 *
 * Sections without one stand alone, which is the common case.
 */
export const MASS_SPEC_CATEGORY = "Mass Spec";

export interface ReportRow {
  label: string;
  value: string;
  /** Present when the value depends on a named convention the reader should see (§2). */
  note?: string;
}

/**
 * One set of named choices, and every method that made the same ones.
 *
 * Grouped rather than listed per method because the sets are shared heavily — the nine adducts name
 * one identical set, the seven neutral losses another — and a report that repeats a four-line
 * disclosure nine times is the "disclosure nobody reads has stopped disclosing" failure that the
 * note-hoisting in `keyValueSection` already exists to avoid.
 */
export interface ReportConventionGroup {
  /** Display labels of the methods sharing this set, in the order the report shows them. */
  appliesTo: string[];
  conventions: string[];
}

/**
 * A stick spectrum: positions along an axis, each with an intensity.
 *
 * Carried as numbers rather than as a pre-rendered table because the surfaces want different things
 * from it — a reader wants the shape of the isotope pattern, and the clipboard wants the values, since
 * a chart does not paste into a notebook. Both come from this one section.
 */
export interface ReportSpectrumSection {
  kind: "spectrum";
  title: string;
  category?: string;
  positions: number[];
  intensities: number[];
  positionUnit: UnitId;
  intensityUnit: UnitId;
  /** What the numbers are and are not — rendered under the plot, not left to the reader to infer. */
  caption?: string;
  /** Decimals the positions can defend; the axis and the table both honour it. */
  positionDecimals?: number;
  /**
   * What the axes are called, e.g. "Mass" / "Intensity".
   *
   * Carried so the pasted table keeps saying "Mass (Da)" rather than degrading to a generic
   * "Position (Da)" just because the screen now draws a plot. The clipboard output is unchanged by
   * this section existing.
   */
  positionLabel?: string;
  intensityLabel?: string;
}

export type AnalysisReportSection =
  | { kind: "keyValue"; title: string; category?: string; rows: ReportRow[] }
  | { kind: "table"; title: string; category?: string; columns: string[]; rows: string[][] }
  | { kind: "text"; title: string; category?: string; body: string }
  | { kind: "conventions"; title: string; category?: string; groups: ReportConventionGroup[] }
  /** A finished picture. Static by design: it renders in an <img>, so it can carry no script. */
  | { kind: "svg"; title: string; category?: string; svg: string; caption?: string }
  | ReportSpectrumSection;

export interface ReportInterpretation {
  id: string;
  label: string;
  /** The one most results were computed against — what the panel's disclosure line names. */
  active: boolean;
  changesIdentity: boolean;
  /** One line per transformation, in ledger order. */
  ledger: string[];
}

export interface AnalysisReport {
  title: string;
  /** Every interpretation the run used. More than one means the "— change" affordance has somewhere to go. */
  interpretations: ReportInterpretation[];
  sections: AnalysisReportSection[];
  /** Engine name, version, and artifact hashes — the line that makes a number reproducible. */
  engineSummary: string;
  fingerprint: string;
}

/**
 * Most peaks any one distribution renders as table rows.
 *
 * A rendering budget, not a truncation of the data: the `DistributionResult` keeps every peak, and any
 * report that hits this cap says so in the section title. Drug-like molecules produce 9–42 peaks at the
 * engine's default threshold, so this only engages for the large end of what the app accepts.
 */
export const MAX_RENDERED_DISTRIBUTION_PEAKS = 40;

// --- value formatting ----------------------------------------------------------------------------

function formatNumber(value: number, decimalPlaces?: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (decimalPlaces === undefined) return String(value);
  return value.toFixed(decimalPlaces);
}

function formatScalar(result: Extract<AnalysisResult, { kind: "scalar" }>): string {
  if (result.value === null) return "—";
  const symbol = unitSymbol(result.unit);
  const number = formatNumber(result.value, result.decimalPlaces);
  const spread = scalarSpread(result);
  const value = spread ? `${number} ${spread}` : number;
  return symbol ? `${value} ${symbol}` : value;
}

/**
 * The `± 12.9` on an estimate, or nothing.
 *
 * A predicted boiling point printed as a bare "382.6 K" is indistinguishable from a measured one, and
 * §8a's whole separation of `prediction` from `descriptor` is about not letting that happen. So the
 * spread travels with the number rather than living in provenance a reader may never open.
 *
 * Only for an uncertainty carrying a magnitude **in the result's own unit**: a percentage or a
 * differently-dimensioned figure would be arithmetic nonsense rendered as `± n`, and an interval
 * without a central magnitude has nothing to append. Those still reach the reader through the
 * conventions and the method contract; they just do not get to masquerade as a symmetric error bar.
 */
function scalarSpread(result: Extract<AnalysisResult, { kind: "scalar" }>): string {
  const usable = result.uncertainties.find(
    (entry) => entry.value !== undefined && entry.unit === result.unit
  );
  return usable ? `± ${formatNumber(usable.value!, result.decimalPlaces)}` : "";
}



/**
 * A spectrum's column heading: "Mass (Da)", but plain "m/z" rather than "m/z (m/z)".
 *
 * An axis whose label already *is* its unit stutters when the symbol is appended anyway, and the
 * isotope envelope hits exactly that case as soon as it reports an ion.
 */
function axisHeader(label: string, id: UnitId): string {
  const symbol = unitSymbol(id);
  return !symbol || symbol === label ? label : `${label} (${symbol})`;
}

/**
 * The short marker that tells a reader the number is a choice, not a fact about the molecule.
 *
 * Each note names the section that actually answers it. "see Provenance" used to be the pointer for
 * both, and for convention-dependent values it pointed at a table of method ids and versions that
 * never said which convention was chosen — a disclosure that told the reader to look somewhere the
 * answer was not.
 */
function conventionNote(classification: Classification): string | undefined {
  if (requiresEmpiricalProvenance(classification)) return "calibrated method — see Provenance";
  if (requiresConventionDisclosure(classification)) return "convention-dependent — see Conventions";
  return undefined;
}

function row(result: AnalysisResult, value: string, label = result.label): ReportRow {
  // Deliberately NOT also explaining what the `±` measures here. That is a stated convention on the
  // method's contract, so the Conventions section already says it once — and putting it on every row
  // would break the note-hoisting below for any section mixing methods that carry an uncertainty with
  // methods that do not, turning one hoisted line into a column of repeated text.
  const note = conventionNote(result.classification);
  return { label, value, ...(note ? { note } : {}) };
}

/**
 * A key-value section, with a note every one of its rows shares hoisted into the title.
 *
 * Nine adduct rows each ending "· convention-dependent — see Provenance" is a wall of identical text
 * that pushes the numbers off the edge of the panel, and a disclosure nobody reads has stopped
 * disclosing. Hoisting only when the note is *unanimous* keeps it per-row wherever a section mixes
 * calibrated and uncalibrated values — Composition, where the masses are noted and the formula is not.
 */
function keyValueSection(title: string, rows: ReportRow[], category?: string): AnalysisReportSection {
  const notes = new Set(rows.map((entry) => entry.note ?? ""));
  const shared = notes.size === 1 ? [...notes][0] : "";
  if (!shared) return { kind: "keyValue", title, ...(category ? { category } : {}), rows };
  return {
    kind: "keyValue",
    title: `${title} — ${shared}`,
    ...(category ? { category } : {}),
    rows: rows.map(({ label, value }) => ({ label, value }))
  };
}

/**
 * Drop the interpretation suffix from a row label when the whole report is about one interpretation.
 *
 * A derived result is labelled "Crippen logP · largest organic fragment · Na removed" so it stays
 * legible beside the declined source result. Under an override there is no source result to sit
 * beside, and the header already says "Computed on: largest organic fragment · Na removed" — so every
 * row repeating it is noise that pushes the actual values off the edge of the panel.
 */
function labelStripper(activeLabel: string | undefined, singleInterpretation: boolean) {
  const suffix = activeLabel ? ` \u00b7 ${activeLabel}` : "";
  return (result: AnalysisResult): string =>
    singleInterpretation && suffix.length > 0 && result.label.endsWith(suffix)
      ? result.label.slice(0, -suffix.length)
      : result.label;
}

// --- ledger prose --------------------------------------------------------------------------------

/** One human-readable line per transformation, built from the ledger rather than written by hand. */
export function ledgerLines(interpretation: MolecularInterpretation): string[] {
  return interpretation.transformations.map((step) => {
    const parts: string[] = [];
    if (step.componentsRemoved.length > 0) parts.push(`removed ${step.componentsRemoved.join(", ")}`);
    if (step.componentsRetained.length > 0) parts.push(`kept ${step.componentsRetained.join(", ")}`);
    if (step.chargeChanges !== 0) {
      parts.push(`${Math.abs(step.chargeChanges)} charge${Math.abs(step.chargeChanges) === 1 ? "" : "s"} removed`);
    }
    if (step.hydrogenChanges !== 0) {
      const direction = step.hydrogenChanges > 0 ? "added" : "removed";
      parts.push(`${Math.abs(step.hydrogenChanges)} hydrogen${Math.abs(step.hydrogenChanges) === 1 ? "" : "s"} ${direction}`);
    }
    if (step.tautomerChanged) parts.push("tautomer changed");
    for (const feature of step.unrepresentableFeatures) parts.push(`⚠ ${feature}`);
    return parts.length > 0 ? `${step.name}: ${parts.join("; ")}` : step.name;
  });
}

// --- the builder ---------------------------------------------------------------------------------

function isKind<K extends AnalysisResult["kind"]>(kind: K) {
  return (result: AnalysisResult): result is Extract<AnalysisResult, { kind: K }> => result.kind === kind;
}

/** The interpretation the most results were computed against; ties break toward `source`. */
function activeInterpretationId(run: AnalysisRun): string {
  const counts = new Map<string, number>();
  for (const result of run.results) {
    if (result.status !== "ok") continue;
    counts.set(result.interpretationId, (counts.get(result.interpretationId) ?? 0) + 1);
  }
  let best = run.interpretations[0]?.id ?? "source";
  let bestCount = -1;
  for (const interpretation of run.interpretations) {
    const count = counts.get(interpretation.id) ?? 0;
    if (count > bestCount) {
      best = interpretation.id;
      bestCount = count;
    }
  }
  return best;
}

export function buildAnalysisReport(run: AnalysisRun, options: { title?: string } = {}): AnalysisReport {
  const active = activeInterpretationId(run);
  // `partial` belongs with the rendered results, not the declined ones. It means "here are values, and
  // here is what I could not do" — a result that computed three of histidine's four sites still has
  // three values to show. Filtering on `=== "ok"` dropped all of them and left the category missing
  // from the report entirely, which is precisely the "TPSA unavailable is indistinguishable from TPSA
  // not asked for" failure this module's header is about. `statusHasValue` is the existing predicate
  // for exactly this distinction; each section renders its own shortfall alongside its values.
  const ok = run.results.filter((result) => statusHasValue(result.status));
  const declined = run.results.filter((result) => !statusHasValue(result.status));
  const sections: AnalysisReportSection[] = [];
  const displayLabel = labelStripper(
    run.interpretations.find((entry) => entry.id === active)?.label,
    new Set(run.results.map((result) => result.interpretationId)).size <= 1
  );

  // --- identity -----------------------------------------------------------------------------
  const identifiers = ok.filter(isKind("identifier"));
  if (identifiers.length > 0) {
    sections.push(keyValueSection("Identity", identifiers.map((result) => row(result, result.value ?? "—", displayLabel(result)))));
  }

  // --- composition --------------------------------------------------------------------------
  const composition = ok.find(isKind("composition"));
  const massRows = ok
    .filter(isKind("scalar"))
    .filter((result) => result.classification.claim === "composition" && result.unit !== "thomson")
    .map((result) => row(result, formatScalar(result), displayLabel(result)));

  if (composition || massRows.length > 0) {
    const rows: ReportRow[] = [];
    if (composition) {
      rows.push({ label: "Formula", value: composition.formula ?? "—" });
      rows.push({ label: "Formal charge", value: String(composition.formalCharge ?? "—") });
      if (composition.radicalElectronCount > 0) {
        rows.push({ label: "Radical electrons", value: String(composition.radicalElectronCount) });
      }
      if (composition.hasExplicitIsotopes) {
        rows.push({ label: "Isotope labels", value: "present — reflected in the formula and masses" });
      }
    }
    sections.push(keyValueSection("Composition", [...rows, ...massRows]));
  }

  // Components get their own table only when there is more than one — a single-component molecule
  // does not need a table restating its own formula.
  const componentCount = composition?.components.reduce((total, entry) => total + entry.multiplicity, 0) ?? 0;
  if (composition && componentCount > 1) {
    sections.push({
      kind: "table",
      title: `Components (${componentCount})`,
      columns: ["Formula", "Charge", "Count"],
      rows: composition.components.map((component) => [
        component.formula,
        component.charge > 0 ? `+${component.charge}` : String(component.charge),
        String(component.multiplicity)
      ])
    });
  }

  // --- ions -------------------------------------------------------------------------------------
  // Split out by unit rather than by claim: an m/z is a mass-to-charge ratio, which is a different
  // dimension from every other number in the report, and a dimension is a real distinction rather
  // than another classification axis. Positions only — the section carries no intensities, because
  // which ions a spectrum actually shows is not something this knows (PLANS.md §9, Release 2).
  const scalars = ok.filter(isKind("scalar"));
  const ions = scalars.filter((result) => result.unit === "thomson");
  if (ions.length > 0) {
    sections.push(
      keyValueSection(
        "Ions (m/z)",
        ions.map((result) => row(result, formatScalar(result), displayLabel(result))),
        MASS_SPEC_CATEGORY
      )
    );
  }

  // --- descriptors and predictions ------------------------------------------------------------
  const descriptors = scalars.filter(
    (result) => result.classification.claim === "descriptor" && result.unit !== "thomson"
  );
  const predictions = scalars.filter(
    (result) => result.classification.claim === "prediction" && result.unit !== "thomson"
  );

  if (predictions.length > 0) {
    sections.push(keyValueSection("Predicted properties", predictions.map((result) => row(result, formatScalar(result), displayLabel(result)))));
  }
  if (descriptors.length > 0) {
    sections.push(keyValueSection("Descriptors", descriptors.map((result) => row(result, formatScalar(result), displayLabel(result)))));
  }

  // --- ionizable sites ------------------------------------------------------------------------
  // A table with one row per SITE, never a single "the pKa" for the molecule. Collapsing a polyprotic
  // structure to one number is the first thing that makes a pKa wrong, and the result is a list
  // precisely so the report cannot do it.
  //
  // Every row carries where its number came from, because they do not all come from the same place:
  // one method, two methods weighted by their measured accuracy, or no value at all for a site that is
  // recognised but never titrates.
  for (const ionization of ok.filter(isKind("ionization"))) {
    // The figure first, then the table. A pKa is about one hydrogen on one atom, and a reader who has
    // to map "atom 7" onto a structure in their head has been handed a number without its subject.
    if (ionization.depiction && ionization.sites.length > 0) {
      const bands = ionization.confidenceBands;
      // One annotation per ATOM, carrying every rung it has. An amphoteric nitrogen has two values at
      // very different pH, and drawing one of them beside a structure while the table below shows both
      // is worse than drawing neither — the reader has no way to know something is missing.
      const byAtom = new Map<number, typeof ionization.sites>();
      for (const site of ionization.sites) {
        if (site.pKa === null) continue;
        byAtom.set(site.ionizableAtomIndex, [...(byAtom.get(site.ionizableAtomIndex) ?? []), site]);
      }
      const annotations = [...byAtom.entries()].map(([atomIndex, rungs]) => {
        // Most acidic rung first, which is titration order: the highest acid charge loses its proton
        // at the lowest pH.
        const ordered = [...rungs].sort((a, b) => b.acidCharge - a.acidCharge);
        const widest = Math.max(...ordered.map((site) => site.spread ?? 0));
        return {
          atomIndex,
          text: ordered
            .map((site) =>
              site.spread === undefined
                ? formatNumber(site.pKa!, 2)
                : `${formatNumber(site.pKa!, 2)} ± ${formatNumber(site.spread, 2)}`
            )
            .join(" / "),
          // The widest rung's band, so a confident value never hides an unreliable one beside it.
          band: bands ? ionizationBand(widest === 0 ? undefined : widest, bands) : ("unknown" as const),
          tone:
            ordered.length > 1
              ? ("both" as const)
              : ordered[0]!.transition
        };
      });
      const svg = ionizationFigureSvg({
        structure: ionization.depiction,
        annotations,
        title: `Ionizable sites of ${displayLabel(ionization)}`
      });
      if (svg) {
        sections.push({
          kind: "svg",
          title: "Ionizable sites",
          svg,
          // The caption carries what the colours mean and what the drawn hydrogen is, because the
          // figure is the first thing read and the contract is the last.
          //
          // Every number here is READ FROM THE RESULT, including the two MAEs. They used to be typed
          // into this string — "MAE 0.5" and "MAE 2.2" — and `git log -S` traces them to the RETIRED
          // forest's calibration as it stood in August 2026. The shipping model's figures are 0.36 and
          // 1.25, so the caption overstated its own worst-case error by nearly 2x, and the same report
          // printed different numbers for the same quantity a few sections down. The partition is
          // named alongside them, which §9a requires and the old string did not do at all.
          caption:
            "Red is an acidic pKa (that atom losing its drawn proton); blue is a basic pKa (the pKa of " +
            "its conjugate acid, the number usually meant by an amine's pKa). The ring around each atom " +
            "is confidence" +
            (bands
              ? `, from the method's measured accuracy at that interval: green within ±${formatNumber(
                  bands.good,
                  1
                )}, amber to ±${formatNumber(bands.poor, 1)}, red beyond. Measured on the ${
                  bands.partition
                }: mean absolute error ${formatNumber(bands.tightestQuartileMae, 2)} in the green band and ${formatNumber(
                  bands.widestQuartileMae,
                  2
                )} in the red`
              : "") +
            "."
        });
      }
    }

    // Macroscopic first: it is what a titration measures and what a reference table lists, so it is
    // the number a reader came for. The per-site values below it are microscopic and are NOT the same
    // quantity — glycine's tabulated 9.6 equals no single one of them.
    if (ionization.macroscopic && ionization.macroscopic.pKa.length > 0) {
      const macro = ionization.macroscopic;
      const caveats: string[] = [];
      if (macro.zwitterionic) {
        caveats.push(
          "this molecule has both an acidic and a basic site, so it forms a zwitterion — measured " +
            "over thirteen polyprotic molecules, that case carries a mean error of 2.0 log units " +
            "against 0.3 for the rest, because the microscopic model underestimates how strongly the " +
            "two sites pull on each other"
        );
      }
      if (macro.inconsistency > 1) {
        caveats.push(
          `routes to the same microstate disagree by up to ${formatNumber(macro.inconsistency, 1)} log ` +
            "units, which is thermodynamically impossible and bounds what these values are worth"
        );
      }
      // Both sections share a category so the caveat groups WITH the numbers. Left to stand alone it
      // became its own entry in the panel's sidebar — a disclosure a reader can browse past, which is
      // the failure this module's header calls out by name.
      const macroCategory = "Macroscopic pKa";
      sections.push(
        keyValueSection(
          `Macroscopic pKa (${macro.microstates} microstates)`,
          macro.pKa.map((value, index) => ({
            label: `pKa${index + 1}`,
            value: formatNumber(value, 2)
          })),
          macroCategory
        )
      );
      // The distribution goes BEFORE the caveat text, so the caveat sits under both and applies to
      // both — it is derived from the same microstate energies and is no more trustworthy than they are.
      if (macro.distribution && macro.distribution.charges.length > 0) {
        const distribution = macro.distribution;
        const percent = (fraction: number): string =>
          fraction >= 0.001 ? `${formatNumber(100 * fraction, 1)}%` : "<0.1%";
        sections.push(
          keyValueSection(
            `Species at pH ${formatNumber(distribution.pH, 1)}`,
            [
              ...distribution.charges.map((entry) => ({
                label:
                  entry.charge === 0
                    ? "no net charge"
                    : `${entry.charge > 0 ? "+" : "−"}${Math.abs(entry.charge)}`,
                value: percent(entry.fraction)
              })),
              // Spelled out only when it differs, which is exactly when it matters: for a zwitterion the
              // net-zero population carries charges on both ends and does not behave like a neutral
              // molecule. Glycine is 99.5% net-neutral and 0.0004% uncharged.
              ...(distribution.fractionNetNeutral - distribution.fractionUncharged > 0.001
                ? [
                    {
                      label: "of which carries no charge at all",
                      value: percent(distribution.fractionUncharged)
                    }
                  ]
                : [])
            ],
            macroCategory
          )
        );
      }
      sections.push({
        kind: "text",
        title: "About these values",
        category: macroCategory,
        body:
          "What a titration would measure, folded from the per-site values below. Those are " +
          "microscopic — one proton on one atom — and a reference table's figure equals no single " +
          "one of them." +
          (macro.distribution
            ? " The species fractions come from the same microstate free energies by mass action, so " +
              "they carry the same uncertainty as the values above. Where a net-zero population is " +
              "split out, the remainder is zwitterionic — charged at both ends rather than uncharged, " +
              "which is the difference a permeability argument turns on."
            : "") +
          (caveats.length > 0 ? ` Treat with care: ${caveats.join("; ")}.` : "")
      });
    } else if (ionization.macroscopicDeclined) {
      sections.push({
        kind: "text",
        title: "Macroscopic pKa",
        category: "Macroscopic pKa",
        body: `Not computed. ${ionization.macroscopicDeclined}`
      });
    }

    if (ionization.sites.length > 0) {
      sections.push({
        kind: "table",
        title: `${displayLabel(ionization)} (${ionization.sites.length} site${
          ionization.sites.length === 1 ? "" : "s"
        })`,
        columns: ["Atom", "Site", "Transition", "pKa", "Basis"],
        rows: ionization.sites.map((site) => [
          String(site.ionizableAtomIndex),
          site.siteType,
          // Spelled out, never left to be inferred from the value's size.
          site.transition === "acidic" ? "loses H⁺" : "gains H⁺",
          // The interval is not decoration and never gets dropped: a bare pKa reads as a measurement.
          site.pKa === null
            ? "not titratable"
            : site.spread === undefined
              ? formatNumber(site.pKa, 2)
              : `${formatNumber(site.pKa, 2)} ± ${formatNumber(site.spread, 2)}`,
          site.agreement
            ? `${site.basis} of ${site.agreement.methods.join(" + ")}, ` +
              `differing by ${formatNumber(site.agreement.span, 2)}`
            : (site.derivation ?? site.basis)
        ])
      });
    }

    // Sites the method knows are there and cannot score. Reported as their own rows rather than
    // omitted: a site missing from the table above reads as "there is nothing here".
    if (ionization.unassessed.length > 0) {
      sections.push({
        kind: "table",
        title: "Ionizable sites not assessed",
        columns: ["Atoms", "Reason"],
        rows: ionization.unassessed.map((entry) => [entry.atomIndices.join(", "), entry.reason])
      });
    }
  }

  // --- distributions --------------------------------------------------------------------------
  // A table of peaks, not a plot: the report is a text artifact that has to survive the clipboard, and
  // the panel renders the same model. The truncation goes in the title rather than a footnote — a
  // truncated distribution whose truncation is not stated reads exactly like a complete one.
  for (const distribution of ok.filter(isKind("distribution"))) {
    if (distribution.positions.length === 0) continue;
    const covered = distribution.truncation.coveredProbability;

    // The engine's own truncation is one thing; this is a second, purely presentational one. A
    // 400-heavy-atom structure is within the app's budget and can produce hundreds of peaks, and a
    // table that long is not a report. Keep the most intense, order them by mass, and say so in the
    // title — the result itself still carries every peak.
    const peaks = [...distribution.positions].map((position, index) => ({
      position,
      intensity: distribution.intensities[index] ?? 0
    }));
    const shown =
      peaks.length > MAX_RENDERED_DISTRIBUTION_PEAKS
        ? [...peaks]
            .sort((a, b) => b.intensity - a.intensity)
            .slice(0, MAX_RENDERED_DISTRIBUTION_PEAKS)
            .sort((a, b) => a.position - b.position)
        : peaks;

    const parts = [`${peaks.length} peaks`];
    if (covered !== undefined) parts.push(`${(covered * 100).toFixed(4)}% of the distribution`);
    if (shown.length < peaks.length) parts.push(`showing the ${shown.length} most intense`);

    sections.push({
      kind: "spectrum",
      title: `${displayLabel(distribution)} (${parts.join(", ")})`,
      category: MASS_SPEC_CATEGORY,
      positions: shown.map((peak) => peak.position),
      intensities: shown.map((peak) => peak.intensity),
      positionUnit: distribution.positionUnit,
      intensityUnit: distribution.intensityUnit,
      positionDecimals: 5,
      // Read off the unit rather than fixed: an ion's envelope is reported as m/z, and an axis headed
      // "Mass" over m/z values is a mislabelled plot in the one case where the distinction is the
      // whole point (at 2+ the peak spacing halves, which is how charge state is read).
      positionLabel: distribution.positionUnit === "thomson" ? "m/z" : "Mass",
      intensityLabel: "Intensity",
      // The disclosure belongs on the picture. A stick spectrum looks exactly like a measured one,
      // and nothing else on screen would tell a reader that it is not.
      caption:
        "Theoretical isotope distribution — not a predicted mass spectrum. No instrument response, " +
        "no adduct, no fragmentation."
    });
  }

  // --- declined -------------------------------------------------------------------------------
  // Split by subject, not moved wholesale. Most declines a reader sees ARE mass methods — an adduct on
  // a charged structure, a loss the composition cannot supply — and they belong with the ions they
  // qualify. But a declined Crippen logP is not a mass-spec fact, and filing it under Mass Spec would
  // be worse than leaving it where it was.
  const declineRow = (result: AnalysisResult): string[] => [
    displayLabel(result),
    result.status,
    result.applicability.reasons[0] ?? result.warnings[0]?.message ?? "no reason recorded"
  ];
  const isMassMethod = (result: AnalysisResult): boolean =>
    result.methodId.startsWith("rdkit.mz.") || result.methodId === "isospec.isotope-envelope";
  const massDeclines = declined.filter(isMassMethod);
  const otherDeclines = declined.filter((result) => !isMassMethod(result));

  if (massDeclines.length > 0) {
    sections.push({
      kind: "table",
      // Distinct from the general "Not computed" below. Two sections sharing a title reads as a
      // duplicated heading in the flat text and Markdown exports, and breaks lookup by title.
      // Parenthesised without a digit on purpose, so `splitSectionTitle` keeps it as part of the name
      // rather than peeling it off as a computed detail.
      title: "Not computed (mass spec)",
      category: MASS_SPEC_CATEGORY,
      columns: ["Property", "Status", "Reason"],
      rows: massDeclines.map(declineRow)
    });
  }
  if (otherDeclines.length > 0) {
    sections.push({
      kind: "table",
      title: "Not computed",
      columns: ["Property", "Status", "Reason"],
      rows: otherDeclines.map(declineRow)
    });
  }

  // --- warnings -------------------------------------------------------------------------------
  // Run-level warnings always; result-level warnings only from results that succeeded. A declined
  // result's warning *is* its reason, and "Not computed" above already carries it — repeating it here
  // would make the report look twice as alarming as the run actually was.
  const notices = [...run.warnings, ...ok.flatMap((result) => result.warnings)];
  if (notices.length > 0) {
    sections.push({
      kind: "table",
      title: "Notices",
      columns: ["Severity", "Code", "Message"],
      rows: notices.map((warning) => [warning.severity, warning.code, warning.message])
    });
  }

  // --- provenance -----------------------------------------------------------------------------
  const contracts = new Map<string, AnalysisResult>();
  for (const result of run.results) if (!contracts.has(result.methodId)) contracts.set(result.methodId, result);
  sections.push({
    kind: "table",
    title: "Provenance",
    columns: ["Property", "Method", "Version", "Interpretation"],
    rows: [...contracts.values()].map((result) => [
      displayLabel(result),
      result.methodId,
      result.methodVersion,
      result.interpretationId
    ])
  });

  // --- conventions ----------------------------------------------------------------------------
  // What every "convention-dependent — see Conventions" note points at, and the section that makes
  // that note true. Built from the conventions carried on the results, so a run rendered from cache
  // shows the conventions it was computed under rather than whatever the current engine would choose.
  //
  // Sits after Provenance because it is prose: for a full 61-property run it is the longest section in
  // the report, and putting it ahead of the compact tables would bury them.
  //
  // Only results that produced a value. A declined method's reason is its story and "Not computed"
  // already tells it; listing conventions for numbers that were never shown would bury the ones that
  // were.
  const conventionGroups = new Map<string, ReportConventionGroup>();
  for (const result of ok) {
    if (result.conventions.length === 0) continue;
    const key = JSON.stringify(result.conventions);
    const group = conventionGroups.get(key);
    const label = displayLabel(result);
    if (!group) {
      conventionGroups.set(key, { appliesTo: [label], conventions: [...result.conventions] });
    } else if (!group.appliesTo.includes(label)) {
      group.appliesTo.push(label);
    }
  }
  if (conventionGroups.size > 0) {
    sections.push({ kind: "conventions", title: "Conventions", groups: [...conventionGroups.values()] });
  }

  const citations = new Map<string, string>();
  for (const result of run.results) {
    for (const citation of result.citations) {
      const parts = [citation.authors, citation.title, citation.year ? String(citation.year) : undefined]
        .filter(Boolean)
        .join(". ");
      citations.set(citation.id, parts);
    }
  }
  if (citations.size > 0) {
    sections.push({
      kind: "table",
      title: "References",
      columns: ["Key", "Citation"],
      rows: [...citations.entries()].sort(([a], [b]) => a.localeCompare(b))
    });
  }

  const engineSummary = run.engines
    .map((engine) => `${engine.name} ${engine.version}${engine.artifactHashes.length > 0 ? ` (${engine.artifactHashes.join(", ")})` : ""}`)
    .join("; ");

  return {
    title: options.title ?? "Molecular properties",
    interpretations: run.interpretations.map((interpretation) => ({
      id: interpretation.id,
      label: interpretation.label,
      active: interpretation.id === active,
      changesIdentity: interpretationChangesIdentity(interpretation),
      ledger: ledgerLines(interpretation)
    })),
    sections,
    engineSummary,
    fingerprint: run.fingerprint
  };
}

// --- renderers -----------------------------------------------------------------------------------

function padColumns(columns: string[], rows: string[][]): number[] {
  return columns.map((column, index) =>
    Math.max(column.length, ...rows.map((cells) => (cells[index] ?? "").length))
  );
}

/** Plain text, for the clipboard. Fixed-width columns so a pasted table stays readable in a notebook. */
export function renderReportText(report: AnalysisReport): string {
  const lines: string[] = [report.title, "=".repeat(report.title.length), ""];

  const activeInterpretation = report.interpretations.find((entry) => entry.active);
  if (activeInterpretation) {
    lines.push(`Computed on: ${activeInterpretation.label}`);
    for (const step of activeInterpretation.ledger) lines.push(`  ${step}`);
    const others = report.interpretations.filter((entry) => !entry.active);
    if (others.length > 0) {
      lines.push(`Also available: ${others.map((entry) => entry.label).join("; ")}`);
    }
    lines.push("");
  }

  for (const section of report.sections) {
    lines.push(section.title, "-".repeat(section.title.length));
    if (section.kind === "text") {
      lines.push(section.body);
    } else if (section.kind === "spectrum") {
      // A plot does not paste. The clipboard gets the values it was drawn from, at the same
      // precision, so a pasted spectrum is still checkable.
      const decimals = section.positionDecimals ?? 5;
      const positionHeader = axisHeader(section.positionLabel ?? "Position", section.positionUnit);
      const intensityHeader = axisHeader(section.intensityLabel ?? "Intensity", section.intensityUnit);
      const rows = section.positions.map((position, index) => [
        position.toFixed(decimals),
        (section.intensities[index] ?? 0).toFixed(2)
      ]);
      const widths = padColumns([positionHeader, intensityHeader], rows);
      lines.push([positionHeader, intensityHeader].map((column, index) => column.padEnd(widths[index]!)).join("  "));
      for (const cells of rows) lines.push(cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  "));
      if (section.caption) lines.push("", section.caption);
    } else if (section.kind === "conventions") {
      // Deliberately not a table: a convention is a sentence, and `padColumns` would size a column to
      // the longest one and wreck every other row in the pasted report.
      for (const group of section.groups) {
        lines.push(group.appliesTo.join(", "));
        for (const convention of group.conventions) lines.push(`  - ${convention}`);
      }
    } else if (section.kind === "keyValue") {
      const width = Math.max(0, ...section.rows.map((entry) => entry.label.length));
      for (const entry of section.rows) {
        lines.push(`${entry.label.padEnd(width)}  ${entry.value}${entry.note ? `   [${entry.note}]` : ""}`);
      }
    } else if (section.kind === "svg") {
      // A figure cannot travel as text. Its caption can, and the values it draws are in the table
      // right below it — so the paste loses the picture, never the numbers.
      if (section.caption) lines.push(section.caption);
    } else {
      const widths = padColumns(section.columns, section.rows);
      lines.push(section.columns.map((column, index) => column.padEnd(widths[index]!)).join("  "));
      for (const cells of section.rows) {
        lines.push(cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  "));
      }
    }
    lines.push("");
  }

  lines.push(`Engine: ${report.engineSummary || "unrecorded"}`);
  lines.push(`Run fingerprint: ${report.fingerprint}`);
  return lines.join("\n");
}

/** Markdown, for export into a lab notebook or an issue. */
export function renderReportMarkdown(report: AnalysisReport): string {
  const escape = (cell: string): string => cell.replace(/\|/g, "\\|");
  const lines: string[] = [`# ${report.title}`, ""];

  const activeInterpretation = report.interpretations.find((entry) => entry.active);
  if (activeInterpretation) {
    lines.push(`**Computed on:** ${activeInterpretation.label}`, "");
    for (const step of activeInterpretation.ledger) lines.push(`- ${step}`);
    const others = report.interpretations.filter((entry) => !entry.active);
    if (others.length > 0) {
      lines.push("", `_Also available: ${others.map((entry) => entry.label).join("; ")}_`);
    }
    lines.push("");
  }

  for (const section of report.sections) {
    lines.push(`## ${section.title}`, "");
    if (section.kind === "text") {
      lines.push(section.body, "");
    } else if (section.kind === "spectrum") {
      const decimals = section.positionDecimals ?? 5;
      const positionHeader = axisHeader(section.positionLabel ?? "Position", section.positionUnit);
      const intensityHeader = axisHeader(section.intensityLabel ?? "Intensity", section.intensityUnit);
      lines.push(`| ${escape(positionHeader)} | ${escape(intensityHeader)} |`, "| --- | --- |");
      for (const [index, position] of section.positions.entries()) {
        lines.push(`| ${position.toFixed(decimals)} | ${(section.intensities[index] ?? 0).toFixed(2)} |`);
      }
      lines.push("");
      if (section.caption) lines.push(`_${escape(section.caption)}_`, "");
    } else if (section.kind === "conventions") {
      for (const group of section.groups) {
        lines.push(`**${escape(group.appliesTo.join(", "))}**`, "");
        for (const convention of group.conventions) lines.push(`- ${escape(convention)}`);
        lines.push("");
      }
    } else if (section.kind === "keyValue") {
      lines.push("| Property | Value |", "| --- | --- |");
      for (const entry of section.rows) {
        const value = entry.note ? `${entry.value} _(${entry.note})_` : entry.value;
        lines.push(`| ${escape(entry.label)} | ${escape(value)} |`);
      }
      lines.push("");
    } else if (section.kind === "svg") {
      // Inlined as a data URI so a pasted report keeps its figure where the destination renders
      // Markdown images, and degrades to the alt text where it does not.
      lines.push(`![${escape(section.title)}](data:image/svg+xml;utf8,${encodeURIComponent(section.svg)})`);
      if (section.caption) lines.push("", `_${escape(section.caption)}_`);
      lines.push("");
    } else {
      lines.push(`| ${section.columns.map(escape).join(" | ")} |`);
      lines.push(`| ${section.columns.map(() => "---").join(" | ")} |`);
      for (const cells of section.rows) lines.push(`| ${cells.map(escape).join(" | ")} |`);
      lines.push("");
    }
  }

  lines.push(`_Engine: ${report.engineSummary || "unrecorded"}_`);
  lines.push("", `_Run fingerprint: \`${report.fingerprint}\`_`);
  return lines.join("\n");
}
