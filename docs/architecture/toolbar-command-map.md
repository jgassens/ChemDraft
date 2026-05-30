# Toolbar Command Map

This map preserves the functional identity of the custom toolbar glyphs without using vendor command names as ChemDraft API.

The source files in `Custom_Toolbar/2_Images` are treated as user-provided custom assets. Runtime actions use ChemDraft command IDs, titles, categories, descriptions, tooltips, accessible labels, and disabled-state reasons.

Current status: only `tool.select` is active. Other entries are disabled command definitions until the `editor-adapter`, `layout-engine`, `style` workflow, or selected-object workflow can perform the action honestly.

| Asset | ChemDraft command | Intended function | Status |
| --- | --- | --- | --- |
| `Custom_Select.png` | `tool.select` | Select and move document objects | Active |
| `Custom_Lasso.png` | `tool.lasso` | Lasso-select document objects | Disabled until editor adapter |
| `Custom_Eraser.png` | `tool.eraser` | Erase editable objects | Disabled until editor adapter |
| `Custom_Text.png` | `tool.text` | Place editable text | Disabled until editor adapter |
| `Custom_Bond.png` | `tool.bond` | Draw a single bond | Disabled until editor adapter |
| `Custom_Bond_Wedge.png` | `tool.wedgeBond` | Draw a solid wedge bond | Disabled until editor adapter |
| `Custom_Bond_Hashed.png` | `tool.hashedBond` | Draw a hashed wedge bond | Disabled until editor adapter |
| `Custom_Bond_Dashed.png` | `tool.dashedBond` | Draw a dashed bond | Disabled until editor adapter |
| `Custom_Bond_Bold.png` | `tool.boldBond` | Draw a bold bond | Disabled until editor adapter |
| `Custom_Draw_Line.png` | `tool.chain` | Draw a chain or line tool path | Disabled until editor adapter |
| `Custom_Cyclopentane.png` | `tool.cyclopentane` | Insert cyclopentane template | Disabled until editor adapter |
| `Custom_Cyclohexane.png` | `tool.cyclohexane` | Insert cyclohexane template | Disabled until editor adapter |
| `Custom_Benzene.png` | `tool.benzene` | Insert benzene template | Disabled until editor adapter |
| `Custom_Chair1.png` | `tool.chairCyclohexaneA` | Insert chair cyclohexane template A | Disabled until editor adapter |
| `Custom_Chair2.png` | `tool.chairCyclohexaneB` | Insert chair cyclohexane template B | Disabled until editor adapter |
| `Custom_Arrow.png` | `tool.reactionArrow` | Draw reaction arrow | Disabled until editor adapter |
| `Custom_Arrow_Resonance.png` | `tool.resonanceArrow` | Draw resonance arrow | Disabled until editor adapter |
| `Custom_Arrow_Equilibrium.png` | `tool.equilibriumArrow` | Draw equilibrium arrow | Disabled until editor adapter |
| `Custom_Arrow_Retro.png` | `tool.retroArrow` | Draw retrosynthesis arrow | Disabled until editor adapter |
| `Custom_Curved_Arrow.png` | `tool.mechanismArrow` | Draw curved mechanism arrow | Disabled until mechanism tools |
| `Custom_Arrows.png` | `tool.arrows` | Open arrow tool group later | Disabled until editor adapter |
| `Custom_Bracket.png` | `tool.bracket` | Draw curly bracket | Disabled until editor adapter |
| `Custom_Square_Bracket.png` | `tool.squareBracket` | Draw square bracket | Disabled until editor adapter |
| `Custom_Dagger.png` | `tool.dagger` | Place dagger symbol | Disabled until editor adapter |
| `Custom_Plus.png` | `tool.plus` | Place plus symbol | Disabled until editor adapter |
| `Custom_Minus.png` | `tool.minus` | Place minus symbol | Disabled until editor adapter |
| `Custom_Symbol.png` | `tool.symbol` | Open symbol tool group later | Disabled until editor adapter |
| `Custom_Shape.png` | `tool.shape` | Draw shape object | Disabled until editor adapter |
| `Custom_Shape2.png` | `tool.shapeShadow` | Draw shadow shape object | Disabled until editor adapter |
| `Custom_Lobe.png` | `tool.lobe` | Draw orbital lobe | Disabled until editor adapter |
| `Custom_Lobe_Shaded.png` | `tool.shadedLobe` | Draw shaded orbital lobe | Disabled until editor adapter |
| `Custom_p_Orbital.png` | `tool.pOrbital` | Draw p orbital | Disabled until editor adapter |
| `Custom_s_Orbital.png` | `tool.sOrbital` | Draw s orbital | Disabled until editor adapter |
| `Custom_Rotation.png` | `layout.rotate` | Rotate selected objects | Disabled until selection/layout |
| `Custom_FormulaStyle.png` | `style.formulaText` | Apply formula text styling | Disabled until style workflow |
| `Custom_Left.png` | `layout.alignLeft` | Align selected objects left | Disabled until selection/layout |
| `Custom_Center.png` | `layout.alignCenter` | Align selected objects center | Disabled until selection/layout |
| `Custom_Right.png` | `layout.alignRight` | Align selected objects right | Disabled until selection/layout |
| `Custom_Top.png` | `layout.alignTop` | Align selected objects top | Disabled until selection/layout |
| `Custom_Middle.png` | `layout.alignMiddle` | Align selected objects middle | Disabled until selection/layout |
| `Custom_Bottom.png` | `layout.alignBottom` | Align selected objects bottom | Disabled until selection/layout |
| `Custom_Horizontal.png` | `layout.distributeHorizontal` | Distribute selected objects horizontally | Disabled until selection/layout |
| `Custom_Vertical.png` | `layout.distributeVertical` | Distribute selected objects vertically | Disabled until selection/layout |
| `Custom_Flip_Horizontal.png` | `layout.flipHorizontal` | Flip selected objects horizontally | Disabled until selection/layout |
| `Custom_Flip_Vertical.png` | `layout.flipVertical` | Flip selected objects vertically | Disabled until selection/layout |
| `Custom_Front.png` | `layout.bringForward` | Bring selected objects forward | Disabled until selection/layout |
| `Custom_Back.png` | `layout.sendBackward` | Send selected objects backward | Disabled until selection/layout |
| `Custom_Colors.png` | `style.color` | Open color controls later | Disabled until style workflow |
| `Custom_Settings.png` | `tool.settings` | Open object settings later | Disabled until selection |
| `Custom_Tools.png` | `tool.toolOptions` | Open tool options later | Disabled until editor adapter |
| `Custom_Tools.png` | `tool.templateGrid` | Open template grid later | Disabled until editor adapter |
