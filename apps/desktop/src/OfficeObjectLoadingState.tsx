// The Office editor's loading state as React renders it until the MainWindow chunk resolves.
// Keep it light (App.tsx imports it statically) and in step with index.html's inline loader.
import type { ReactElement } from "react";
import { OFFICE_OBJECT_LOADING_BACKGROUND, officeObjectLoadingMessage } from "./officeObjectLoading";

export function OfficeObjectLoadingState({ containerApp }: { containerApp: string }): ReactElement {
  return (
    <div
      className="office-object-loading"
      role="status"
      aria-live="polite"
      style={{
        position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
        margin: 0, background: OFFICE_OBJECT_LOADING_BACKGROUND, color: "#4d5860",
        font: "13px system-ui, -apple-system, \"Segoe UI\", sans-serif"
      }}
    >
      {officeObjectLoadingMessage(containerApp)}
    </div>
  );
}
