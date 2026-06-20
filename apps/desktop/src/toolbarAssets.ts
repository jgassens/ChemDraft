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
  "Custom_Arrow_Equilibrium",
  "Custom_Arrow_Resonance",
  "Custom_Arrow_Retro",
  "Custom_Arrows",
  "Custom_Back",
  "Custom_Benzene",
  "Custom_Bond",
  "Custom_Bond_Bold",
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
  "Custom_Middle",
  "Custom_Minus",
  "Custom_Plus",
  "Custom_Right",
  "Custom_Rotation",
  "Custom_Select",
  "Custom_Settings",
  "Custom_Shape",
  "Custom_Shape2",
  "Custom_Square_Bracket",
  "Custom_Structure_Cleanup",
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

export const toolbarAssets = Object.fromEntries(
  toolbarAssetNames.map((name) => {
    const path = `./assets/toolbar/${name}.png`;
    const source = toolbarAssetModules[path];

    if (!source) {
      throw new Error(`Missing toolbar asset: ${path}`);
    }

    return [name, source];
  })
) as Record<ToolbarAssetName, string>;

export function toolbarAsset(name: ToolbarAssetName): string {
  return toolbarAssets[name];
}
