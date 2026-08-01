import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type {
  PluginIsotopeEnvelopeRequest,
  PluginIsotopeEnvelopeResult,
  PluginNameToStructureRequest,
  PluginNameToStructureResult,
  PluginStructureFromSmilesRequest,
  PluginStructureFromSmilesResult,
  PluginManifest,
  PluginPermission,
  PluginSelectionSnapshot,
  PluginStorage,
  PluginToolsetContribution
} from "@chemdraft/plugin-api";
import {
  PluginHost,
  validateTrustedPluginManifest,
  type CommandRegistry,
  type RegisterPluginOptions
} from "@chemdraft/plugin-host";

import type { DesktopToolsetDefinition } from "../toolsets";
import { PluginPanelController } from "./PluginPanelController";
import {
  computeIsotopeEnvelopeForPlugin,
  nameToStructureForPlugin,
  structureFromSmilesForPlugin
} from "./pluginChemistry";

/** Serves an isotope envelope to a plugin holding `chemistry.compute`. */
export type DesktopIsotopeEnvelopeProvider = (
  request: PluginIsotopeEnvelopeRequest
) => Promise<PluginIsotopeEnvelopeResult>;

/** Serves name → structure to a plugin holding `chemistry.compute`. */
export type DesktopNameToStructureProvider = (
  request: PluginNameToStructureRequest
) => Promise<PluginNameToStructureResult>;

/** Lays a SMILES out as a document object for a plugin holding `chemistry.compute`. */
export type DesktopStructureFromSmilesProvider = (
  request: PluginStructureFromSmilesRequest
) => Promise<PluginStructureFromSmilesResult>;

export interface DesktopPluginRuntimeOptions {
  /** Reads the current active document. Called on demand; must reflect the latest state. */
  getActiveDocument: () => ChemDraftDocument | undefined;
  /** Builds an immutable selection snapshot from current desktop state. */
  getSelection?: () => PluginSelectionSnapshot | undefined;
  /**
   * The app's stable CommandRegistry (see commands/coreCommandRegistrar). When supplied, plugin
   * commands register into the SAME registry core commands live in, so one `host.invokeCommand`
   * dispatches both — with the plugin's permission context when the command is plugin-owned.
   * Defaults to a host-private registry (tests, headless use).
   */
  commandRegistry?: CommandRegistry;
  /** Storage backend factory (the desktop passes the disk-backed one); defaults to in-memory. */
  createStorage?: (pluginId: string) => PluginStorage;
  /** Fired whenever the proposed-patch queue changes (new, accepted, rejected). */
  onProposedPatchesChanged?: () => void;
  /**
   * Serves `chemistry.compute`. Defaults to the real engine-backed implementation; injectable so tests
   * can drive the capability without standing up an analysis worker. Passing `null` withholds it, which
   * is how a host with no engines is modelled — the plugin then sees no `chemistry` API at all.
   */
  computeIsotopeEnvelope?: DesktopIsotopeEnvelopeProvider | null;
  /** Serves name → structure under the same permission and the same null-withholds rule. */
  convertNameToStructure?: DesktopNameToStructureProvider | null;
  /** Serves 2D layout under the same permission and the same null-withholds rule. */
  buildStructureFromSmiles?: DesktopStructureFromSmilesProvider | null;
  /** Injectable clock (tests pass a fixed value); defaults to wall-clock. */
  now?: () => Date | string;
}

/**
 * Manifest permissions that exist in the SDK but do not yet have a safe desktop capability broker.
 *
 * In particular, installed workers run under a CSP that blocks arbitrary external egress. Claiming
 * `network.fetch` in a manifest therefore cannot truthfully make that capability available yet. Keep
 * the permission name reserved for the future broker, but fail closed instead of reporting a grant the
 * worker cannot use.
 */
export const unavailableDesktopPluginPermissions = ["network.fetch"] as const satisfies readonly PluginPermission[];

