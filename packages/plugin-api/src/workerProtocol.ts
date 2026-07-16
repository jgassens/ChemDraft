/**
 * Versioned message protocol for running a bundled plugin's *execution* inside a per-plugin Web
 * Worker while its whole capability contract (selection / analysis / storage / panels /
 * active-document) crosses the worker boundary as async request/response messages (ADR-0029, M34).
 *
 * Design: one discriminated-union envelope per direction, keyed by `kind`. Correlation ids are
 * monotonic integers minted by the sender of a request; a matching response echoes the id. Every
 * payload is plain, structured-clone-safe data — never a framework object or a live reference — which
 * is exactly what makes the boundary possible (the capability API is already fully async + data-only).
 *
 * This module is framework-neutral (no React, no DOM assumptions beyond a message port) so it can live
 * behind the single `@chemdraft/plugin-api` SDK import that a plugin already uses; the worker-side
 * runtime ({@link runPluginWorker}) and the desktop-side bridge both speak this protocol.
 */

import { PluginApiVersion } from "./index";

/**
 * Protocol wire version. Bumped only on a breaking change to the message shapes below. The worker
 * announces it on startup and the host rejects a mismatch loudly rather than half-loading (M34
 * acceptance #5). It is intentionally separate from a plugin's semantic {@link PluginApiVersion}.
 */
export const PLUGIN_WORKER_PROTOCOL_VERSION = 1 as const;

/** The capability namespaces a plugin can reach across the boundary — one per capability object on
 *  {@link PluginCommandContext}. `documents` is always present on the context but its methods gate
 *  internally on `document.read` / `document.proposePatch`. */
export type PluginWorkerCapabilityNamespace = "selection" | "analysis" | "storage" | "panels" | "documents";

/** The methods each namespace exposes. The host bridge validates an incoming request against this map
 *  and rejects anything else, so a worker can never invoke an arbitrary property on a capability. */
export const PLUGIN_WORKER_CAPABILITY_METHODS: Readonly<Record<PluginWorkerCapabilityNamespace, readonly string[]>> = {
  selection: ["getSelection"],
  analysis: ["write", "list", "getLatest"],
  storage: ["get", "set", "delete", "listKeys"],
  panels: ["showReport"],
  documents: ["getActiveDocument", "proposePatch"]
} as const;

/** A serializable error crossing the boundary in either direction. Errors never travel as `Error`
 *  instances (not reliably cloneable); they are normalized to `{ code, message }`. */
export interface PluginWorkerErrorPayload {
  code: string;
  message: string;
}

/** worker → host messages. */
export type WorkerToHostMessage =
  | { kind: "ready"; protocolVersion: number; apiVersion: string }
  | {
      kind: "capabilityRequest";
      requestId: number;
      /** The command invocation this capability call belongs to; the host routes it to that
       *  invocation's real, permission-gated context. */
      commandRequestId: number;
      namespace: PluginWorkerCapabilityNamespace;
      method: string;
      args: readonly unknown[];
    }
  | { kind: "commandSettled"; commandRequestId: number; ok: true; value: unknown }
  | { kind: "commandSettled"; commandRequestId: number; ok: false; error: PluginWorkerErrorPayload };

/** host → worker messages. */
export type HostToWorkerMessage =
  | { kind: "invokeCommand"; commandRequestId: number; commandId: string }
  | { kind: "capabilityResult"; requestId: number; ok: true; value: unknown }
  | { kind: "capabilityResult"; requestId: number; ok: false; error: PluginWorkerErrorPayload }
  /** Reverse signal: a contributed panel closed (ADR-0012) so the plugin can cancel in-flight work. */
  | { kind: "panelClosed"; panelId: string }
  /** Reverse signal: drop a specific in-flight command; a late settlement for it is suppressed. */
  | { kind: "abort"; commandRequestId: number };

