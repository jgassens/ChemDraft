import type { AssistantStructureInspection } from "../assistant/AssistantToolContext";

export type StructureInspector = (
  format: "smiles" | "molfile", value: string, stereoReference?: string, signal?: AbortSignal
) => Promise<AssistantStructureInspection>;

export interface IdentityRequest {
  id: number;
  format: "smiles" | "molfile";
  value: string;
  stereoReference?: string;
}

export type IdentityReply =
  | { id: 0; stage: "ready" }
  | { id: 0; stage: "unavailable"; message: string }
  | { id: number; stage: "result"; result: AssistantStructureInspection }
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