export function getUnavailableDesktopPluginPermissions(
  manifest: Pick<PluginManifest, "permissions">
): PluginPermission[] {
  const unavailable = new Set<PluginPermission>(unavailableDesktopPluginPermissions);
  return manifest.permissions.filter((permission) => unavailable.has(permission));
}

function assertDesktopPluginPermissionsAvailable(manifest: PluginManifest): void {
  const unavailable = getUnavailableDesktopPluginPermissions(manifest);
  if (unavailable.length > 0) {
    throw new Error(
      `Plugin "${manifest.id}" declares ${unavailable.join(", ")}, but ${
        unavailable.length === 1 ? "that permission is" : "those permissions are"
      } reserved and unavailable in this ChemDraft build.`
    );
  }
}

/**
 * The persistent desktop plugin runtime: one {@link PluginHost}, the panel controller that renders
 * its reports, and the toolset-contribution stage that turns `contributes.toolsets` into desktop
 * toolbar definitions. Create it once (see `usePluginRuntime`) and feed current document/selection
 * through the provider callbacks — never rebuild it when the document, selection, page, viewport, or
 * undo history changes.
 *
 * All desktop registration paths (bundled, installed, fixture) go through {@link registerPlugin} /
 * {@link unregisterPlugin} rather than the host directly, so toolset provenance stays accurate and
 * a bad contribution rolls the whole plugin back no matter how it arrived.
 */
export interface DesktopPluginRuntime {
  host: PluginHost;
  panels: PluginPanelController;
  /**
   * Register a plugin and stage its toolset contributions: `ui.toolbar` is enforced before any
   * toolbar surface exists, duplicate toolset ids across plugins are rejected, and any failure
   * unregisters the whole plugin so half-registered state can never leak into the catalog.
   * Provenance is tracked by explicit maps, never by sniffing id prefixes.
   */
  registerPlugin(candidate: unknown, options?: RegisterPluginOptions): PluginManifest;
  /** Replace one registration transactionally; if the new contribution fails, restore the prior one. */
  replacePlugin(pluginId: string, candidate: unknown, options?: RegisterPluginOptions): PluginManifest;
  unregisterPlugin(pluginId: string): void;
  listPluginToolsets(): DesktopToolsetDefinition[];
  pluginIdForToolset(toolsetId: string): string | undefined;
  /** Notified when the plugin toolset set changes (register/unregister). Returns unsubscribe. */
  onDidChange(listener: () => void): () => void;
}