/** Stable error codes emitted by the boundary itself (as opposed to a plugin's own error payloads). */
export const PluginWorkerErrorCodes = {
  /** A capability the plugin's manifest does not grant was requested; the bridge refuses it. */
  CapabilityNotGranted: "PLUGIN_WORKER_CAPABILITY_NOT_GRANTED",
  /** A request named a method not in {@link PLUGIN_WORKER_CAPABILITY_METHODS}. */
  UnknownCapabilityMethod: "PLUGIN_WORKER_UNKNOWN_CAPABILITY_METHOD",
  /** A capability request arrived for a command that is not (or no longer) active. */
  NoActiveCommand: "PLUGIN_WORKER_NO_ACTIVE_COMMAND",
  /** The invoked command id has no handler registered in the worker. */
  UnknownCommand: "PLUGIN_WORKER_UNKNOWN_COMMAND",
  /** The worker was terminated (or aborted) before the command settled. */
  Terminated: "PLUGIN_WORKER_TERMINATED",
  /** The startup handshake failed a version check. */
  VersionMismatch: "PLUGIN_WORKER_VERSION_MISMATCH",
  /** The worker thread crashed. */
  WorkerCrashed: "PLUGIN_WORKER_CRASHED"
} as const;

/** A minimal message-port shape both a real worker global scope and a real main-thread `Worker`
 *  satisfy structurally (both have `postMessage` + `addEventListener("message")`). Kept here so the
 *  worker runtime and the desktop bridge — and their tests — share one transport contract. */
export interface PluginWorkerEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
}

/** The main-thread handle the bridge drives: a message port that can also surface errors and be torn
 *  down. A real `Worker` satisfies this; tests supply a linked fake. */
export interface PluginWorkerHandle extends PluginWorkerEndpoint {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "messageerror", listener: (event: unknown) => void): void;
  terminate(): void;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(value: string): Semver | undefined {
  const core = value.trim().split(/[-+]/, 1)[0];
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(core);
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Pragmatic compatibility check for the worker startup handshake: does the host's concrete
 * {@link PluginApiVersion} satisfy the range a plugin declares in its manifest `apiVersion`? Supports
 * an exact version, a caret range (`^`), or a tilde range (`~`) — the forms the repository's manifests
 * actually use (`^0.1.0`). It is deliberately a small, dependency-free subset of semver, and it is a
 * *new* check specific to the worker boundary: manifest registration in the host still does not verify
 * semantic API compatibility (AGENTS.md), so this does not change that path.
 */
export function isPluginApiVersionCompatible(declaredRange: string, hostVersion: string = PluginApiVersion): boolean {
  const host = parseSemver(hostVersion);
  if (!host) {
    return false;
  }
  const trimmed = declaredRange.trim();
  const operator = trimmed.startsWith("^") ? "^" : trimmed.startsWith("~") ? "~" : "=";
  const target = parseSemver(operator === "=" ? trimmed : trimmed.slice(1));
  if (!target) {
    return false;
  }
  if (compareSemver(host, target) < 0) {
    return false; // host predates the minimum the plugin requires
  }
  if (operator === "=") {
    return compareSemver(host, target) === 0;
  }
  if (operator === "~") {
    return host.major === target.major && host.minor === target.minor;
  }
  // Caret: for 0.x releases the minor is the compatibility boundary; otherwise the major is.
  return target.major === 0 ? host.major === 0 && host.minor === target.minor : host.major === target.major;
}

/** Validate a worker's `ready` announcement. Returns an error message on mismatch, or `undefined` when
 *  both the protocol version and the plugin's API version are compatible with this host. */
export function checkWorkerHandshake(
  message: { protocolVersion: number; apiVersion: string },
  hostApiVersion: string = PluginApiVersion
): string | undefined {
  if (message.protocolVersion !== PLUGIN_WORKER_PROTOCOL_VERSION) {
    return `Plugin worker protocol version ${message.protocolVersion} is incompatible with host protocol version ${PLUGIN_WORKER_PROTOCOL_VERSION}.`;
  }
  if (!isPluginApiVersionCompatible(message.apiVersion, hostApiVersion)) {
    return `Plugin declares apiVersion "${message.apiVersion}", which is incompatible with host API version ${hostApiVersion}.`;
  }
  return undefined;
}
