# Licence texts for the naming engine's downloaded parts

ChemDraft's optional naming engine downloads the centres 1.2.1 jar
(`https://github.com/SiMolecule/centres/releases/download/1.2.1/centres.jar`, 2,291,742 bytes,
SHA-256 `6c5d5cafa9393ed7b667a2340222348cd15a9bbdd0d1b92518229f26cc5e87fb`). It is a shaded jar and
carries no licence files of its own, so the texts for what it contains ship here, in the app, and the
engine install copies them into the engine's `LICENSES/` folder. The jar runs unmodified as its own
file on the JVM; it is never merged into ChemDraft's Apache-2.0 core.

| File | Covers | Source of the text |
|---|---|---|
| `centres-BSD-2-Clause.txt` | centres 1.2.1 itself (Copyright (c) 2020, John Mayfield) | `SiMolecule/centres` tag 1.2.1, `LICENSE` |
| `beam-BSD-2-Clause.txt` | Beam 1.3.5 (`uk.ac.ebi.beam`, Copyright (c) 2013 EMBL-EBI) | `johnmay/beam`, `LICENSE` |
| `LGPL-2.1.txt` | CDK 2.9 (LGPL-2.1-or-later), source <https://github.com/cdk/cdk> | gnu.org, `old-licenses/lgpl-2.1.txt` |
| `GPL-2.0.txt` | javax.vecmath 1.5.2 (GPL-2.0 with the Classpath exception), source <https://github.com/hharrison/vecmath> | gnu.org, `old-licenses/gpl-2.0.txt` |
| `Classpath-exception.txt` | the exception that goes with the GPL-2.0 text above | OpenJDK `LICENSE` |
| `vecmath-COPYRIGHT.txt` | javax.vecmath's copyright notice (Sun Microsystems) | `hharrison/vecmath`, `COPYRIGHT.txt` |

The centres POM names LGPL-3.0 while its `LICENSE` file is BSD-2-Clause; this folder follows the
`LICENSE` file, as Orthonym's own NOTICE does. Orthonym's `LICENSE` (MIT) and `NOTICE` come from the
installed wheel's dist-info, not from here.
