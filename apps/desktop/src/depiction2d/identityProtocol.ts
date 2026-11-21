import type { StructureInspection } from "../plugins/requestWrites/structureIdentity";

export type StructureInspectionDetails = "stereochemistry" | "topology" | "graphSize" | "writeIdentity";

export type StructureInspector = (
  format: "smiles" | "molfile", value: string, stereoReference?: string, signal?: AbortSignal,
  details?: StructureInspectionDetails
) => Promise<StructureInspection>;

export interface IdentityRequest {
  id: number;
  format: "smiles" | "molfile";
  value: string;
  stereoReference?: string;
  details?: StructureInspectionDetails;
}

export type IdentityReply =
  | { id: 0; stage: "ready" }
  | { id: 0; stage: "unavailable"; message: string }
  | { id: number; stage: "result"; result: StructureInspection }
  | { id: number; stage: "error"; message: string };

export interface IdentityWorkerPort {
  postMessage(request: IdentityRequest): void;
  terminate(): void;
  ref?(): void;
  unref?(): void;
  onmessage: ((event: { data: IdentityReply }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
  onmessageerror: (() => void) | null;
}
