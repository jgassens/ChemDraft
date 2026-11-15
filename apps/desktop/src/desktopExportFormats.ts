import { exportFormatDescriptors, type ExportFormatDescriptor, type ExportFormatId } from "@chemdraft/export-engine";

/** Desktop CDX is provided by cdx-compat; the other formats use export-engine implementations. */
export const desktopExportFormatDescriptors: readonly ExportFormatDescriptor[] = exportFormatDescriptors.map<ExportFormatDescriptor>(descriptor =>
  descriptor.id === "cdx" ? {
    ...descriptor,
    label: "CDX (binary)",
    status: "implemented",
    warningSummary: "CDX exports the supported visible objects without native metadata. Review compatibility warnings."
  } : descriptor
);

export function getDesktopExportFormatDescriptor(id: ExportFormatId): ExportFormatDescriptor {
  const descriptor = desktopExportFormatDescriptors.find(candidate => candidate.id === id);
  if (!descriptor) throw new Error(`Unknown export format: ${id}`);
  return descriptor;
}
