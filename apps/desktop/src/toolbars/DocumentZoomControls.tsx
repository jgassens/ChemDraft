import { Icon } from "../icons";
import { DOCUMENT_ZOOM_PRESETS, documentZoomCommandId } from "../documentZoom";
import { useToolbarWidgetState } from "./toolbarWidgets";
import { usePaletteButtonInvoke } from "./toolbarCells";

export function DocumentZoomControls() {
  const { currentZoom: zoom, onInvoke } = useToolbarWidgetState();
  const percent = zoom ? zoom.scale * 100 : undefined;
  const preset = DOCUMENT_ZOOM_PRESETS.find(value => percent !== undefined && Math.abs(value - percent) < 0.000001);
  const outDisabled = !zoom || zoom.scale <= zoom.minZoom;
  const inDisabled = !zoom || zoom.scale >= zoom.maxZoom;
  const zoomOut = usePaletteButtonInvoke("view.zoomOut", onInvoke, outDisabled);
  const zoomIn = usePaletteButtonInvoke("view.zoomIn", onInvoke, inDisabled);
  return <div className="document-zoom-controls" role="group" aria-label="Document zoom" data-palette-control="true">
    <button type="button" className="icon-button" aria-label="Zoom Out" title="Zoom Out"
      disabled={outDisabled} {...zoomOut}>
      <Icon name="zoomOut" />
    </button>
    <select aria-label="Document zoom percentage" title="Document zoom percentage" disabled={!zoom}
      value={preset === undefined ? "current" : String(preset)}
      onChange={event => {
        const value = DOCUMENT_ZOOM_PRESETS.find(percent => String(percent) === event.target.value);
        if (value !== undefined) onInvoke(documentZoomCommandId(value));
      }}>
      {preset === undefined ? <option value="current" disabled>{percent === undefined ? "—" : `${Number(percent.toFixed(1))}%`}</option> : null}
      {DOCUMENT_ZOOM_PRESETS.map(value => <option key={value} value={value}>{value}%</option>)}
    </select>
    <button type="button" className="icon-button" aria-label="Zoom In" title="Zoom In"
      disabled={inDisabled} {...zoomIn}>
      <Icon name="zoomIn" />
    </button>
  </div>;
}
