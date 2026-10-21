# Vendoring OPSIN (name → structure)

OPSIN is the name-to-structure engine. It is here because **nothing else in the tree can do it** —
checked directly rather than assumed: OpenChemLib 9.22.1 exposes no name parser (same check §8 ran for
pKa), RDKit MinimalLib has none, and there is **no JavaScript or WebAssembly port of OPSIN anywhere** —
not on npm, not on GitHub. Every wrapper in the wild (`py2opsin`, and the Python tools built on it)
shells out to Java.

That is the whole reason this directory holds a JAR instead of a `.wasm` like every other engine here.

## Pin
- Release: **`2.9.0`**, published 2026-03-15, from `dan2097/opsin`
- Artifact: `opsin-cli-2.9.0-jar-with-dependencies.jar` (13.7 MB) — the upstream file name; it is
  vendored here as `opsin-cli-2.9.0.jar`
- SHA-256: `a39cd589eb46709b1ca1e086a36a50f7c93f294cff7ade7c87c2da06efb6e5ac`
  (the **shipped** jar, which differs from upstream only by the code signing described below; the
  test that pins this line requires it to hold the bare hash)
- Upstream SHA-256: `c2e29326c281f87b59a05d934d8589adac6e9d17b95b984931b3e739111b360f` — the jar as
  released by `dan2097/opsin`
- License: **MIT**, © 2017 Daniel Lowe — `OPSIN-LICENSE.txt`, vendored beside the artifact
- **Modified only by code signing.** Apple's notary service unpacks jars and walks the Mach-O files
  inside; the first 0.3.2 submission was rejected on exactly four entries — JNA's
  `com/sun/jna/darwin-{aarch64,x86-64}/libjnidispatch.jnilib` and jna-inchi's
  `darwin-{aarch64,x86-64}/libjnainchi.dylib`. `scripts/sign-opsin-runtime.sh` re-signs those four
  with our Developer ID identity and repacks them into the jar; **every other entry is byte-identical
  to upstream**, so "is this really OPSIN 2.9.0?" stays answerable by diffing entry contents against
  the upstream release. No classes, resources, or manifests are touched. The old temptation to strip
  `log4j-core` (see the runtime section — it costs ~20 MB) remains resisted: signing is forced by
  notarization, repackaging for size is a choice.

> ⚠️ **It must be the `cli` jar, not `core`.** OPSIN 2.9.0 removed `main` from `NameToStructure`, and
> `opsin-core-…-jar-with-dependencies.jar` (4.9 MB) has **no `Main-Class`** — it cannot be run at all.
> Only `opsin-cli` carries `Main-Class: uk.ac.cam.ch.wwmm.opsin.Cli`. The 9 MB size difference is not a
> choice.

## What is actually inside the shaded jar

`jar-with-dependencies` means shading, and shading **clobbers `META-INF`** — the jar's own
`LICENSE`/`NOTICE` files are whichever were written last (Jackson's and Commons IO's), not a complete
set. So redistributing it obliges *us* to carry the notices, the same way `NOTICE` already does for
RDKit, IsoSpec, and InChI.

`META-INF/maven/**` lists **22** artifacts. `opsin-cli` and `opsin-inchi` are thin shells over the
rest, and two of the 22, `net.java.dev.msv:xsdlib` and `com.sun.xml.bind.jaxb:isorelax`, are **not**
empty: woodstox-core 7.1.1 shades MSV 2022.7 (`msv-core` and `xsdlib`), isorelax 20090621 and
relaxngDatatype 20020414 into `com/ctc/wstx/shaded/` — **735 classes** (counted with `unzip -l`;
`msv_core/` 667, `msv/org_isorelax/` 38, `msv/relaxng_datatype/` 16, `msv/org_jp_gr_xml/` 13,
`msv/xsd_util/` 1) — and those two leave `pom.properties` behind. `msv-core` and `relaxngDatatype`
leave none, so they are listed only here. (The versions are read from woodstox-core's own POM inside
the jar: `version.msv` 2022.7, `isorelax` 20090621, `relaxngDatatype` 20020414.) The 176 `*.aut` files
at the jar root (`unsignedShort.aut`, `Arabic.aut`, …) are not OPSIN's and not MSV's: they are the
prebuilt datatype automata that `dk.brics.automaton.Datatypes` loads through the class loader, so they
belong to `dk.brics:automaton`. OPSIN's own 46 serialised automata are under
`uk/ac/cam/ch/wwmm/opsin/resources/serialisedAutomata/`. What is really redistributed, with each
licence read on 2026-10-21 from the source named in the last column:

