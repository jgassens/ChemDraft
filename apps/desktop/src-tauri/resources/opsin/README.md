# OPSIN build resources

The checked-in OPSIN JAR is paired with a generated `jre/` when packaging.
Never commit that runtime or a JDK. See [BUILD.md](BUILD.md) for provenance and
licenses and [the macOS release guide](../../../../../docs/releasing/macos-updates.md#intel-opsin-runtime-jdk-source-and-architecture-checks)
for the current Intel build procedure (superseding BUILD.md's manual Intel JDK setup).

On macOS, `./run-app -t x86_64-apple-darwin` automatically stages the Intel runtime.
To stage it without building the app:

```sh
node scripts/build-opsin-runtime.mjs --target x86_64-apple-darwin
```

With `JAVA_HOME` unset, this downloads the pinned Eclipse Temurin 25.0.5+8 x64
macOS JDK from Adoptium's GitHub release and checks the pinned SHA-256 before
extraction. The archive is cached in `~/Library/Caches/ChemDraft/opsin-jdk/` and
verified again on reuse. Each build extracts a temporary JDK there, uses jlink
and removes the extracted JDK afterwards. Set `JAVA_HOME` to an explicit x86_64
JDK's `Contents/Home` to bypass the download; `--arch x86_64` and
`OPSIN_TARGET_ARCH=x86_64` also select Intel (flags take precedence).

On Apple silicon, Rosetta 2 is required. The builder probes it before downloading
and reports `/usr/sbin/softwareupdate --install-rosetta --agree-to-license` if
it is missing. It runs jlink and the OPSIN smoke test under Rosetta; Intel Macs
run them natively. The selected JDK and staged JRE must both contain thin x86_64
Java launchers and JVM libraries. The release verifier also checks every loose
Mach-O inside the bundled JRE, rejecting the wrong architecture or a universal JRE.

The staging directory is shared: finish packaging one architecture before
building the other. arm64 macOS, Windows and Linux retain their existing native
JDK discovery and do not download this Intel JDK.
