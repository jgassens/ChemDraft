# Toolbar Command Map

This map preserves the functional identity of the custom toolbar glyphs without using vendor command names as ChemDraft API.

The source files in `Custom_Toolbar/2_Images` are treated as user-provided custom assets. Runtime actions use ChemDraft command IDs, titles, categories, descriptions, tooltips, accessible labels, and disabled-state reasons.

Current status: every command in this map is active and dispatched through the shared command registry. The only "disabled" states left are transient and selection-dependent — the align and distribute commands need two or more selected objects — which is honest feedback about the current selection, not a placeholder for unbuilt work. Shipped toolsets carry no permanently disabled buttons; see the toolbar honesty contract in `AGENTS.md`. Toolbars are data-driven end to end — see `docs/architecture/toolbars-and-toolsets.md` for the single-brain architecture, widget items, and the Customize Toolbars editor.

Commands retired rather than wired (mechanism arrows, template grid, and the duplicate/undefined entries) are listed with their reasons under "Command retirements" in `docs/shipped/README.md`; each can return through git when its feature slice lands. They are deliberately absent from this map so it cannot be read as a promise.

ChemDraw uses XML toolbar files. ChemDraft's initial native toolbar format is a typed ChemDraft toolset manifest, currently read from `apps/desktop/src/toolsets/desktop-toolsets.json` and validated through `@chemdraft/toolset-registry`. Future user-editable XML or JSON toolbar files should be added through a compatibility/import layer, not by adopting proprietary toolbar XML as the native model.

| Asset | ChemDraft command | Intended function | Status |
| --- | --- | --- | --- |
| `Custom_Select.png` | `tool.select` | Select and move document objects | Active |
| `Custom_Lasso.png` | `tool.lasso` | Lasso-select document objects | Active |
| `Custom_Eraser.png` | `tool.eraser` | Erase editable objects | Active |
| `Custom_Text.png` | `tool.text` | Place editable text | Active |
| `Custom_Bond.png` | `tool.bond` | Draw a single bond | Active |
| `Custom_Bond_Wedge.png` | `tool.wedgeBond` | Draw a solid wedge bond | Active |
| `Custom_Bond_Hashed.png` | `tool.hashedBond` | Draw a hashed wedge bond | Active |
| `Custom_Bond_Dashed.png` | `tool.dashedBond` | Draw a dashed bond | Active |
| `Custom_Bond_Bold.png` | `tool.boldBond` | Draw a bold bond | Active |
| `Custom_Draw_Line.png` | `tool.chain` | Press-drag an alkane zig-zag chain | Active |
| `Custom_Cyclopentane.png` | `tool.cyclopentane` | Insert cyclopentane template | Active |
| `Custom_Cyclohexane.png` | `tool.cyclohexane` | Insert cyclohexane template | Active |
| `Custom_Benzene.png` | `tool.benzene` | Insert benzene template | Active |
| `Custom_Chair1.png` | `tool.chairCyclohexaneA` | Insert chair cyclohexane template A | Active |
| `Custom_Chair2.png` | `tool.chairCyclohexaneB` | Insert chair cyclohexane template B | Active |
| `Custom_Arrow.png` | `tool.reactionArrow` | Draw reaction arrow | Active |
| `Custom_Arrow_Resonance.png` | `tool.resonanceArrow` | Draw resonance arrow | Active |
| `Custom_Arrow_Equilibrium.png` | `tool.equilibriumArrow` | Draw equilibrium arrow | Active |
| `Custom_Arrow_Retro.png` | `tool.retroArrow` | Draw retrosynthesis arrow | Active |
| `Custom_Bracket.png` | `tool.bracket` | Draw curly bracket | Active |
| `Custom_Square_Bracket.png` | `tool.squareBracket` | Draw square bracket | Active |
| `Custom_Dagger.png` | `tool.dagger` | Stamp `‡` (double dagger) | Active |
| `Custom_Plus.png` | `tool.plus` | Place plus symbol | Active |
| `Custom_Minus.png` | `tool.minus` | Place minus symbol | Active |
| `Custom_Symbol.png` | `tool.symbol` | Stamp `°`; opens the symbol command grid below | Active |
| `Custom_Symbol.png` | `tool.symbol.degree` | Stamp `°` | Active |
| `Custom_Symbol.png` | `tool.symbol.plusMinus` | Stamp `±` | Active |
| `Custom_Symbol.png` | `tool.symbol.angstrom` | Stamp `Å` | Active |
| `Custom_Symbol.png` | `tool.symbol.delta` | Stamp `Δ` | Active |
| `Custom_Symbol.png` | `tool.symbol.centerDot` | Stamp `·` | Active |
| `Custom_Symbol.png` | `tool.symbol.prime` | Stamp `′` | Active |
| `Custom_Lobe.png` | `tool.lobe` | Draw orbital lobe | Active |
| `Custom_Lobe_Shaded.png` | `tool.shadedLobe` | Draw shaded orbital lobe | Active |
| `Custom_p_Orbital.png` | `tool.pOrbital` | Draw p orbital | Active |
| `Custom_s_Orbital.png` | `tool.sOrbital` | Draw s orbital | Active |
| `Custom_Rotation.png` | `layout.rotate90` | Rotate selected objects 90 degrees | Active |
| `Custom_FormulaStyle.png` | `style.formulaText` | Apply formula text styling | Active |
| `Custom_Left.png` | `layout.alignLeft` | Align selected objects left | Active; requires two or more selected objects |
| `Custom_Center.png` | `layout.alignCenter` | Align selected objects center | Active; requires two or more selected objects |
| `Custom_Right.png` | `layout.alignRight` | Align selected objects right | Active; requires two or more selected objects |
| `Custom_Top.png` | `layout.alignTop` | Align selected objects top | Active; requires two or more selected objects |
| `Custom_Middle.png` | `layout.alignMiddle` | Align selected objects middle | Active; requires two or more selected objects |
| `Custom_Bottom.png` | `layout.alignBottom` | Align selected objects bottom | Active; requires two or more selected objects |
| `Custom_Horizontal.png` | `layout.distributeHorizontal` | Distribute selected objects horizontally | Active; requires two or more selected objects |
| `Custom_Vertical.png` | `layout.distributeVertical` | Distribute selected objects vertically | Active; requires two or more selected objects |
| `Custom_Flip_Horizontal.png` | `layout.flipHorizontal` | Flip selected objects horizontally | Active |
| `Custom_Flip_Vertical.png` | `layout.flipVertical` | Flip selected objects vertically | Active |
| `Custom_Front.png` | `layout.bringForward` | Bring selected objects forward | Active |
| `Custom_Back.png` | `layout.sendBackward` | Send selected objects backward | Active |
| `Custom_Colors.png` | `style.color` | Open colour controls for the selection | Active |
| `Custom_Settings.png` | `tool.settings` | Toggle the Molecule Inspector | Active |
