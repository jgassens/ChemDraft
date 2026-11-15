/** Extract the existing ADR-0010 failure result without importing runtime ownership. */
export function pluginCommandFailure(result: unknown): string | undefined {
  if (result !== null && typeof result === "object" && "ok" in result && (result as { ok: unknown }).ok === false) {
    const error = (result as { error?: { message?: string; code?: string } }).error;
    return error?.message ?? error?.code ?? "unknown error";
  }
  return undefined;
}
