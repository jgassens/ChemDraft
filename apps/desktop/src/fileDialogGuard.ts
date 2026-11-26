export const FILE_DIALOG_ALREADY_OPEN_STATUS = "A file dialog is already open";

let pending = false;
let refusalListener: ((status: string) => void) | undefined;

/** The document window shows a refused request on its status line. Returns the unsubscribe. */
export function onFileDialogRefused(listener: (status: string) => void): () => void {
  refusalListener = listener;
  return () => { if (refusalListener === listener) refusalListener = undefined; };
}

/**
 * Each native file panel holds a Rust worker until answered, and a Linux chooser can sit hidden
 * behind the window, so while one is pending a second request opens nothing: it reports
 * FILE_DIALOG_ALREADY_OPEN_STATUS and resolves `cancelled`. Released however the first one ends.
 */
export async function withOneFileDialog<T>(operation: () => Promise<T>, cancelled: T): Promise<T> {
  if (pending) {
    refusalListener?.(FILE_DIALOG_ALREADY_OPEN_STATUS);
    return cancelled;
  }
  pending = true;
  try {
    return await operation();
  } finally {
    pending = false;
  }
}
