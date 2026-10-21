/**
 * Shared verbatim with the native installed-plugin bootstrap via include_str!. Keep this module
 * dependency-free JavaScript: the native server must not need a second compiler or a generated copy.
 */
export function installNestedModuleWorkerShim(
  platform = /Win/i.test(globalThis.navigator?.platform ?? "") ? "windows" : "macos",
  scope = globalThis
) {
  if (platform !== "windows" || typeof scope.Worker !== "function") return;
  const base = new URL(scope.location.href);
  // Only the desktop custom origin needs the workaround. Windows browser/dev builds stay native.
  if (base.protocol !== "http:" || base.host !== "tauri.localhost") return;

  const NativeWorker = scope.Worker;
  scope.Worker = new Proxy(NativeWorker, {
    construct(target, args, newTarget) {
      const [input, options] = args;
      if (options?.type !== "module") return Reflect.construct(target, args, newTarget);
      let url;
      try {
        url = new URL(input, base);
      } catch {
        return Reflect.construct(target, args, newTarget);
      }
      // Do not turn opaque/cross-origin URLs or credential-bearing URLs into importable modules.
      // The blob inherits this worker's CSP; its static import still goes through script-src 'self'.
      if (url.origin !== base.origin || url.protocol !== base.protocol || url.username || url.password) {
        return Reflect.construct(target, args, newTarget);
      }
      const blobUrl = scope.URL.createObjectURL(new scope.Blob([
        `import ${JSON.stringify(url.href)}; URL.revokeObjectURL(import.meta.url);`
      ], { type: "text/javascript" }));
      try {
        const worker = Reflect.construct(target, [blobUrl, options], newTarget);
        // Success revokes from inside the wrapper, after static import evaluation (including TLA).
        // A failed import never reaches that line, so release on error without consuming the event.
        worker.addEventListener("error", () => scope.URL.revokeObjectURL(blobUrl), { once: true });
        return worker;
      } catch (error) {
        scope.URL.revokeObjectURL(blobUrl);
        throw error;
      }
    }
  });
}
