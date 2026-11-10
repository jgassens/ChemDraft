import type { ToolsetLayoutState } from "@chemdraft/toolset-registry";
import { dismissMainToolbarMigrationNotice, mainToolbarMigrationNoticePending, resetMainToolbarGroups } from "./toolbarLayoutState";

/** Mount beside the app's existing AnalyzerNoticeBanner, outside the document viewport.
 *  onChange must use the existing commit/persist layout path for both reset and dismissal. */
export function MainToolbarMigrationNotice({ state, onChange }: {
  state: ToolsetLayoutState;
  onChange: (state: ToolsetLayoutState) => void;
}) {
  if (!mainToolbarMigrationNoticePending(state)) return null;
  return <div role="status" className="main-toolbar-migration-notice" data-palette-control="true">
    Your toolbar layout was rearranged into groups.{" "}
    <button type="button" onClick={() => onChange(resetMainToolbarGroups(state))}>Reset to default</button>
    <button type="button" aria-label="Dismiss toolbar layout notice" onClick={() => onChange(dismissMainToolbarMigrationNotice(state))}>Dismiss</button>
  </div>;
}
