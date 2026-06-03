import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType
} from "react";
import type { MoleculeObject } from "@chemdraft/chem-core";
import type { EditorAdapter, EditorSaveResult } from "@chemdraft/editor-adapter";
import {
  createKetcherAdapter,
  createKetcherEngineHost,
  type KetcherRuntimeApi
} from "@chemdraft/ketcher-adapter";

export interface KetcherEditorHostProps {
  molecule: MoleculeObject;
  onApply(result: EditorSaveResult): void;
  onClose(): void;
  onStatus(message: string): void;
}

type KetcherEditorComponent = ComponentType<{
  staticResourcesUrl?: string;
  structServiceProvider?: unknown;
  onInit?: (ketcher: KetcherRuntimeApi) => void;
  errorHandler?: (message: string) => void;
  disableMacromoleculesEditor?: boolean;
}>;

type StandaloneProviderConstructor = new () => unknown;

interface KetcherRuntimeModules {
  Editor: KetcherEditorComponent;
  structServiceProvider: unknown;
}

export function KetcherEditorHost({
  molecule,
  onApply,
  onClose,
  onStatus
}: KetcherEditorHostProps) {
  const [runtime, setRuntime] = useState<KetcherRuntimeModules | null>(null);
  const [adapter, setAdapter] = useState<EditorAdapter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadedObjectIdRef = useRef<string | undefined>(undefined);

  const reportKetcherError = useCallback((message: string) => {
    setError(message);
    onStatus(`Ketcher unavailable: ${message}`);
  }, [onStatus]);

  useEffect(() => {
    let active = true;

    void loadKetcherRuntime()
      .then((loadedRuntime) => {
        if (!active) {
          return;
        }
        setRuntime(loadedRuntime);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!active) {
          return;
        }
        const message = loadError instanceof Error ? loadError.message : String(loadError);
        reportKetcherError(message);
      });

    return () => {
      active = false;
    };
  }, [reportKetcherError]);

  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      const message = event.error instanceof Error ? event.error.message : event.message;
      if (message) {
        reportKetcherError(message);
      }
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
      if (message) {
        reportKetcherError(message);
      }
    };

    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, [reportKetcherError]);

  const handleKetcherInit = useCallback((ketcher: KetcherRuntimeApi) => {
    const engine = createKetcherEngineHost(ketcher);
    setAdapter(createKetcherAdapter({ engine, implementationVersion: ketcher.version ?? "3.12.0" }));
    onStatus("Ketcher molecule editor connected");
  }, [onStatus]);

  useEffect(() => {
    if (!adapter) {
      return;
    }

    let active = true;
    setBusy(true);
    void adapter
      .loadObject({ object: molecule })
      .then(() => {
        if (!active) {
          return;
        }
        loadedObjectIdRef.current = molecule.id;
        setError(null);
        onStatus(`Loaded ${molecule.id} into Ketcher`);
      })
      .catch((loadError: unknown) => {
        if (!active) {
          return;
        }
        const message = loadError instanceof Error ? loadError.message : String(loadError);
        setError(message);
        onStatus(`Ketcher load failed: ${message}`);
      })
      .finally(() => {
        if (active) {
          setBusy(false);
        }
      });

    return () => {
      active = false;
    };
  }, [adapter, molecule, onStatus]);

  const handleApply = useCallback(async () => {
    if (!adapter) {
      onStatus("Ketcher editor is still connecting");
      return;
    }

    setBusy(true);
    try {
      const result = await adapter.saveObject();
      onApply(result);
      onStatus(
        result.warnings.length > 0
          ? `Applied Ketcher edit with ${result.warnings.length} warning(s)`
          : "Applied Ketcher molecule edit"
      );
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      setError(message);
      onStatus(`Ketcher save failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }, [adapter, onApply, onStatus]);

  const Editor = runtime?.Editor;

  return (
    <section className="ketcher-editor-host" aria-label="Active molecule editor">
      <div className="ketcher-editor-header">
        <span className="ketcher-editor-title">Molecule Editor</span>
        <span className="ketcher-editor-object">{molecule.id}</span>
        <button
          type="button"
          className="ketcher-editor-apply"
          onClick={() => void handleApply()}
          disabled={busy || !adapter}
          data-command-id="editor.applyActiveMoleculeEdit"
        >
          Apply
        </button>
        <button
          type="button"
          className="ketcher-editor-close"
          onClick={onClose}
          aria-label="Close molecule editor"
          data-command-id="editor.closeActiveMoleculeEdit"
        />
      </div>
      <div className="ketcher-editor-frame" data-ketcher-state={ketcherState(runtime, adapter, error)}>
        {Editor && runtime ? (
          <Editor
            staticResourcesUrl={staticResourcesUrl()}
            structServiceProvider={runtime.structServiceProvider}
            onInit={handleKetcherInit}
            errorHandler={reportKetcherError}
            disableMacromoleculesEditor
          />
        ) : (
          <div className="ketcher-editor-message">
            {error ?? "Loading Ketcher molecule editor..."}
          </div>
        )}
      </div>
      <div className="ketcher-editor-status" aria-live="polite">
        {error ?? (busy ? "Ketcher working..." : loadedObjectIdRef.current ? "Ketcher ready" : "Waiting for Ketcher")}
      </div>
    </section>
  );
}

async function loadKetcherRuntime(): Promise<KetcherRuntimeModules> {
  installKetcherBrowserGlobals();

  const raphaelModule = await import("raphael");
  installKetcherRequireShim(new Map([["raphael", defaultExport(raphaelModule)]]));

  const [reactModule, standaloneModule] = await Promise.all([
    import("ketcher-react"),
    import("ketcher-standalone"),
    import("ketcher-react/dist/index.css")
  ]);
  const standaloneExports = standaloneModule as unknown as {
    StandaloneStructServiceProvider?: StandaloneProviderConstructor;
    default?: StandaloneProviderConstructor;
  };
  const Provider = standaloneExports.StandaloneStructServiceProvider ?? standaloneExports.default;

  if (!Provider) {
    throw new Error("StandaloneStructServiceProvider export is missing.");
  }

  return {
    Editor: reactModule.Editor as KetcherEditorComponent,
    structServiceProvider: new Provider()
  };
}

function ketcherState(
  runtime: KetcherRuntimeModules | null,
  adapter: EditorAdapter | null,
  error: string | null
): "error" | "connected" | "loading" {
  if (error) {
    return "error";
  }
  if (runtime && adapter) {
    return "connected";
  }
  return "loading";
}

function staticResourcesUrl(): string {
  return typeof globalThis.location?.origin === "string" ? globalThis.location.origin : "/";
}

function installKetcherBrowserGlobals(): void {
  const host = globalThis as typeof globalThis & {
    global?: typeof globalThis;
    process?: { env?: Record<string, string | undefined> };
  };

  host.global = host;
  host.process ??= { env: {} };
  host.process.env ??= {};
}

function installKetcherRequireShim(modules: ReadonlyMap<string, unknown>): void {
  const host = globalThis as typeof globalThis & {
    require?: (id: string) => unknown;
  };

  if (typeof host.require === "function") {
    return;
  }

  Object.defineProperty(host, "require", {
    configurable: true,
    value(id: string) {
      if (modules.has(id)) {
        return modules.get(id);
      }

      throw new Error(`Dynamic require is unavailable in the ChemDraft Ketcher host: ${id}`);
    }
  });
}

function defaultExport(module: unknown): unknown {
  return isRecord(module) && "default" in module ? module.default : module;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
