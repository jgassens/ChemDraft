# Vendoring OPSIN (name → structure)

OPSIN is the name-to-structure engine. It is here because **nothing else in the tree can do it** —
checked directly rather than assumed: OpenChemLib 9.22.1 exposes no name parser (same check §8 ran for
pKa), RDKit MinimalLib has none, and there is **no JavaScript or WebAssembly port of OPSIN anywhere** —
not on npm, not on GitHub. Every wrapper in the wild (`py2opsin`, and the Python tools built on it)
shells out to Java.

That is the whole reason this directory holds a JAR instead of a `.wasm` like every other engine here.

## Pin
- Release: **`2.9.0`**, published 2026-03-15, from `dan2097/opsin`
- Artifact: `opsin-cli-2.9.0-jar-with-dependencies.jar` (13.7 MB)
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

`META-INF/maven/**` lists **eight** artifacts, but only **six ship code**. `net.java.dev.msv:xsdlib`
and `com.sun.xml.bind.jaxb:isorelax` leave `pom.properties` behind with **zero classes** — counted by
package root, not assumed. What is really redistributed:

| Bundled | Version | License | Package root |
|---|---|---|---|
| `uk.ac.cam.ch.opsin:opsin-core` | 2.9.0 | **MIT** | `uk/ac/cam` |
| `com.fasterxml.woodstox:woodstox-core` | 7.1.1 | Apache-2.0 | `com/ctc/wstx` |
| `org.apache.logging.log4j:log4j-api` **and `log4j-core`** | 2.25.3 | Apache-2.0 | `org/apache/logging` |
| `commons-io:commons-io` | 2.21.0 | Apache-2.0 | `org/apache/commons` |
| `org.codehaus.woodstox:stax2-api` | 4.2.2 | BSD-2-Clause | `org/codehaus/stax2` |
| `dk.brics:automaton` | 1.12-4 | BSD-2-Clause | `dk/brics` |

**All permissive, no copyleft.** Licences were resolved from each artifact's POM on Maven Central
(walking to the parent POM where the child declares none), not from memory. Note `log4j-core` is
present even though only `log4j-api` leaves a `pom.properties` — the stack traces prove it, and it is
what forces `java.desktop` below.

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
