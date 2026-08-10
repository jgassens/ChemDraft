The analyzers release: a property and prediction suite built around a new Molecular Inspector.

- **Molecular Inspector:** one real OS window for every analysis — open it from Analyze ▸ Molecular Inspector, with or without a selection. Reports carry full provenance: every number states its method and its inputs.
- **pKa estimation:** ionizable sites detected and scored by a graph neural network trained on measured pKa data, with a second independent method that is allowed to disagree. Values are drawn on the structure at the proton each one is about, each with a calibrated confidence interval, and acidic and basic sites are reported separately. Sites the method cannot honestly measure are withheld and say so.
- **Protonation states:** the inspector reports which species the molecule actually is at a given pH — which is what a pKa is a proxy for — including zwitterions and permanently charged species.
- **Isotope envelopes:** computed by IsoSpec and drawn as a spectrum on the m/z axis, not a table. Handles ions, adducts, neutral losses, and isotope-labelled structures, grouped under a new Mass Spec category.
- **Name to structure:** type an IUPAC name and get a structure, powered by a bundled OPSIN engine served across the plugin boundary (plugin API 0.1.1). The app says so honestly when a name cannot be parsed.
- **Joback estimates:** thermophysical property estimates (boiling point, critical properties, and more), each shown with its uncertainty rather than a bare number — and withheld for structures the method's groups cannot cover.
- **Licensing:** the app is now Apache-2.0, and bundled datasets declare their own terms.

Automatic updates are delivered via Sparkle (File ▸ Check for Updates…).
