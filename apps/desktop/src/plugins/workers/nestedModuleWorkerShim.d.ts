export function installNestedModuleWorkerShim(
  platform?: "windows" | "macos" | "linux" | "web",
  scope?: Pick<typeof globalThis, "Worker" | "location" | "URL" | "Blob">
): void;
