export interface Engine3dSidecarStatus {
  available: boolean;
  protocolVersion: number;
  source: "environment" | "bundled" | "missing" | string;
  envVar: string;
  envOverridePath?: string;
  resolvedPath?: string;
  bundledBinaryName: string;
  targetTriple: string;
}

export async function readEngine3dSidecarStatus(): Promise<Engine3dSidecarStatus | undefined> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<Engine3dSidecarStatus>("engine3d_sidecar_status");
  } catch {
    return undefined;
  }
}
