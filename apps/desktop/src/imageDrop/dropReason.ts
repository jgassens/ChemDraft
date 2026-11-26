/**
 * An error whose message ChemDraft wrote for the drop status: a deadline, a size cap, a canvas that
 * stayed busy. Only these messages reach a drop status. Every other error carries text from a
 * decoder, the webview, the file system or the native side (`WebView2 decoder detail 0x123`), which
 * the status replaces with plain wording.
 */
export class DropReasonError extends Error {}

/**
 * The message of a `DropReasonError`. For any other error, `undefined`, and the error itself goes to
 * the console under `context`, so the real failure is kept where a developer can find it.
 */
export function dropErrorReason(error: unknown, context: string): string | undefined {
  if (error instanceof DropReasonError) return error.message;
  console.warn(context, error);
  return undefined;
}