export function createPluginRuntime(options: DesktopPluginRuntimeOptions): DesktopPluginRuntime {
  const now = options.now ?? (() => new Date());
  const envelopeProvider =
    options.computeIsotopeEnvelope === undefined ? computeIsotopeEnvelopeForPlugin : options.computeIsotopeEnvelope;
  const nameProvider =
    options.convertNameToStructure === undefined ? nameToStructureForPlugin : options.convertNameToStructure;
  // Bound to the runtime's own document getter: layout needs the page it is being placed on, and a
  // plugin must not be able to name a different document than the one the host is showing.
  const structureProvider =
    options.buildStructureFromSmiles === undefined
      ? (request: PluginStructureFromSmilesRequest) =>
          structureFromSmilesForPlugin(request, options.getActiveDocument)
      : options.buildStructureFromSmiles;
  const nowIso = (): string => {
    const value = now();
    return typeof value === "string" ? value : value.toISOString();
  };

  // The host and controller reference each other: the host forwards validated reports to the
  // controller, and the controller reads manifests back off the host. Close the loop with a
  // late-bound reference so neither construction depends on the other existing first.
  let controller: PluginPanelController | undefined;
  const host = new PluginHost({
    commandRegistry: options.commandRegistry,
    getActiveDocument: options.getActiveDocument,
    getSelection: options.getSelection,
    createStorage: options.createStorage,
    onProposedPatchesChanged: options.onProposedPatchesChanged,
    showPanelReport: (pluginId, panelId, report) => {
      controller?.showReport(pluginId, panelId, report);
    },
    ...(envelopeProvider ? { computeIsotopeEnvelope: envelopeProvider } : {}),
    ...(nameProvider ? { convertNameToStructure: nameProvider } : {}),
    ...(structureProvider ? { buildStructureFromSmiles: structureProvider } : {}),
    now
  });
  controller = new PluginPanelController(host, nowIso);

  const toolsetsByPluginId = new Map<string, DesktopToolsetDefinition[]>();
  const pluginIdByToolsetId = new Map<string, string>();
  const registrations = new Map<string, { manifest: PluginManifest; options: RegisterPluginOptions }>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  const runtime: DesktopPluginRuntime = {
    host,
    panels: controller,
    registerPlugin(candidate, registerOptions = {}) {
      // Validate before touching the shared command registry, then apply the desktop capability policy.
      // This keeps `hasPermission()` honest: an unavailable permission can never reach a registered
      // plugin and momentarily appear granted.
      const validated = validateTrustedPluginManifest(candidate);
      assertDesktopPluginPermissionsAvailable(validated);
      const { manifest } = host.registerPlugin(validated, registerOptions);
      try {
        const contributed = manifest.contributes.toolsets;
        if (contributed.length > 0) {
          host.requirePermission(manifest.id, "ui.toolbar");
          for (const toolset of contributed) {
            if (pluginIdByToolsetId.has(toolset.id)) {
              throw new Error(`Plugin toolset "${toolset.id}" is already contributed by another plugin.`);
            }
          }
          const mapped = contributed.map(pluginToolsetToDefinition);
          toolsetsByPluginId.set(manifest.id, mapped);
          mapped.forEach((toolset) => pluginIdByToolsetId.set(toolset.id, manifest.id));
        }
      } catch (error) {
        // A bad toolset contribution rolls the WHOLE plugin back (commands included), so the
        // catalog can never observe a plugin that half-registered.
        host.unregisterPlugin(manifest.id);
        throw error;
      }
      registrations.set(manifest.id, { manifest, options: registerOptions });
      notify();
      return manifest;
    },
    replacePlugin(pluginId, candidate, registerOptions = {}) {
      const previous = registrations.get(pluginId);
      if (!host.getPlugin(pluginId)) {
        return runtime.registerPlugin(candidate, registerOptions);
      }
      runtime.unregisterPlugin(pluginId);
      try {
        return runtime.registerPlugin(candidate, registerOptions);
      } catch (error) {
        if (previous) {
          runtime.registerPlugin(previous.manifest, previous.options);
        }
        throw error;
      }
    },
    unregisterPlugin(pluginId) {
      host.unregisterPlugin(pluginId);
      (toolsetsByPluginId.get(pluginId) ?? []).forEach((toolset) => pluginIdByToolsetId.delete(toolset.id));
      toolsetsByPluginId.delete(pluginId);
      registrations.delete(pluginId);
      notify();
    },
    listPluginToolsets: () => [...toolsetsByPluginId.values()].flat(),
    pluginIdForToolset: (toolsetId) => pluginIdByToolsetId.get(toolsetId),
    onDidChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
  return runtime;
}

function pluginToolsetToDefinition(contribution: PluginToolsetContribution): DesktopToolsetDefinition {
  return {
    id: contribution.id,
    title: contribution.title,
    source: "plugin",
    defaultVisible: contribution.defaultVisible,
    defaultMode: "floating",
    groups: contribution.groups.map((group) => ({
      id: group.id,
      title: group.title,
      items: group.items.map((item) => ({
        commandId: item.commandId,
        title: item.title,
        // Named fallback keeps the type honest; the real icon rides on iconDataUri.
        icon: "palette",
        iconDataUri: item.iconDataUri,
        shortcutDisplay: item.shortcutDisplay,
        category: "plugin"
      }))
    })),
    preferredWindowSize: contribution.preferredWindowSize
  };
}
