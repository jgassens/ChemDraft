import { desktopExportFormatDescriptors } from "./desktopExportFormats";

const knownExtensions = new Set([
  "chemdraft",
  ...desktopExportFormatDescriptors.flatMap(descriptor => descriptor.extensions.map(extension => extension.toLowerCase()))
]);

/** Remove one document/export suffix, preserving other dots in the user's name. */
export function stripExportFileExtension(filename: string): string {
  const trimmed = filename.trim().replace(/[\s.]+$/, "");
  const dot = trimmed.lastIndexOf(".");
  return dot >= 0 && knownExtensions.has(trimmed.slice(dot + 1).toLowerCase()) ? trimmed.slice(0, dot) : trimmed;
}

export function replaceExportFileExtension(filename: string, extension: string): string {
  return `${stripExportFileExtension(filename) || "Untitled"}.${extension}`;
}

/** Normalize only the proposed basename; keep macOS/Windows directory spelling intact. */
export function exportDefaultPath(defaultPath: string, extensions: readonly string[]): string {
  const separator = Math.max(defaultPath.lastIndexOf("/"), defaultPath.lastIndexOf("\\"));
  const filename = defaultPath.slice(separator + 1);
  // Keep a user-chosen alias such as .jpeg or .tiff for this format.
  const extension = extensions.find(candidate => filename.toLowerCase().endsWith(`.${candidate.toLowerCase()}`)) ?? extensions[0];
  return extension ? `${defaultPath.slice(0, separator + 1)}${replaceExportFileExtension(filename, extension)}` : defaultPath;
}
