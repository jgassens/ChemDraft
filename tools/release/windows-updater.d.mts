import type { PathOrFileDescriptor } from "node:fs";

export const RELEASE_DOWNLOAD_BASE: "https://github.com/jgassens/ChemDraft/releases/download";
export const WINDOWS_PLATFORM_KEY: "windows-x86_64-nsis";

export function loadUpdaterPublicKey(config?: PathOrFileDescriptor): string;
export function verifyUpdaterSignature(installer: Buffer, encodedSignature: string, encodedPublicKey: string): void;
