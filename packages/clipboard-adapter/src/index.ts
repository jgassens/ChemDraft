export type ClipboardPayloadKind = "svg" | "png" | "text/plain" | "smiles" | "mol" | "rxn" | "cdxml" | "cdx";

export interface ClipboardTransferWarning {
  code: string;
  message: string;
}
