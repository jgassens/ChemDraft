import { ensureRdkit as resolvedEnsureRdkit, setRdkitModuleLoader } from "@chemdraft/rdkit-adapter";
import { ensureRdkit } from "../../rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";

/** Worktree symlinks can resolve the bare adapter separately; share the oracle's real engine. */
export function installIsotopeTestEngine(): void {
  installRealRdkitModuleLoader();
  if (resolvedEnsureRdkit !== ensureRdkit) setRdkitModuleLoader(() => ensureRdkit());
}
