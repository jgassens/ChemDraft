/**
 * The Done / Restore-Defaults bar shown under the Main palette while in customize mode. Buttons
 * already bail out of the palette-window shell-drag check; the container carries `data-palette-control`
 * so its hint text can't start a window drag either.
 */
export function CustomizeBar({
  onDone,
  onRestoreDefaults
}: {
  onDone: () => void;
  onRestoreDefaults: () => void;
}) {
  return (
    <div className="customize-main-toolbar-bar" data-palette-control="true">
      <span className="customize-main-toolbar-hint">Drag to reorder · drag an item out to remove it</span>
      <div className="customize-main-toolbar-actions">
        <button
          type="button"
          className="customize-main-toolbar-button"
          onClick={onRestoreDefaults}
          title="Reset the Main toolbar to its default layout (also clears any rename or hide of it)"
        >
          Restore Defaults
        </button>
        <button type="button" className="customize-main-toolbar-button customize-main-toolbar-button-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
