import { useId } from "react";
import { createPageLayout, type PageLayout } from "@chemdraft/chem-core";

/** Screen scaffolding, separate from the artwork render plan and every export path. */
export function PrintPageGuideOverlay({ layout, scale = 1 }: { layout: PageLayout; scale?: number }) {
  const patternId = `print-page-${useId().replace(/:/g, "")}`;
  if (!layout.printGuides?.enabled) return null;
  const strokeWidth = 1 / scale;
  const { widthPx, heightPx } = createPageLayout(layout.printGuides.presetId, layout.orientation);
  return <svg className="cd-print-page-guides" aria-hidden="true" focusable="false"
    viewBox={`0 0 ${layout.widthPx} ${layout.heightPx}`}>
    <defs><pattern id={patternId} patternUnits="userSpaceOnUse" width={widthPx} height={heightPx}>
      <path d={`M ${widthPx} ${strokeWidth / 2} H ${strokeWidth / 2} V ${heightPx}`} fill="none" stroke="currentColor"
        strokeWidth={strokeWidth} strokeDasharray={`${strokeWidth} ${4 * strokeWidth}`} strokeLinecap="round" />
    </pattern></defs>
    <rect width={layout.widthPx} height={layout.heightPx} fill={`url(#${patternId})`} />
  </svg>;
}