| Bundled | Version | License | Package root | Where the licence was read |
|---|---|---|---|---|
| `uk.ac.cam.ch.opsin:opsin-core` (and `opsin-inchi`, `opsin-cli`) | 2.9.0 | **MIT** | `uk/ac/cam` | `opsin` parent POM 2.9.0 on Maven Central (`<license>` MIT); `OPSIN-LICENSE.txt` |
| `com.fasterxml.woodstox:woodstox-core` | 7.1.1 | Apache-2.0 | `com/ctc/wstx` | its own POM inside the jar |
| `org.apache.logging.log4j:log4j-api` **and `log4j-core`** | 2.25.3 | Apache-2.0 | `org/apache/logging` | their own POMs inside the jar |
| `commons-io:commons-io` | 2.21.0 | Apache-2.0 | `org/apache/commons/io` | no `<license>` in its POM; inherited from `commons-parent` 91 → `org.apache:apache` 35 on Maven Central |
| `commons-cli:commons-cli` | 1.11.0 | Apache-2.0 | `org/apache/commons/cli` | same parent chain as `commons-io` |
| `org.codehaus.woodstox:stax2-api` | 4.2.2 | BSD-2-Clause, © 2010- FasterXML.com | `org/codehaus/stax2` | its own POM inside the jar; `META-INF/LICENSE` of `stax2-api-4.2.2-sources.jar` names the Simplified BSD licence with holder FasterXML.com, year 2010-, but carries no text, so `NOTICE` Appendix A.6 reproduces the standard template with that holder |
| `dk.brics:automaton` | 1.12-4 | **BSD-3-Clause** (three conditions: the third bars use of the author's name), © 2001-2022 Anders Moeller — corrects the earlier BSD-2-Clause record | `dk/brics` | its own POM inside the jar says only "BSD"; the text is `COPYING` at `github.com/cs-au-dk/dk.brics.automaton` (branch master, read 2026-10-21), reproduced in `NOTICE` Appendix A.5 |
| `net.java.dev.msv:msv-core` (shaded by woodstox-core) | 2022.7 | BSD-3-Clause, © 2001-2013 Oracle and/or its affiliates; **one file family is under the Apache Software License 1.1** (see the xsdlib row); text in `NOTICE` Appendix A.1 | `com/ctc/wstx/shaded/msv_core/` (everything except `datatype/`) | `msv` parent POM 2022.7 on Maven Central (`<license><name>BSD</name>`); `LICENSE.md` of `github.com/xmlark/msv` (GitHub reports BSD-3-Clause; it opens "Copyright 2001-2013 Oracle and/or its affiliates. All rights reserved. Redistribution and use in source and binary forms, with or without modification, are permitted provided that…"); the same header is in the `msv-core-2022.7-sources.jar` files; `LICENSE.md` read from `raw.githubusercontent.com/xmlark/msv/main/LICENSE.md` on 2026-10-21 and reproduced verbatim in `NOTICE` Appendix A.1 |
| `net.java.dev.msv:xsdlib` (shaded by woodstox-core) | 2022.7 | BSD-3-Clause, © 2001-2013 Oracle and/or its affiliates — **plus the Apache Software License, Version 1.1**, © 1999-2002 The Apache Software Foundation, on 28 of the 30 classes of `com.sun.msv.datatype.regexp` (an Xerces-derived regular-expression engine; `InternalImpl` and `InternalImpl$1` carry the Oracle BSD-3 header) | `com/ctc/wstx/shaded/msv_core/datatype/` (150 classes) and `msv/xsd_util/XmlChars` | its own `pom.xml` inside the jar (`<license><name>BSD</name>`); headers of `xsdlib-2022.7-sources.jar`: `datatype/xsd/XSDatatype.java` carries the Oracle BSD-3 text, `datatype/regexp/Op.java` opens "The Apache Software License, Version 1.1 … Copyright (c) 1999-2002 The Apache Software Foundation. All rights reserved."; `Token.java` carries the identical header. The full header is reproduced verbatim in `NOTICE` Appendix A.2 |
| `com.sun.xml.bind.jaxb:isorelax` (shaded by woodstox-core) | 20090621 | MIT (project statement; 9 of the 42 source files carry the MIT text, holders Kohsuke KAWAGUCHI and MURATA Makoto, 2001) | `com/ctc/wstx/shaded/msv/org_isorelax/` (`org.iso_relax`) and `msv/org_jp_gr_xml/` (`jp.gr.xml.relax`) | `iso-relax.sourceforge.net`: "All the source code and binaries are available under the MIT license (see inside the distribution jar file for details.)"; SourceForge lists the project as "MIT License". Second try (2026-10-21) at a primary text: `isorelax-20090621-sources.jar` has no licence file (only `META-INF/MANIFEST.MF`), but nine `org/iso_relax/dispatcher` sources, e.g. `SchemaProvider.java`, open with `Copyright 2001 Kohsuke KAWAGUCHI` (two with `MURATA Makoto, KAWAGUCHI Kohsuke`) and the standard MIT permission text, reproduced in `NOTICE` Appendix A.4. The other 33 files, including all of `jp.gr.xml.relax`, carry no header, and the distribution jar's own licence file (which the project page points to) was not found; the licence stays "MIT per the project page", the holders are those named in the nine headers. The CDDL/GPL notice at the top of its POM is that file's own header, not a statement about the library |
| `relaxngDatatype:relaxngDatatype` (shaded by woodstox-core) | 20020414 | **BSD-3-Clause**, © 2001 Thai Open Source Software Center Ltd | `com/ctc/wstx/shaded/msv/relaxng_datatype/` (`org.relaxng.datatype`) | `org/relaxng/datatype/helpers/DatatypeLibraryLoader.java` in `relaxngDatatype-20020414-sources.jar` (Maven Central) opens "Copyright (c) 2001, Thai Open Source Software Center Ltd. All rights reserved." followed by the three-condition BSD text (the third bars use of the Thai Open Source Software Center Ltd's name); the shaded jar contains that class (`.../relaxng_datatype/helpers/DatatypeLibraryLoader.class`). The other nine sources in that jar carry no header, so the text is evidenced by one file of the artifact, and independently by `copying.txt` of `github.com/relaxng/jing-trang` (same terms, "2001-2003"). The 20020414 POM and the upstream `pom.xml` (`<license><name>BSD</name>`) only say "BSD". Text reproduced in `NOTICE` Appendix A.3; sources named James Clark and Kohsuke Kawaguchi as authors |
| `net.java.dev.jna:jna` | 5.10.0 | **LGPL-2.1-or-later OR Apache-2.0** (dual; we take it under Apache-2.0) | `com/sun/jna`, plus `com/sun/jna/*/libjnidispatch*` natives | `jna` 5.10.0 POM on Maven Central lists both; the `LICENSE` at tag `5.10.0` of `java-native-access/jna` says "licensed under the LGPL, version 2.1 or later, or (from version 4.0 onward) the Apache License, version 2.0 … You can freely decide which license you want to apply" |
| `io.github.dan2097:jna-inchi-api` and `jna-inchi-core` (Java wrapper) | 1.3.1 | **LGPL-2.1-or-later** — **copyleft** | `io/github/dan2097/jnainchi` | `jna-inchi` 1.3.1 parent POM on Maven Central (`<license>` "GNU Lesser General Public License (LGPL), Version 2.1 or later"); `README.md` at tag `jna-inchi-1.3.1`: "licensed under the GNU Lesser General Public License v2.1 or later" |
| `io.github.dan2097:jna-inchi-{darwin-aarch64,darwin-x86-64,linux-aarch64,linux-arm,linux-x86,linux-x86-64,win32-x86,win32-x86-64}` (native binaries) | 1.3.1 | distributed under the jna-inchi project's **LGPL-2.1-or-later**; the library inside is InChI (next row) | `darwin-*/libjnainchi.dylib`, `linux-*/libjnainchi.so`, `win32-*/jnainchi.dll` | the per-platform POMs inherit the `jna-inchi` parent |
| **InChI** library inside those natives | 1.07.2 (the Linux binary self-identifies as `InChI version 1, Software 1.07.2 (API Library)`; `jnainchi_build.props` says `inchi_version=1.07.2`) | **MIT**, © 2024 InChI Project | the `libjnainchi` natives | `LICENSE` at tag `v1.07.2` of `github.com/IUPAC-InChI/InChI` (the upstream repository of the InChI Trust and IUPAC working groups). Whether each native was built from exactly that tag is jna-inchi's claim, not something verified here |

**This is not "all permissive".** Two components are copyleft: the `jna-inchi` Java wrapper and its
native binaries (LGPL-2.1-or-later, no alternative offered), and JNA, which is dual-licensed so the
LGPL is optional and ChemDraft elects Apache-2.0. The LGPL obligations for `jna-inchi` — carry the
licence text, say so, and offer the exact source — are addressed in `NOTICE` (written source offer) and by
`META-INF/LGPL2.1` inside the jar (a copy of the LGPL 2.1 text; the jar's `META-INF` is otherwise
whichever notices were shaded last). The InChI library is MIT, which asks only that its notice travel
with it; `NOTICE` carries it. Source availability for `jna-inchi` 1.3.1: Maven Central has a sources jar for `jna-inchi-api`
(`jna-inchi-api-1.3.1-sources.jar`) but **none for `jna-inchi-core`**. The source of `jna-inchi-core`
(including the native-build glue) and of the eight native artifacts exists only at the upstream tag
`jna-inchi-1.3.1` of `github.com/dan2097/jna-inchi`, which is therefore the source the offer in
`NOTICE` points to. Licences were resolved from the POMs on Maven Central and the upstream
repositories named above (walking to the parent POM where the child declares none), not from memory.
Note `log4j-core` is present even though only `log4j-api` leaves a `pom.properties` — the stack traces
prove it, and it is what forces `java.desktop` below.

The jar bundles natives for platforms ChemDraft does not run on (Linux, BSD, Solaris, ARM, Windows
x86/aarch64 …); they are inert here but ship as upstream built them (the four darwin natives carry only our signature, see above), which is why the table lists them by family.
The bundled jlink runtime is separate and covered in `NOTICE`.

## The bundled runtime

macOS ships no JRE — `/usr/bin/java` is a stub that prints "Unable to locate a Java Runtime" — so
detecting a system Java would leave this feature off for most users. A trimmed runtime is `jlink`ed and
shipped instead.

```bash
jlink --add-modules java.base,java.compiler,java.desktop,java.management,java.naming,java.rmi,java.scripting,java.sql,jdk.unsupported \
      --strip-debug --no-header-files --no-man-pages --compress=zip-9 \
      --output <dest>
```

**47 MB.** The module list is `jdeps --print-module-deps --ignore-missing-deps` over the jar, and it is
deliberately the conservative one: a hand-minimised `java.base,java.xml,java.logging,java.desktop` set
also runs and is 46 MB, but it was only ever proven against one SMILES conversion, and the 1 MB saved
is not worth a runtime that might fail on OPSIN's CML or InChI paths.

`java.desktop` is the expensive module and it is **not** OPSIN's doing: `log4j-core` reaches
`java.beans.PropertyChangeEvent`, and without it the JVM dies with `ClassNotFoundException` before
OPSIN parses anything. Dropping to `java.base,java.xml,java.logging` gives a 35 MB runtime that does
not work.

**Per platform.** A jlink image runs only on the OS it was built on, so each installer carries a
runtime built on that OS: `scripts/build-opsin-runtime.mjs` (the `.sh` delegates to it) finds a JDK via
`JAVA_HOME`, `PATH`, Homebrew's keg, or the standard Windows JDK install locations, and the launcher is
`bin/java` on macOS/Linux and `bin/java.exe` on Windows. First Windows build: Temurin 21.0.12 →
48 MB, smoke-tested `benzene → C1=CC=CC=C1`.

## The CLI protocol, measured

Names on stdin, newline-delimited; one output line per input line. `-n` makes it correlatable:

```
$ printf 'benzene\nxyzzy-not-a-name\ncaffeine\n' | java -jar opsin-cli-2.9.0.jar -o smi -n
C1=CC=CC=C1<TAB>benzene
<TAB>xyzzy-not-a-name
N1(C)C(=O)N(C)C=2N=CN(C)C2C1=O<TAB>caffeine
```

- **stdout**: `SMILES<TAB>name`. A name it cannot parse yields an **empty SMILES**, never a missing
  line — so failure is detected by an empty first field, and input and output stay aligned.
- **stderr**: a banner line (`Run the jar using the -h flag…`), plus one diagnostic per failure.
- **exit code is 0 whether or not names failed.** Exit status must not be used to decide success.

> ⚠️ **A name containing a tab or a newline corrupts the protocol** — a newline reads as two names, a
> tab forges the delimiter. Callers must reject control characters in the input name before writing it
> to stdin. This is a correctness requirement, not defensive style.

Startup is ~0.4 s wall for a whole batch in one JVM, so one invocation per conversion is affordable and
no persistent process is needed.

Flags worth knowing: `-o smi|extendedsmi|cml|inchi|stdinchi|stdinchikey`, `-s` to ignore stereo OPSIN
cannot interpret, `-r`/`-w` for radicals, `-f` for a more detailed failure reason.
