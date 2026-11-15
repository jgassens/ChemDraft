export const toolbarAssetNames = [
  "Art_Arc_Circular",
  "Art_Arc_Half",
  "Art_Arc_Quarter",
  "Art_Arrow",
  "Art_Bring_Forward",
  "Art_Bring_To_Front",
  "Art_Brush",
  "Art_Circle",
  "Art_Ellipse",
  "Art_Eraser",
  "Art_Eyedropper",
  "Art_Line",
  "Art_Pen",
  "Art_Pencil",
  "Art_Polyline",
  "Art_Rectangle",
  "Art_Rounded_Rectangle",
  "Art_Scissors",
  "Art_Select",
  "Art_Send_Backward",
  "Art_Send_To_Back",
  "Art_Shapes",
  "Art_Tape_Measure",
  "Art_Text",
  "Art_Wavy_Line",
  "Custom_Arrow",
  "Custom_Arrow_Bold",
  "Custom_Arrow_Curved",
  "Custom_Arrow_Curved_Pronounced",
  "Custom_Arrow_Dashed",
  "Custom_Arrow_Equilibrium",
  "Custom_Arrow_Fishhook",
  "Custom_Arrow_Fishhook_Curved",
  "Custom_Arrow_No_Reaction",
  "Custom_Arrow_Resonance",
  "Custom_Arrow_Retro",
  "Custom_Arrows",
  "Custom_Back",
  "Custom_Benzene",
  "Custom_Bond",
  "Custom_Bond_Bold",
  "Custom_Bond_Double",
  "Custom_Bond_Triple",
  "Custom_Bond_Dashed",
  "Custom_Bond_Hashed",
  "Custom_Bond_Wedge",
  "Custom_Bottom",
  "Custom_Bracket",
  "Custom_Center",
  "Custom_Chair1",
  "Custom_Chair2",
  "Custom_Colors",
  "Custom_Curved_Arrow",
  "Custom_Cyclohexane",
  "Custom_Cyclopentane",
  "Custom_Dagger",
  "Custom_Draw_Line",
  "Custom_Eraser",
  "Custom_Flip_Horizontal",
  "Custom_Flip_Vertical",
  "Custom_FormulaStyle",
  "Custom_Front",
  "Custom_Horizontal",
  "Custom_Group",
  "Custom_Lasso",
  "Custom_Left",
  "Custom_Lobe",
  "Custom_Lobe_Shaded",
  "Custom_CircleMinus",
  "Custom_CirclePlus",
  "Custom_LonePair",
  "Custom_MechanismArrow",
  "Custom_MechanismFishhook",
  "Custom_Middle",
  "Custom_Minus",
  "Custom_Plus",
  "Custom_RadicalAnion",
  "Custom_RadicalCation",
  "Custom_RadicalDot",
  "Custom_Right",
  "Custom_Rotation",
  "Custom_Select",
  "Custom_Settings",
  "Custom_Shape",
  "Custom_Shape2",
  "Custom_Spin_3D",
  "Custom_Square_Bracket",
  "Custom_Structure_Cleanup",
  "Custom_Structure_Cleanup_3D",
  "Custom_Symbol",
  "Custom_Text",
  "Custom_Tools",
  "Custom_Top",
  "Custom_Vertical",
  "Custom_Ungroup",
  "Custom_p_Orbital",
  "Custom_s_Orbital"
] as const;

export type ToolbarAssetName = (typeof toolbarAssetNames)[number];

const toolbarAssetModules = import.meta.glob<string>("./assets/toolbar/*.png", {
  eager: true,
  import: "default"
});

// Original parallel-stroke variants of the diagonal single-bond toolbar glyph.
const multipleBondAsset = (offsets: readonly number[]): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g fill="none" stroke="#000" stroke-width="2" stroke-linecap="round">${offsets.map(offset => `<path d="M ${6 + offset} ${26 + offset} L ${26 + offset} ${6 + offset}"/>`).join("")}</g></svg>`)}`;
const multipleBondAssets: Partial<Record<ToolbarAssetName, string>> = {
  Custom_Bond_Double: multipleBondAsset([-2, 2]),
  Custom_Bond_Triple: multipleBondAsset([-3, 0, 3])
};

export const toolbarAssets = Object.fromEntries(
  toolbarAssetNames.map((name) => {
    const path = `./assets/toolbar/${name}.png`;
    const source = multipleBondAssets[name] ?? toolbarAssetModules[path];

    if (!source) {
      throw new Error(`Missing toolbar asset: ${path}`);
    }

    return [name, source];
  })
) as Record<ToolbarAssetName, string>;

export function toolbarAsset(name: ToolbarAssetName): string {
  return toolbarAssets[name];
}
