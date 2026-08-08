import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import {
  graphicObjectIntersectsPolygon,
  graphicObjectIntersectsRect,
  maxGraphicCornerRadius,
  projectGraphicObjectPoint,
  unprojectGraphicObjectPoint,
  type NativeArtBooleanOperation,
  type NativeArtPoint
} from "@chemdraft/art-engine";
import {
  DefaultNativeTextStyle,
  applyPatches,
  createDocumentHistory,
  moleculeToMolfileV2000,
  nativeDrawingStyleFromObjectStyle,
  nativeTextStyleFromObjectStyle,
  redo as redoDocumentHistory,
  undo as undoDocumentHistory,
  cssPxToPageSize,
  pageSizeToCssPx,
  pageLayoutSourceUnit,
  type PageSizeUnit,
  type BondRef,
  type ArrowObject,
  type BracketObject,
  type ChemDraftDocument,
  type DocumentHistory,
  type DocumentObject,
  type DocumentPage,
  type DocumentPatch,
  type GraphicFreehandPoint,
  type GraphicObject,
  type GroupObject,
  type MoleculeAtom,
  type MoleculeObject,
  type NativeDrawingStyle,
  type NativeTextStyle,
  type ObjectReorderPlacement,
  type TextObject,
  type TextSpan
} from "@chemdraft/chem-core";
import { sha256Utf8Hex } from "@chemdraft/cdx-compat";
import {
  createToolsetToggleCommandId,
  parseToolsetLayoutState,
  parseToolsetToggleCommandId,
  type ToolsetLayoutState
} from "@chemdraft/toolset-registry";
import {
  buildCrosshairTicks,
  centimeterRulerUnit,
  createRulerRenderState,
  createViewportState,
  inchRulerUnit,
  setViewportScale,
  viewportCssVars,
  wheelDeltaToZoomFactor,
  zoomViewportAtPoint,
  type RulerUnitState,
  type ViewportState
} from "@chemdraft/viewport-engine";
import ScenaRuler from "@scena/react-ruler";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { createCoreCommandRegistrar } from "./commands/coreCommandRegistrar";
import { createFixturePluginOptions, fixturePluginManifest, FIXTURE_PLUGIN_ID } from "./plugins/fixturePlugin";
import { createToolbarCatalog } from "./toolbars/toolbarCatalog";
import { CustomizeToolbarsDialog } from "./toolbars/CustomizeToolbars/CustomizeToolbarsDialog";
import { emptyLayoutState } from "./toolbars/CustomizeToolbars/layoutStateEdits";
import { applyToolsetLayoutEdit } from "./toolbars/CustomizeMainToolbar/applyLayoutEdit";
import { ToolbarCustomizeController } from "./toolbars/CustomizeMainToolbar/ToolbarCustomizeController";
import { CustomizeBar } from "./toolbars/CustomizeMainToolbar/CustomizeBar";
import { GalleryTray } from "./toolbars/CustomizeMainToolbar/GalleryTray";
import { reconcileNativePaletteWindows } from "./toolbars/reconcileNativePalettes";
import { mergeVisibilityIntoLayoutState } from "./toolbars/toolbarLayoutState";
import {
  DOCUMENT_SESSION_SAVE_DEBOUNCE_MS,
  buildDocumentSessionEnvelope,
  documentIsBlank,
  parseDocumentSessionEnvelope,
  shouldRestoreDocumentSession
} from "./documentSession";
import { createPersistentPluginStorage } from "./plugins/pluginStorage";
import { PatchReviewTray } from "./plugins/PatchReviewTray";
import {
  broadcastPluginPanelReport,
  broadcastPluginPanelStaleness,
  hidePluginPanelWindow,
  listenForPluginPanelCloses,
  listenForPluginPanelReruns,
  listenForPluginPanelRequests,
  openPluginPanelWindow,
  pluginPanelIdentityKey,
  type PluginPanelIdentity,
  type PluginPanelReportPayload
} from "./plugins/panelBridge";
import type { QueuedProposedPatch } from "@chemdraft/plugin-host";
import { shouldIgnoreShortcutTarget } from "@chemdraft/shortcut-engine";
import {
  atomDisplayLabel,
  atomLabelAnchorOffset,
  atomLabelHaloWidthPx,
  atomLabelLayout,
  atomLabelRunFontSize,
  averageDefinedDepthWeights,
  bondRefKey,
  depthCuedBondColor,
  depthCuedBondStrokeWidth,
  depthCuedLabelColor,
  depthCuedLabelScale,
  isTerminalHeteroatomDoubleBond,
  labelEndpointClearance,
  nativeMoleculeRings,
  nativeMultipleBondGapPx,
  planMoleculeAtomLabels,
  planPageSvgRender,
  planNativeArtVisual,
  sameBondRef,
  smallestRingAtomIdsByBondId,
  styleColorMapValue,
  textObjectSpansForRendering,
  type PageSvgAttributeValue,
  type PageSvgElementFragment,
  type PageSvgFragment,
  type PageSvgRenderPlan,
  bracketGlyphPathD,
  planReactionArrowGeometry,
  type NativeArtPaintPlan,
  type NativeArtVisualPlan,
  type ResolvedBondCrossing
} from "@chemdraft/layout-engine";
import { createRdkitAdapter } from "@chemdraft/rdkit-adapter";
import { buildAnalysisReport, type AnalysisReport, type AnalysisRun } from "@chemdraft/analysis-core";
import { analysisClient } from "./analysisClient";
import { inspectClipboardPayload, looksLikeSmiles, type ClipboardDetectedPayload } from "@chemdraft/clipboard-adapter";
import type { Generate3DConformerResult, StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
import {
  exportFormatDescriptors,
  getExportFormatDescriptor,
  type ExportFormatDescriptor,
  type ExportFormatGroup,
  type ExportFormatId,
  type ExportResult
} from "@chemdraft/export-engine";
import {
  atomElementActions,
  atomElementCommandId,
  artBooleanOperationCommandIds,
  createLayerActions,
  createQuickActions,
  distributeModeCommandIds,
  editActions,
  objectColorForCommand,
  objectEffectColorForCommand,
  objectEffectDisableForCommand,
  objectEffectOpacityForCommand,
  objectEffectForCommand,
  objectEffectSizeForCommand,
  objectFillOpacityCommandId,
  objectOpacityCommandId,
  objectOpacityForCommand,
  objectPaintTypeForCommand,
  objectStyleActions,
  objectStrokeDashCommands,
  objectStrokeLineCapCommands,
  objectStrokeLineJoinCommands,
  objectStrokeOpacityCommandId,
  objectStrokeWidthCommands,
  objectStyleNoneCommands,
  objectGradientAddStopCommand,
  objectGradientDeleteStopIndexForCommand,
  objectGradientDeleteStopCommand,
  objectGradientReverseCommand,
  objectGradientRotateCommand,
  objectGradientStopColorForCommand,
  objectGradientStopOffsetForCommand,
  objectGradientStopOpacityForCommand,
  objectStyleSwapCommand,
  objectStyleTargetCommands,
  ringInspectorToolsetId,
  drawnStructureSettingsToolsetId,
  molecularInspectorToolsetId,
  artToolsetId,
  textToolsetId,
  toggleRingInspectorCommandId,
  drawnStructureSettingsTemplateExportCommandId,
  drawnStructureSettingsTemplateImportCommandId,
  moleculeRingEffectColorForCommand,
  moleculeRingEffectDisableForCommand,
  moleculeRingEffectForCommand,
  moleculeRingEffectOpacityForCommand,
  moleculeRingEffectSizeForCommand,
  moleculeRingFillColorForCommand,
  moleculeRingFillNoneForCommand,
  moleculeRingFillOpacityForCommand,
  moleculeStructureChainAngleForCommand,
  moleculeStructureBondLengthForCommand,
  moleculeStructureBondStrokeWidthForCommand,
  moleculeStructureBondBoldWidthForCommand,
  moleculeStructureBondColorForCommand,
  moleculeStructureBondLineCapForCommand,
  moleculeStructureBondSpacingModeForCommand,
  moleculeStructureBondSpacingPercentForCommand,
  moleculeStructureMultipleBondGapForCommand,
  moleculeStructureDoubleBondInsetForCommand,
  moleculeStructureBondMarginWidthForCommand,
  moleculeStructureBondHashSpacingForCommand,
  moleculeStructureOverlapClearanceForCommand,
  moleculeStructureAtomQueryIndicatorsForCommand,
  moleculeStructureAtomStereochemistryForCommand,
  moleculeStructureAtomEnhancedStereochemistryForCommand,
  moleculeStructureAtomNumbersForCommand,
  moleculeStructureBondQueryIndicatorsForCommand,
  moleculeStructureBondStereochemistryForCommand,
  moleculeStructureBondReactionIndicatorsForCommand,
  moleculeAtomLabelFontFamilyForCommand,
  moleculeAtomLabelFontFaceForCommand,
  moleculeAtomLabelFontSizeForCommand,
  moleculeAtomLabelColorForCommand,
  moleculeAtomLabelBackgroundColorForCommand,
  moleculeAtomLabelPaddingForCommand,
  moleculeAtomLabelBondClearanceForCommand,
  moleculeAtomLabelAlignmentForCommand,
  moleculeAtomLabelPlacementForCommand,
  moleculeAtomLabelShowTerminalCarbonsForCommand,
  moleculeAtomLabelHideImplicitHydrogensForCommand,
  pageOrientationActions,
  pageSizeActions,
  structureCleanup3dCommandId,
  structureCleanupCommandId,
  structureInteractive3dCommandId,
  structureSpin3dCommandId,
  textScriptForCommand,
  textStylePatchForCommand,
  textToolbarActions,
  toolbarCustomizationActions,
  viewActions,
  pageCustomSizeAction,
  PAGE_CUSTOM_SIZE_COMMAND_ID,
  PREFERENCES_COMMAND_ID,
  toggleDrawnStructureSettingsCommandId,
  moleculeStructureNumberRanges,
  allShellCommands,
  type CommandSpec
} from "./commands";
import {
  beginEngine3dWorkspaceDrag,
  closeEngine3dWorkspaceSession,
  createEngine3dSessionInputFromMolecule,
  describeEngine3dWorkspaceSession,
  endEngine3dWorkspaceDrag,
  openEngine3dWorkspaceSession,
  pollEngine3dWorkspaceSessionState,
  readEngine3dSidecarStatus,
  updateEngine3dWorkspaceDrag,
  type Engine3dWorkspaceSessionState
} from "./engine3dSidecar";
import type { Engine3DCoordinate } from "@chemdraft/engine3d-api";
import {
  activateDrawingToolCommand,
  createActiveToolState,
  drawingToolStatusLabel,
  isCompatOnlyArtVariantCommandId,
  isDrawingToolCommand,
  TRANSITIONAL_STUB_COMMAND_IDS,
  withStandaloneDrawingToolCommands,
  type ActiveToolState
} from "./drawingTools";
import {
  clipboardPayloadFromDataTransfer,
  readClipboardPayload,
  writeClipboardDataTransfer,
  writeClipboardTextItems,
  type ClipboardWriteTextItem
} from "./clipboard";
import {
  CHEMDRAFT_SELECTION_CLIPBOARD_TYPE,
  applyClipboardPastePayload,
  applyImportedPageFitRecommendation,
  applyNativeArtBooleanOperationToSelection,
  applyNativeCarbonylAtAtomTarget,
  applyNativeAtomElementTarget,
  applyChargeToolAtPoint,
  applyChargeToolAtNativeAtom,
  applyDocumentObjectProjectedPlaneTilt,
  applyNativeBondDisplayStyleTarget,
  applyNativeDoubleBondSideTarget,
  applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeBondOrderValueTarget,
  applyNativeMoleculeDeleteTarget,
  applyNativeMoleculePartDeleteTarget,
  applyEditorSaveResultToSelectedMolecule,
  applyAnalysisToSelectedMolecule,
  applyFreeformSingleBondToolAtPoint,
  applyNativeTemplateToolAtTarget,
  applyNativeTemplateToolAtPoint,
  planNativeTemplatePlacement,
  type NativeTemplatePlacementPlan,
  applySingleBondToolAtPoint,
  applySingleBondToolAtNativeAtom,
  applyToolbarColorToSelection,
  applyGraphicObjectColorToSelection,
  applyGraphicObjectEyedropperToSelection,
  applyVisualEffectColorToSelection,
  deactivateVisualEffectForSelection,
  applyVisualEffectOpacityToSelection,
  applyVisualEffectSizeToSelection,
  applyVisualEffectToSelection,
  applyGraphicObjectNoneToSelection,
  applyGraphicObjectOpacityToSelection,
  applyGraphicObjectPaintTypeToSelection,
  applyGraphicObjectStrokeStyleToSelection,
  applyMoleculeObjectColorToSelection,
  applyMoleculeObjectNoneToSelection,
  applyMoleculeObjectOpacityToSelection,
  applyMoleculeObjectPaintTypeToSelection,
  applyMoleculeRingEffect,
  applyMoleculeRingEffectColor,
  applyMoleculeRingEffectOpacity,
  applyMoleculeRingEffectSize,
  applyMoleculeRingFillColor,
  applyMoleculeRingFillNone,
  applyMoleculeRingFillOpacity,
  clearMoleculeRingStyles,
  deactivateMoleculeRingEffect,
  createNativeSavePayload,
  createPhase4Document,
  createSelectionClipboardPayload,
  applyNativeMoleculeEngineRelayout,
  cleanUpNativeMolecules2d,
  moleculeHasFusedRingSystem,
  attachSpin3dModelFromConformer,
  conformerGraphSignature,
  deleteNativeGraphicPathNode,
  documentObjectVisualBounds,
  spin3dModelCoordsForMolecule,
  validSpin3dModelFor,
  type ProjectedPlaneTiltDocumentResult,
  type Spin3dEngineProvenance,
  type StereoPerceiver,
  flattenSpunMolecule,
  deleteSelectedDocumentObjects,
  splitNativeGraphicPathSegmentAtPoint,
  exportPhase4Cdxml,
  exportPhase4Pdf,
  exportPhase4Svg,
  getSelectedMolecule,
  getSelectedTextObject,
  insertNativeTextObject,
  insertNativeSymbolGlyph,
  symbolGlyphForToolCommand,
  reactionArrowKindForToolCommand,
  applyReactionArrowToolAtPoint,
  stretchNativeReactionArrowTo,
  bracketKindForToolCommand,
  insertNativeBracket,
  applyNativeChainTool,
  applyFormulaTextFormatting,
  type NativeChainAnchor,
  insertNativeArtGraphicObject,
  nativeBezierPathDocument,
  nativeArtToolIsFreehand,
  nativeFreehandStrokeDocument,
  nativePolylinePathDocument,
  insertSmilesMolecule,
  pastedStructureDepictionFromMolfile,
  nativeAtomDisplayLabel,
  documentObjectProjectedPlaneTilt,
  nativeChargeAssociationsForMolecule,
  nativeChargeByAtomIdFromAssociations,
  nativeBondStyleForToolCommand,
  nativeElementFromKeyboardKey,
  nativeMoleculeInvalidAtomStates,
  nativeMoleculePartBounds,
  nativeGraphicCornerRadiusEditPoint,
  nativeGraphicLinearGradientHandlePoints,
  nativeGraphicPathEditPoints,
  nativeGraphicPathNodeEditPoints,
  nativeGraphicRadialGradientHandlePoints,
  nativeMoleculeCenter,
  nativeMoleculeTransformState,
  nativeArtToolForCommand,
  nativeTemplateForToolCommand,
  projectedPlaneTiltMaxRadians,
  wrapProjectedPlaneTiltVectorRadians,
  alignSelectedDocumentObjects,
  distributeSelectedDocumentObjects,
  duplicateSelectedDocumentObjects,
  flipSelectedDocumentObjects,
  groupSelectedDocumentObjects,
  moveDocumentObject,
  moveDocumentObjects,
  promoteDocumentObjectIdsToSelectableGroups,
  resolveGroupedDocumentObjectIds,
  type ChemDraftSelectionClipboardPayload,
  type SelectionBounds,
  rotateDocumentObjectsAroundPoint,
  rotateSelectedDocumentObjects90,
  scaleDocumentObjectsAroundPoint,
  ungroupSelectedDocumentObjects,
  moveNativeMoleculeParts,
  openNativeDocument,
  previewNativeMoleculeBondGrowth,
  previewNativeMoleculeFreeformBondGrowth,
  prepareGraphicPathForDirectEdit,
  recommendImportedPageFit,
  reorderedLayerObjectIds,
  reorderSelectedDocumentObject,
  resizeNativeMoleculeParts,
  resizeNativeMoleculeObject,
  resizeNativeTextObjectBox,
  resolveToolbarColorSelection,
  selectedGraphicObjectIds,
  selectedLayerObjectIds,
  selectedMoleculeObjectIds,
  selectedVisualEffectObjectIds,
  parseSelectionClipboardPayload,
  pasteSelectionClipboardPayload,
  rotateNativeMoleculeParts,
  rotateDocumentObject,
  rotateNativeMoleculeObjectAroundPoint,
  tiltNativeMoleculeProjectedPlane,
  tiltNativeMoleculeObjectsProjectedPlane,
  tiltNativeMoleculePartsProjectedPlane,
  selectAllDocumentObjects,
  selectDocumentObject,
  selectDocumentObjectWithinGroup,
  selectDocumentObjects,
  toggleDocumentObjectSelection,
  setDocumentPageOrientation,
  setDocumentPageSize,
  setDocumentCustomPageSize,
  updateNativeTextObjectScript,
  updateNativeTextObjectScriptRange,
  updateNativeTextObjectStyle,
  updateNativeTextObjectStyleRange,
  updateNativeTextObjectText,
  updateNativeGraphicCornerRadius,
  updateNativeGraphicLinearGradientHandle,
  updateNativeGraphicMarkerHandle,
  updateNativeGraphicPathHandle,
  updateNativeGraphicRadialGradientHandle,
  deleteNativeGraphicPathSegment,
  addGraphicObjectGradientStopForSelection,
  applyMoleculeBaseStylePatch,
  applyMoleculeAtomIndicatorStylePatch,
  applyMoleculeAtomLabelStylePatch,
  applyMoleculeBondStylePatch,
  applyMoleculeTargetBondLength,
  applyMoleculeTargetBondLengthToBonds,
  applyGraphicObjectGradientStopColorForSelection,
  applyGraphicObjectGradientStopOffsetForSelection,
  applyGraphicObjectGradientStopOpacityForSelection,
  deleteGraphicObjectGradientStopForSelection,
  deleteGraphicObjectGradientStopAtIndexForSelection,
  reverseGraphicObjectGradientStopsForSelection,
  rotateGraphicObjectGradientStopsForSelection,
  selectionClipboardPlainText,
  serializeSelectionClipboardPayload,
  swapGraphicObjectFillAndStroke,
  type GraphicStylePaintTarget,
  type NativeGraphicGradientHandleId,
  type NativeGraphicLinearGradientHandleId,
  type NativeGraphicMarkerHandleId,
  type NativeGraphicPathEditHandle,
  type NativeGraphicPathEditPoints,
  type NativeGraphicPathNodeEditPoints,
  type NativeGraphicRadialGradientHandleId,
  type NativeTextSelectionRange,
  type ToolbarColorSelection,
  type NativeBondDisplayStyle,
  type NativeMoleculeTemplateId,
  type NativeMoleculeDeleteHit,
  type NativeDoubleBondSide,
  type NativeMoleculeDeleteTarget,
  type NativeBondOrderTarget,
  type NativeBondOrderValue,
  type NativeChargeValue,
  type NativeMoleculeRingTarget,
  type NativeSingleLetterElement,
  type DocumentAlignMode,
  type DocumentDistributeAxis,
  type DocumentDistributeMode,
  type ImportedPageFitRecommendation
} from "./documentWorkflow";
import { KetcherEditorHost } from "./KetcherEditorHost";
import { initialInteractionState, interactionReducer, type InteractionState } from "./interaction/machine";
import { APPENDABLE_TOOLBAR_WIDGETS, TOOLBAR_WIDGET_TITLES, ToolPalette } from "./ToolPalette";
import { TOOLBAR_WIDGET_GRID_SPANS } from "./toolbars/toolbarWidgets";
import {
  DEFAULT_TOOLSET_ID,
  broadcastToolsetActiveTool,
  broadcastToolsetCommandSpecs,
  broadcastToolsetCustomizeMode,
  broadcastToolsetLayoutState,
  broadcastToolsetTextStyle,
  createToolsetTextStylePayload,
  dismissToolsetPopovers,
  focusCurrentWindowAndWebview,
  isDesktopRuntime,
  listToolsetWindowStates,
  listenForPaletteCommandCancels,
  listenForPaletteCommandCommits,
  listenForPaletteCommandPreviews,
  listenForToolsetActiveToolRequests,
  listenForToolsetCommandSpecsRequests,
  listenForToolsetCustomizeModeRequests,
  listenForToolsetLayoutEdits,
  listenForToolsetLayoutStateRequests,
  listenForToolsetTextStyleRequests,
  loadToolsetLayoutState,
  saveToolsetLayoutState,
  loadDocumentSession,
  saveDocumentSession,
  sendToolsetLayoutEdit,
  listenForToolsetCommands,
  listenForToolsetWindowStates,
  openToolsetWindow,
  setMenuChecked,
  setToolbarsMenu,
  toolsetCommandSpecsSignature,
  PREFERENCES_WINDOW_KIND,
  listenForSpin3dSettings,
  toggleSpin3dDebuggerWindow,
  togglePreferencesWindow,
  closeToolsetWindow,
  type ToolsetWindowGeometry,
  type ToolsetArtPaintTarget
} from "./window-manager";
import {
  createDefaultVisibleToolsetIds,
  defaultVisibleToolsetIds,
  desktopToolsetRegistry,
  getToolbarsMenuModel,
  getToolsetCommandSpecs,
  getToolsetItemGroups,
  getToolsetPaletteGroups,
  getToolsetToggleActions,
  isDisabledPlaceholderCommand,
  migrateLegacyMainToolbarLayoutState,
  type DesktopToolsetRegistry,
  type ToolbarPaletteGroupModel
} from "./toolsets";
import { MenuBar } from "./MenuBar";
import { buildAppMenuModel, PLUGIN_MANAGER_COMMAND_ID } from "./appMenu";
import { PluginManagerDialog } from "./plugins/PluginManagerDialog";
import { usePluginRuntime, pluginCommandFailure } from "./plugins/usePluginRuntime";
import { PluginPanelSurface } from "./plugins/PluginPanelSurface";
import { PLUGIN_DIAGNOSTICS_COMMAND_ID } from "./plugins/pluginMenuModel";
import { buildPluginSelectionSnapshot, computeObjectFingerprint } from "./plugins/selectionSnapshot";
import { syncPluginNativeMenuItems } from "./plugins/nativePluginMenu";
import { createDesktopShortcutRegistry } from "./keyboardShortcuts";
import { rasterizeSvgNative, type NativeRasterExportFormat } from "./nativeRasterExport";
import { clientToPage, pageToClient } from "./interaction/camera";
import {
  applyTrackballDrag,
  quatConjugate,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  quatToViewMatrix,
  rotateVectorByQuat,
  type Quaternion,
  type Vec3
} from "./interaction/rotation3d";
import { bondDepthWeights, initialViewQuaternion, medianBondLength3d, projectSpin, orientedOverlayScale, overlayScale, type ScreenPlacement } from "./interaction/spinOverlay";
import { getConformerWorkerClient } from "./conformerClient";
import { attachSpin3dTraceConsole } from "./conformerTraceConsole";
import {
  conformerOptionsForSpin3d,
  loadSpin3dSettings,
  type Spin3dSettings
} from "./spin3dSettings";
import {
  SPIN3D_DEBUGGER_COMMAND_ID,
  SPIN3D_DEBUGGER_WINDOW_KIND,
  broadcastSpin3dTraceEvent,
  createSpin3dTraceEvent,
  createSpin3dTraceEventFromOcl,
  startSpin3dTraceSpan,
  type Spin3dTraceEvent,
  type Spin3dTracePath
} from "./conformerDebug";
import {
  BOND_HIT_CATCHER_STROKE_PX,
  currentTemplateTargetFromHoverOrHit,
  hitToleranceForScale,
  nativeMoleculeCanvasHoverTarget,
  nativeMoleculeHitFromPointerTarget,
  nativeMoleculeTemplateHoverTarget,
  type TemplateHoverSample
} from "./interaction/hitTest";
import { createArtInspectorModel, selectedVisualObjectsForArtInspector } from "./artInspectorModel";
import { createMoleculeInspectorModel, representativeMoleculeBondLengthPx } from "./moleculeInspectorModel";
import {
  moleculeInspectorTemplateFilename,
  moleculeInspectorTemplateMimeType,
  moleculeInspectorTemplatePatchFromDrawingStyle,
  parseMoleculeInspectorTemplate,
  serializeMoleculeInspectorTemplate
} from "./moleculeInspectorTemplates";
import {
  applySelection,
  fromSelectionItems,
  selectionModeFromEvent,
  toSelectionItems,
  toSelectionItemsMulti,
  type SelectionItem
} from "./selection/selectionPolicy";
import {
  AGENT_BRIDGE_GLOBAL_NAME,
  createChemDraftAgentBridge,
  dispatchAgentPointerEvent,
  resolveAgentBridgePermission,
  waitForAnimationFrames,
  type AgentArtDebugResult,
  type AgentHitResult,
  type AgentObjectAnchor,
  type AgentPoint,
  type AgentPointerEventType,
  type AgentPointerOptions,
  type AgentPointTarget,
  type AgentResolvedPoint,
  type AgentSnapshot
} from "./agentBridge";

// Re-exported so existing tests can keep importing it from "./MainWindow" while the
// implementation lives in the pure, separately-tested interaction layer.
export { nativeMoleculeCanvasHoverTarget };

type PaletteMode = "floating" | "hidden";
type PalettePosition = { x: number; y: number };
type ClientPoint = { x: number; y: number };
type ObjectPointerEvent = PointerEvent<Element>;
type ObjectMouseEvent = ReactMouseEvent<Element>;
type PaletteDragState = {
  toolsetId: string;
  pointerId: number;
  originX: number;
  originY: number;
  startX: number;
  startY: number;
};
type WebKitGestureEvent = Event & {
  clientX?: number;
  clientY?: number;
  scale?: number;
};
type RulerFrame = {
  horizontalScrollPx: number;
  verticalScrollPx: number;
  width: number;
  height: number;
};
type HoveredNativeAtom = {
  objectId: string;
  atomId: string;
  direction: ClientPoint;
  candidateDirections: ClientPoint[];
  newAtomPoint: ClientPoint;
};
type FreeformNativeBondPreview = {
  objectId: string;
  atomId: string;
  targetAtomId?: string;
  newAtomPoint: ClientPoint;
  customLength: boolean;
  lengthAngstrom: number;
};
type NativeBondDragState = {
  pointerId: number;
  objectId: string;
  atomId: string;
  bondStyle?: NativeBondDisplayStyle;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
  freeformUnlocked: boolean;
};
type NativePlacementDragState = {
  pointerId: number;
  kind: "single-bond" | "template" | "arrow" | "chain";
  startDocument: ChemDraftDocument;
  placementDocument: ChemDraftDocument;
  objectId: string;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  bondStyle?: NativeBondDisplayStyle;
  templateId?: NativeMoleculeTemplateId;
  arrowKind?: ArrowObject["arrowKind"];
  chainAnchor?: NativeChainAnchor;
  dragging: boolean;
};
type NativeBondEditDragState = {
  pointerId: number;
  objectId: string;
  target: NativeBondOrderTarget;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
type NativeDoubleBondSidePreview = {
  objectId: string;
  bondId: string;
  side: NativeDoubleBondSide;
};
type TapeMeasureOverlayState = {
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  constrained: boolean;
  dragging: boolean;
};
type TapeMeasureDragState = TapeMeasureOverlayState & {
  pointerId: number;
};
type ObjectDragState = {
  pointerId: number;
  objectId: string;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  startObjectX: number;
  startObjectY: number;
  bondTarget?: NativeBondOrderTarget;
  // When the grabbed object is part of a multi-object selection, the whole set moves
  // together by the pointer delta (group move). Undefined ⇒ single-object move.
  groupObjectIds?: readonly string[];
  artPreviewProxies?: Record<string, ArtTransformDragPreviewProxy>;
  dragging: boolean;
};
type GraphicPathEditDragState = {
  pointerId: number;
  objectId: string;
  handle: NativeGraphicPathEditHandle;
  startDocument: ChemDraftDocument;
  workingDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
type GraphicMarkerDragState = {
  pointerId: number;
  objectId: string;
  markerId: NativeGraphicMarkerHandleId;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
type GraphicGradientDragState = {
  pointerId: number;
  objectId: string;
  target: GraphicStylePaintTarget;
  handle: NativeGraphicGradientHandleId;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
type GraphicCornerRadiusDragState = {
  pointerId: number;
  objectId: string;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
type GraphicCornerRadiusReadoutState = {
  objectId: string;
  radius: number;
};
type FreehandArtDragState = {
  pointerId: number;
  commandId: string;
  startDocument: ChemDraftDocument;
  points: GraphicFreehandPoint[];
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
type PathArtDrawKind = "polyline" | "bezier";
type PathArtDrawNode = {
  point: ClientPoint;
  inControl?: ClientPoint;
  outControl?: ClientPoint;
};
type PathArtDrawState = {
  commandId: string;
  pathKind: PathArtDrawKind;
  startDocument: ChemDraftDocument;
  nodes: PathArtDrawNode[];
  latestPoint?: ClientPoint;
  closed: boolean;
};
type PathArtPreviewState = {
  pathKind: PathArtDrawKind;
  nodes: PathArtDrawNode[];
  latestPoint?: ClientPoint;
  closed: boolean;
};
type SelectedGraphicPathNodeState = {
  objectId: string;
  nodeIndex: number;
};
type BezierArtNodeDragState = {
  pointerId: number;
  commandId: string;
  nodeIndex: number;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
// Captured at pointer-down when a whole molecule carries a valid persisted Spin 3D
// model, so the rotate handles re-project the real conformer instead of shearing the
// flattened 2D drawing. Snapshotting here avoids re-reading/re-validating per frame.
type Spin3dRotateSnapshot = {
  /** Committed orientation at pointer-down; per-drag deltas compose onto this (no drift). */
  startOrientation: Quaternion;
  /** Conformer (math frame, y-up), reordered into the current molecule's atom order. */
  coords3d: Float64Array;
  /** Fixed visual placement shared by every preview frame in this drag. */
  placement: ScreenPlacement;
  atomIds: string[];
  engine?: Spin3dEngineProvenance;
};
type ObjectRotateDragState = {
  pointerId: number;
  objectId: string;
  target?: NativeMoleculeTransformableSelectionPart;
  startDocument: ChemDraftDocument;
  centerPoint: ClientPoint;
  startPoint: ClientPoint;
  startRotationDegrees: number;
  latestPoint: ClientPoint;
  artPreviewProxies?: Record<string, ArtTransformDragPreviewProxy>;
  dragging: boolean;
  spin3dModel?: Spin3dRotateSnapshot;
};
type ObjectRotateReadoutState = {
  objectId: string;
  degrees: number;
};
type ProjectedPlaneTiltDragState = {
  pointerId: number;
  objectId: string;
  target?: NativeMoleculeTransformableSelectionPart;
  startDocument: ChemDraftDocument;
  centerPoint: ClientPoint;
  axisAngleRad: number;
  startPoint: ClientPoint;
  startTiltXRad: number;
  startTiltYRad: number;
  startRotationDegrees: number;
  latestPoint: ClientPoint;
  latestTiltXRad: number;
  latestTiltYRad: number;
  clamped: boolean;
  dragging: boolean;
  spin3dModel?: Spin3dRotateSnapshot;
  /** Last flatten that committed (depth-cued 2D + the orientation that produced it).
   *  On a stereo-refused frame the preview holds this instead of snapping back. */
  lastValidPreviewDocument?: ChemDraftDocument;
  lastValidOrientation?: Quaternion;
};
type ProjectedPlaneTiltReadoutState = {
  objectId: string;
  label: string;
  limited: boolean;
};
type RotationInputBase = {
  objectId: string;
  target?: NativeMoleculeTransformableSelectionPart;
  targetLabel: string;
  startDocument: ChemDraftDocument;
};

type RotationInputState =
  | (RotationInputBase & {
      kind: "z";
      draftZDegrees: string;
      homeZDegrees: string;
    })
  | (RotationInputBase & {
      kind: "xy";
      draftXDegrees: string;
      draftYDegrees: string;
      homeXDegrees: string;
      homeYDegrees: string;
    });

type RotationInputDraftDocumentResult =
  | {
      kind: "z";
      document: ChemDraftDocument;
      zDegrees: number;
    }
  | {
      kind: "xy";
      document: ChemDraftDocument;
      tiltXRad: number;
      tiltYRad: number;
      clamped: boolean;
    };
type ObjectResizeInputState = {
  objectId: string;
  target?: NativeMoleculeTransformableSelectionPart;
  targetLabel: string;
  corner: ObjectResizeCorner;
  startDocument: ChemDraftDocument;
  draftXPercent: string;
  draftYPercent: string;
  homeXPercent: string;
  homeYPercent: string;
};
type ObjectResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type ObjectResizeDragState = {
  pointerId: number;
  objectId: string;
  target?: NativeMoleculeTransformableSelectionPart;
  corner: ObjectResizeCorner;
  startDocument: ChemDraftDocument;
  centerPoint: ClientPoint;
  startPoint: ClientPoint;
  startCumulativeScale: ObjectResizeScale;
  latestPoint: ClientPoint;
  latestScale: ObjectResizeScale;
  latestCumulativeScale: ObjectResizeScale;
  stretching: boolean;
  dragging: boolean;
};
type ObjectResizeReadoutState = {
  objectId: string;
  scaleXPercent: number;
  scaleYPercent: number;
};
type ArtTransformQaDraft = {
  rotationDegrees: string;
  tiltXDegrees: string;
  tiltYDegrees: string;
};
type ObjectResizeScale = {
  x: number;
  y: number;
};
type ObjectTransformPreviewMode = "move" | "rotate" | "resize";
type ObjectTransformPreviewState = {
  pointerId: number;
  objectIds: readonly string[];
  mode: ObjectTransformPreviewMode;
  origin: ClientPoint;
  translateX: number;
  translateY: number;
  rotationDegrees: number;
  scaleX: number;
  scaleY: number;
  artPreviewProxies?: Record<string, ArtTransformDragPreviewProxy>;
};
type ArtTransformDragPreviewProxy = {
  kind: "svg-image" | "bounds";
  imageUrl?: string;
  width: number;
  height: number;
  rasterScale: number;
};
// One drag that rotates or scales a whole multi-object selection about its shared center.
type GroupTransformDragState = {
  pointerId: number;
  mode: "rotate" | "resize" | "projected-plane-tilt";
  objectIds: readonly string[];
  startDocument: ChemDraftDocument;
  center: ClientPoint;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  latestTiltXRad?: number;
  latestTiltYRad?: number;
  clamped?: boolean;
  dragging: boolean;
};
type MoleculeTransformFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};
type TextResizeEdge = "left" | "right" | "top" | "bottom";
type TextResizeState = {
  pointerId: number;
  objectId: string;
  edge: TextResizeEdge;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  startObjectX: number;
  startObjectY: number;
  startObjectWidth: number;
  startObjectHeight: number;
};
type NativeFileState = {
  path?: string;
  dirty: boolean;
  lastSavedPayloadHash?: string;
};
type ResolvedOpenDocument = {
  document: ChemDraftDocument;
  source: ReturnType<typeof openNativeDocument>["source"];
  statusSourceLabel?: string;
};
export type NativeMoleculeSelectionPart =
  | { objectId: string; kind: "atom"; atomId: string }
  | { objectId: string; kind: "bond"; bondId: string }
  | { objectId: string; kind: "ring"; ringKey: string; atomIds: readonly string[]; bondIds: readonly string[] }
  | { objectId: string; kind: "rings"; rings: readonly NativeMoleculeRingSelectionItem[] }
  | { objectId: string; kind: "parts"; atomIds: readonly string[]; bondIds: readonly string[] };
type NativeMoleculeRingSelectionItem = { ringKey: string; atomIds: readonly string[]; bondIds: readonly string[] };
type NativeMoleculeTransformableSelectionPart = Exclude<NativeMoleculeSelectionPart, { kind: "ring" | "rings" }>;
export type NativeMoleculeRingSelectionPart = Extract<NativeMoleculeSelectionPart, { kind: "ring" }>;
type NativeMoleculeRingSetSelectionPart = Extract<NativeMoleculeSelectionPart, { kind: "rings" }>;
type ToolbarStyleTargetSnapshot = ToolbarColorSelection;
type NativePartDragState = {
  pointerId: number;
  objectId: string;
  target: NativeMoleculeTransformableSelectionPart;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
export type NativeMoleculeSelectionDragIntent =
  | { kind: "whole-object" }
  | { kind: "native-part"; target: NativeMoleculeTransformableSelectionPart }
  | { kind: "none" };
type AtomLabelEditState = {
  objectId: string;
  atomId: string;
  initialElement: string;
  draft: string;
};
type AtomLabelEditOptions = {
  clearDraft?: boolean;
};
type SelectionMarqueeState = {
  pointerId: number;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
type SelectionLassoState = {
  pointerId: number;
  startPoint: ClientPoint;
  points: ClientPoint[];
  latestPoint: ClientPoint;
  subtracting: boolean;
  dragging: boolean;
};
type ObjectContextMenuState = {
  objectId: string;
  targetKind: "object" | NativeMoleculeSelectionPart["kind"];
  bondDepthContext?: BondDepthContext;
  x: number;
  y: number;
};
type BondDepthMenuCrossing = Pick<ResolvedBondCrossing, "key" | "bonds" | "front" | "back" | "hasOverride">;
export type BondDepthCommandId = "bondDepth.bringInFront" | "bondDepth.sendBehind" | "bondDepth.useDefault";
export interface BondDepthContext {
  targetBondRefs: BondRef[];
  relevantCrossings: BondDepthMenuCrossing[];
  hasOverrides: boolean;
}
export interface LayerCommandSelectionResult {
  document: ChemDraftDocument;
  placement?: ObjectReorderPlacement;
  bondDepthCommandId?: BondDepthCommandId;
  bondDepthContext?: BondDepthContext;
}
type LayerContextMenuItem = {
  commandId: string;
  label: string;
};
type ExportDialogFormat = ExportFormatId;
type SvgDialogExportOptions = {
  includeWarnings: boolean;
  includePageGuides: boolean;
};
type PdfDialogExportOptions = {
  compress: boolean;
  includePageGuides: boolean;
  page: "current";
  pdfType: "vector";
  background: "white";
};
type RasterDialogExportOptions = {
  scale: number;
  background: "white" | "transparent";
  jpegQuality: number;
  maxDimensionPx: number;
};
type CdxmlDialogExportOptions = {
  creationProgram: string;
};
type ExportDialogState = {
  format: ExportDialogFormat;
  filename: string;
  destinationPath?: string;
  svg: SvgDialogExportOptions;
  pdf: PdfDialogExportOptions;
  raster: RasterDialogExportOptions;
  cdxml: CdxmlDialogExportOptions;
  busy: boolean;
};
type ImportedPageFitPromptState = ImportedPageFitRecommendation & {
  displayName: string;
};
type SelectionClipboardSourceAction = "copy" | "cut" | "external";

export interface SelectionClipboardPasteState {
  key: string;
  pasteCount: number;
  sourceAction: SelectionClipboardSourceAction;
}
// Width/height are kept as strings so the inputs stay editable (mid-typing "1." etc.);
// they are parsed + validated on Apply.
type CustomPageSizeDialogState = {
  width: string;
  height: string;
  unit: PageSizeUnit;
};
type ObjectStyleRingOverrideMode = "prompt" | "keep" | "clear";
type ObjectStyleCommandApplyResult = {
  document: ChemDraftDocument;
  handled: boolean;
  targeted: boolean;
  message: string;
  needsRingOverrideChoice?: boolean;
  ringOverrideObjectIds?: string[];
};
type MoleculeStyleOverridePromptState = {
  commandId: string;
  target: GraphicStylePaintTarget;
  startDocument: ChemDraftDocument;
  objectIds: string[];
};

type Interactive3dWorkspaceState = {
  openId: number;
  objectId: string;
  source: string;
  bridgeAvailable: boolean;
  status: string;
  session?: Engine3dWorkspaceSessionState;
  selectedAtomIds: readonly string[];
  atoms: readonly Interactive3dAtom[];
  bonds: readonly Interactive3dBond[];
  energyLabel?: string;
  dragVisualTarget?: Interactive3dDragVisualTarget;
};

type Interactive3dDragVisualTarget = {
  generation: number;
  atomId: string;
  target: Engine3DCoordinate;
};

type Interactive3dDragSchedulerState = {
  generation: number;
  openId: number;
  atomId: string;
  session: Engine3dWorkspaceSessionState;
  latestTarget?: Engine3DCoordinate;
  pendingUpdate: boolean;
  updateInFlight: boolean;
  ending: boolean;
  lastSentAt: number;
  timer?: number;
  updatePromise?: Promise<void>;
};

type Interactive3dAtom = {
  id: string;
  element: string;
};

type Interactive3dBond = {
  fromAtomId: string;
  toAtomId: string;
  order: string | number;
};

function formatInteractive3dEnergy(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return Math.abs(value) >= 10000 ? value.toExponential(3) : value.toFixed(3);
}

function interactive3dEnergyLabel(session: Engine3dWorkspaceSessionState): string | undefined {
  const forceField = session.forceField;
  if (forceField) {
    const energy = typeof forceField.energy === "number" && Number.isFinite(forceField.energy)
      ? ` · ${formatInteractive3dEnergy(forceField.energy)} ${forceField.energyUnits ?? "kJ/mol"}`
      : "";
    return `${forceField.name} ${forceField.status}${energy}`;
  }
  return session.energy !== undefined ? `Energy ${formatInteractive3dEnergy(session.energy)}` : undefined;
}

function interactive3dPostOpenSessionChanged(
  previous: Engine3dWorkspaceSessionState,
  next: Engine3dWorkspaceSessionState
): boolean {
  return next.coordinateRevision !== previous.coordinateRevision ||
    next.lastCoordinateReason !== previous.lastCoordinateReason ||
    next.energy !== previous.energy ||
    next.forceField?.status !== previous.forceField?.status ||
    next.errors.length !== previous.errors.length ||
    next.warnings.length !== previous.warnings.length ||
    next.closed !== previous.closed ||
    next.exited !== previous.exited;
}

function interactive3dPostOpenPollingComplete(session: Engine3dWorkspaceSessionState): boolean {
  return session.lastCoordinateReason === "initial-relax" ||
    session.closed ||
    session.exited ||
    session.errors.length > 0;
}

const RULER_THICKNESS = 32;
const INTERACTIVE_3D_DRAG_UPDATE_INTERVAL_MS = 33;
const INTERACTIVE_3D_POST_OPEN_POLL_COUNT = 8;
const INTERACTIVE_3D_POST_OPEN_POLL_MS = 90;
const FREEFORM_BOND_DRAG_THRESHOLD = 6;
const DOUBLE_BOND_SIDE_DRAG_THRESHOLD = 4;
const DOUBLE_BOND_MIN_VISIBLE_SEGMENT_PX = 13;
const VIEW_ZOOM_COMMAND_FACTOR = 1.25;
const rasterExportFormatsByFormatId: Partial<Record<ExportFormatId, NativeRasterExportFormat>> = {
  png: "png",
  jpeg: "jpeg",
  bmp: "bmp",
  gif: "gif",
  tiff: "tiff"
};
const exportFormatGroups: readonly ExportFormatGroup[] = ["graphics", "chemistry", "compatibility", "legacy", "model3d"];
const exportFormatGroupLabels: Record<ExportFormatGroup, string> = {
  graphics: "Graphics",
  chemistry: "Chemistry",
  compatibility: "Compatibility",
  legacy: "Legacy",
  model3d: "3D"
};
const exportFormatOptionExtensions = [...new Set(exportFormatDescriptors.flatMap((descriptor) => descriptor.extensions))];
const PROJECTED_PLANE_TILT_DRAG_PX = 360;
const OBJECT_ROTATE_TANGENTIAL_DEGREES_PER_PIXEL = 360 / PROJECTED_PLANE_TILT_DRAG_PX;
const OBJECT_DRAG_THRESHOLD = 4;
const GRAPHIC_HANDLE_DRAG_THRESHOLD = 1;
const PEN_CONTROL_DRAG_THRESHOLD_PX = 10;
const LASSO_POINT_SPACING_PX = 3;
const OBJECT_RESIZE_MIN_SCALE = 0.12;
const DOCUMENT_HISTORY_LIMIT = 100;
const CURRENT_BUILD_STAMP = "8.8.17.45-claude";
const SELECTION_CLIPBOARD_PASTE_OFFSET_PX = 24;
const artBooleanOperationByCommandId: Record<string, NativeArtBooleanOperation> = {
  [artBooleanOperationCommandIds.union]: "union",
  [artBooleanOperationCommandIds.subtract]: "subtract",
  [artBooleanOperationCommandIds.intersect]: "intersect",
  [artBooleanOperationCommandIds.split]: "split"
};


function interactive3dAtomsForMolecule(molecule: MoleculeObject): readonly Interactive3dAtom[] {
  return molecule.atoms.map((atom) => ({
    id: atom.id,
    element: atom.element
  }));
}

function interactive3dBondsForMolecule(molecule: MoleculeObject): readonly Interactive3dBond[] {
  return molecule.bonds.map((bond) => ({
    fromAtomId: bond.fromAtomId,
    toAtomId: bond.toAtomId,
    order: bond.order
  }));
}

const ART_TRANSFORM_DRAG_PREVIEW_BOUNDS_ONLY = false;
const ART_TRANSFORM_DRAG_PREVIEW_MAX_RASTER_PX = 2048;
const ART_TRANSFORM_QA_OBJECT_IDS = ["art_qa_rect", "art_qa_ellipse"] as const;
const ART_STYLE_QA_OBJECT_IDS = ["art_style_qa_rect", "art_style_qa_ellipse", "art_style_qa_line", "art_style_qa_arc"] as const;

function createShellCommandMap(commands: readonly CommandSpec[]): ReadonlyMap<string, CommandSpec> {
  const byId = new Map<string, CommandSpec>();
  commands.forEach((command) => {
    if (!byId.has(command.id)) {
      byId.set(command.id, command);
    }
  });
  return byId;
}

// Spin 3D speculative-work cap. RDKit ETKDG embeds even large polycyclics in ~1-2 s, so
// prefetching them on selection (to make the Spin 3D click instant) is cheap. The worker
// independently refuses a speculative embed for a large structure on the OCL engine (where
// it would be ~45 s and uninterruptible), so this generous cap is safe under either engine.
const SPIN_PREFETCH_MAX_ATOMS = 200;
// The in-page (main-thread) engine fallback FREEZES the UI for its full duration —
// fine for small structures, catastrophic for a 60-atom branched chain.
const SPIN_IN_PAGE_MAX_ATOMS = 30;

// Unit axes (math frame: x right, y up, z toward viewer) for composing the per-drag
// rotation quaternion that 3D-backed X/Y/Z rotation feeds into flattenSpunMolecule.
const SPIN_AXIS_X: Vec3 = [1, 0, 0];
const SPIN_AXIS_Y: Vec3 = [0, 1, 0];
const SPIN_AXIS_Z: Vec3 = [0, 0, 1];

function selectToolStatusLabel(): string {
  return drawingToolStatusLabel("tool.select", "Selection Tool");
}

function pathArtDrawStatusLabel(pathKind: PathArtDrawKind, nodeCount?: number): string {
  const countLabel = nodeCount === undefined ? "" : ` (${nodeCount})`;
  return pathKind === "bezier"
    ? `Pen: click points${countLabel}; drag handles; Enter ends, Esc cancels`
    : `Polyline: click points${countLabel}; Backspace removes point; Enter/double-click ends, Esc cancels`;
}

function freehandArtStatusLabel(commandId: string): string {
  return drawingToolStatusLabel(commandId, commandId === "tool.art.brush" ? "Brush" : "Pencil");
}

function scissorsStatusLabel(action = "click path to split"): string {
  return `Scissors: ${action}; click path for more; Esc exits`;
}

function eyedropperStatusLabel(target: GraphicStylePaintTarget): string {
  const targetLabel = target === "fill" ? "Fill" : "Stroke";
  return `Eyedropper: ${targetLabel} target selected; click source art; switch Fill/Stroke, ⌥ click copies all; Esc exits`;
}

function eyedropperChooseTargetStatusLabel(target: GraphicStylePaintTarget): string {
  const targetLabel = target === "fill" ? "Fill" : "Stroke";
  return `Eyedropper: click ${targetLabel.toLowerCase()} target art; then click source; Esc exits`;
}

function eyedropperSameTargetStatusLabel(target: GraphicStylePaintTarget): string {
  const targetLabel = target === "fill" ? "Fill" : "Stroke";
  return `Eyedropper: ${targetLabel} target selected; click different source art; switch Fill/Stroke, ⌥ click copies all; Esc exits`;
}
// Whole-molecule double-click is normally read from the browser's `event.detail` click
// counter. That counter is unreliable when the first press mutates the DOM/selection under
// the pointer (seen at low zoom, where the wide bond catcher routes the press to the object
// handler and the first click selects a part, so the second press never reaches detail 2).
// We OR `event.detail` with a self-tracked detector keyed on wall-clock time and SCREEN
// distance (zoom-independent), shared by the page and object selection handlers.
const DOUBLE_PRESS_MS = 400;
const DOUBLE_PRESS_SCREEN_PX = 6;

export interface SelectionPressSample {
  time: number;
  x: number;
  y: number;
  /** The document object resolved under the press, if any. */
  objectId?: string;
  /**
   * The molecule sub-part the press resolved to (atom/bond/ring), if any. Different parts count
   * only when both presses stay on the same molecule and are spatially tight; clicking a distant
   * ring or a neighboring molecule remains ordinary part selection.
   */
  partKey?: string;
}

type TransformHandlePressKind =
  | "rotate-z"
  | "rotate-xy"
  | `resize-${ObjectResizeCorner}`;

interface TransformHandlePressSample extends SelectionPressSample {
  objectId: string;
  handleKind: TransformHandlePressKind;
}

/**
 * True when `current` is the second press of a double-click. Two presses that resolve to the
 * same object within the time window count, even when they land on different visible parts —
 * a small low-zoom object can span more than the screen-distance fallback, and the first press
 * mutates selection so the browser's `event.detail` counter is unreliable. Empty-canvas /
 * cross-target presses fall back to a tight screen-distance check.
 */
export function isSelectionDoublePress(
  previous: SelectionPressSample | undefined,
  current: SelectionPressSample,
  windowMs: number = DOUBLE_PRESS_MS,
  radiusPx: number = DOUBLE_PRESS_SCREEN_PX
): boolean {
  if (!previous || current.time - previous.time > windowMs) {
    return false;
  }
  // When both presses resolve to an object, the double-click is defined by the same object
  // (regardless of screen distance — a small low-zoom object exceeds the fallback radius).
  if (previous.objectId !== undefined && current.objectId !== undefined) {
    return previous.objectId === current.objectId;
  }
  // Empty-canvas / unresolved presses fall back to a tight screen-distance check.
  return Math.hypot(current.x - previous.x, current.y - previous.y) <= radiusPx;
}

function isTransformHandleDoublePress(
  previous: TransformHandlePressSample | undefined,
  current: TransformHandlePressSample,
  windowMs: number = DOUBLE_PRESS_MS,
  radiusPx: number = 18
): boolean {
  return Boolean(
    previous &&
    current.time - previous.time <= windowMs &&
    previous.objectId === current.objectId &&
    previous.handleKind === current.handleKind &&
    Math.hypot(current.x - previous.x, current.y - previous.y) <= radiusPx
  );
}
const layerContextMenuItems: readonly LayerContextMenuItem[] = [
  { commandId: "layout.bringForward", label: "Move Object Forward" },
  { commandId: "layout.bringToFront", label: "Move Object to Front" },
  { commandId: "layout.sendBackward", label: "Move Object Backward" },
  { commandId: "layout.sendToBack", label: "Move Object to Back" }
];
const nativeOpenDocumentEvent = "chemdraft://open-document";
// Window for coalescing the multi-channel delivery (Tauri event + pending-document poll)
// of a single OS file-open, while still allowing a deliberate later re-open.
const NATIVE_OPEN_DEDUPE_WINDOW_MS = 1500;

interface NativeOpenDocumentPayload {
  path: string;
  displayName: string;
  contents: string;
}

interface ChemDraftAgentArtDebugSnapshot {
  ok: true;
  object: GraphicObject;
  editPoints?: NativeGraphicPathEditPoints;
  projectedEditPoints?: NativeGraphicPathEditPoints;
  plan: {
    pathD?: string;
    frameBounds: ReturnType<typeof planNativeArtVisual>["frameBounds"];
    markerHandles: ReturnType<typeof planNativeArtVisual>["markerHandles"];
    projectionTransform?: string;
    width: number;
    height: number;
  };
}

export interface MainWindowProps {
  initialPaletteMode?: PaletteMode;
  initialRulersVisible?: boolean;
  initialCrosshairsVisible?: boolean;
  initialDocument?: ChemDraftDocument;
  initialActiveToolCommandId?: string;
  nativePalette?: boolean;
}

// Native floating NSPanel palettes are the desktop renderer; the browser build always uses
// in-window web palettes. `localStorage["chemdraft.forceWebPalettes"] = "1"` is a runtime
// escape hatch (no rebuild) if native palettes misbehave on a given machine.
function shouldDefaultToNativePalettes(): boolean {
  if (!isDesktopRuntime()) {
    return false;
  }
  try {
    return globalThis.localStorage?.getItem("chemdraft.forceWebPalettes") !== "1";
  } catch {
    return true;
  }
}

export function MainWindow({
  initialPaletteMode = "floating",
  initialRulersVisible = true,
  initialCrosshairsVisible = true,
  initialDocument,
  initialActiveToolCommandId,
  nativePalette = shouldDefaultToNativePalettes()
}: MainWindowProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const moleculeTemplateInputRef = useRef<HTMLInputElement>(null);
  const canvasRegionRef = useRef<HTMLElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const webPaletteDragRef = useRef<PaletteDragState | null>(null);
  const nativeBondDragRef = useRef<NativeBondDragState | null>(null);
  const nativePlacementDragRef = useRef<NativePlacementDragState | null>(null);
  const nativeBondEditDragRef = useRef<NativeBondEditDragState | null>(null);
  const nativePartDragRef = useRef<NativePartDragState | null>(null);
  const objectDragRef = useRef<ObjectDragState | null>(null);
  const graphicCornerRadiusDragRef = useRef<GraphicCornerRadiusDragState | null>(null);
  const graphicPathEditDragRef = useRef<GraphicPathEditDragState | null>(null);
  const graphicMarkerDragRef = useRef<GraphicMarkerDragState | null>(null);
  const graphicGradientDragRef = useRef<GraphicGradientDragState | null>(null);
  const freehandArtDragRef = useRef<FreehandArtDragState | null>(null);
  const freehandArtPreviewPathRef = useRef<SVGPathElement | null>(null);
  const freehandArtPreviewFrameRef = useRef<number | undefined>(undefined);
  const tapeMeasureDragRef = useRef<TapeMeasureDragState | null>(null);
  const pathArtDrawRef = useRef<PathArtDrawState | null>(null);
  const bezierArtNodeDragRef = useRef<BezierArtNodeDragState | null>(null);
  const pendingObjectTransformPreviewRef = useRef<ObjectTransformPreviewState | undefined>(undefined);
  const objectTransformPreviewRafRef = useRef<number | undefined>(undefined);
  const objectRotateDragRef = useRef<ObjectRotateDragState | null>(null);
  const objectRotateReadoutTimeoutRef = useRef<number | undefined>(undefined);
  const projectedPlaneTiltDragRef = useRef<ProjectedPlaneTiltDragState | null>(null);
  const projectedPlaneTiltReadoutTimeoutRef = useRef<number | undefined>(undefined);
  const objectResizeDragRef = useRef<ObjectResizeDragState | null>(null);
  const objectResizeReadoutTimeoutRef = useRef<number | undefined>(undefined);
  const groupTransformDragRef = useRef<GroupTransformDragState | null>(null);
  const textResizeRef = useRef<TextResizeState | null>(null);
  const artStylePreviewRef = useRef<{ startDocument: ChemDraftDocument } | null>(null);
  const moleculeInspectorPreviewRef = useRef<{ startDocument: ChemDraftDocument } | null>(null);
  const palettePreviewHandlersRef = useRef<{
    preview: (commandId: string) => void;
    commit: (commandId: string) => void;
    cancel: () => void;
  }>({
    preview: () => undefined,
    commit: () => undefined,
    cancel: () => undefined
  });
  const selectionClipboardPayloadRef = useRef<ReturnType<typeof createSelectionClipboardPayload>>(undefined);
  const selectionClipboardPasteStateRef = useRef<SelectionClipboardPasteState | undefined>(undefined);
  const lastNativeOpenPayloadKeyRef = useRef<{ key: string; at: number } | undefined>(undefined);
  const textEditorFocusTimeoutsRef = useRef<number[]>([]);
  const selectionMarqueeRef = useRef<SelectionMarqueeState | null>(null);
  const selectionLassoRef = useRef<SelectionLassoState | null>(null);
  const marqueeMachineRef = useRef<InteractionState>(initialInteractionState());
  const lassoMachineRef = useRef<InteractionState>(initialInteractionState());
  const placementMachineRef = useRef<InteractionState>(initialInteractionState());
  const objectRotateMachineRef = useRef<InteractionState>(initialInteractionState());
  const projectedPlaneTiltMachineRef = useRef<InteractionState>(initialInteractionState());
  const objectDragMachineRef = useRef<InteractionState>(initialInteractionState());
  // 3D spin (Phase 4): authoritative state in a ref (read by pointer handlers,
  // immune to stale closures) mirrored into React state so the overlay re-renders.
  const spin3dStateRef = useRef<Spin3dState | undefined>(undefined);
  // Monotonic token identifying the current spin SESSION (a fresh embed / cancel / restart), so an
  // async continuation can detect that the session it captured was replaced — even a cancel-and-
  // restart on the same molecule. Bumped when the conformer identity changes, not on drags (a drag
  // reuses the same coords3d reference), so it survives orientation changes within one session.
  const spin3dSessionGenerationRef = useRef(0);
  // Lazily-loaded OCL stereo perceiver, cached so the synchronous rotate-commit paths can run the
  // read-back guard without an await (perception depends only on the 2D graph, not orientation).
  const spin3dStereoPerceiverRef = useRef<StereoPerceiver | undefined>(undefined);
  const [spin3dState, setSpin3dStateRender] = useState<Spin3dState | undefined>(undefined);
  // A first-time embed is in flight (no overlay yet): drives the on-canvas "Generating 3D…"
  // cue so the irreducible one-time embed wait reads as intentional progress, not a hang.
  // (A prefetch cache-hit clears this within ~90ms; the cue's CSS fade-in delay hides that
  // flash, so it only actually appears for the genuine cold/eager embed.)
  const [spin3dGenerating, setSpin3dGenerating] = useState<{
    objectId: string;
    box: { x: number; y: number; width: number; height: number };
    atomCount: number;
  } | undefined>(undefined);
  // Dirty-flag rAF: drag events write to the ref and set the flag; the scheduled
  // rAF renders once and stops. Zero frames fired when the scene isn't changing.
  const spinDirtyRef = useRef(false);
  const spinRafRef = useRef<number | null>(null);
  const groupTransformMachineRef = useRef<InteractionState>(initialInteractionState());
  const hoveredNativeAtomPointRef = useRef<{ objectId: string; point: ClientPoint } | undefined>(undefined);
  const gestureStartScaleRef = useRef(1);
  const lastCanvasPointerClientPointRef = useRef<ClientPoint | undefined>(undefined);
  const chemistryAdapter = useMemo(() => createRdkitAdapter(), []);
  /**
   * Run the property suite for the selected structure through the analysis worker and show the report.
   *
   * Off the main thread on purpose (§5): the descriptor pass is a synchronous WASM call, and running
   * it inline is what makes the canvas stutter. `slot: "selection"` means a second invocation while
   * one is in flight supersedes it rather than racing it.
   */
  /** Copy whatever the inspector currently shows. The pane decides the scope; this only delivers it. */
  const copyAnalysisText = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text);
    setStatus("Analysis copied");
  }, []);

  const runMolecularProperties = useCallback(
    async (format: string, structure: string, interpretationOverride: string | undefined): Promise<void> => {
      const client = analysisClient();
      if (!client) {
        setStatus("Analysis is unavailable in this runtime");
        return;
      }
      setAnalysisBusy(true);
      setStatus("Analyzing structure…");
      try {
        const run = await client.analyze(
          "selection",
          {
            format,
            value: structure,
            ...(interpretationOverride ? { interpretationOverride } : {})
          },
          { immediate: true }
        );
        // A superseded run is not an answer; the newer invocation owns the panel.
        if (run.status === "cancelled") return;
        const report = buildAnalysisReport(run);
        setAnalysisReport(report);
        setAnalysisInterpretation(interpretationOverride);
        setStatus(formatAnalysisRunStatus(run));
      } finally {
        setAnalysisBusy(false);
      }
    },
    []
  );

  // The Analyze surface (PLANS.md §9). `interpretationOverride` is the "— change" affordance from §1:
  // it re-runs the same selection against a derived interpretation and replaces the report.
  const [analysisReport, setAnalysisReport] = useState<AnalysisReport | undefined>();
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisInterpretation, setAnalysisInterpretation] = useState<string | undefined>();

  const [documentHistory, setDocumentHistory] = useState(() =>
    createDocumentHistory(initialDocument ?? createPhase4Document())
  );
  const document = documentHistory.present;
  const [objectTransformPreview, setObjectTransformPreview] = useState<ObjectTransformPreviewState | undefined>();
  const [pathArtPreview, setPathArtPreview] = useState<PathArtPreviewState | undefined>();
  const [fileState, setFileState] = useState<NativeFileState>({ dirty: false });
  const [activeEditorObjectId, setActiveEditorObjectId] = useState<string | undefined>();
  const [activeTextEditObjectId, setActiveTextEditObjectId] = useState<string | undefined>();
  const [activeTextSelection, setActiveTextSelection] = useState<{ objectId: string; range: NativeTextSelectionRange } | undefined>();
  const [activeGraphicTransformObjectId, setActiveGraphicTransformObjectId] = useState<string | undefined>();
  const [selectedGraphicPathNode, setSelectedGraphicPathNode] = useState<SelectedGraphicPathNodeState | undefined>();
  const [activeArtPaintTarget, setActiveArtPaintTarget] = useState<GraphicStylePaintTarget>("fill");
  const [artPaintTargetCueActive, setArtPaintTargetCueActive] = useState(false);
  const [activeAtomLabelEdit, setActiveAtomLabelEdit] = useState<AtomLabelEditState | undefined>();
  const [textStyleDefaults, setTextStyleDefaults] = useState<NativeTextStyle>(DefaultNativeTextStyle);
  const [activeToolState, setActiveToolState] = useState(() => createActiveToolState(initialActiveToolCommandId));
  const [toolsetRegistry, setToolsetRegistry] = useState<DesktopToolsetRegistry>(() => desktopToolsetRegistry);

  // The toolbar catalog is the single data brain: it composes the core manifest with live
  // plugin toolsets and the user's saved layout, and hands out immutable registry snapshots.
  // `toolsetRegistry` simply follows it.
  const toolbarCatalog = useMemo(() => createToolbarCatalog(), []);
  useEffect(() => {
    const applyRegistry = () => setToolsetRegistry(toolbarCatalog.registry());
    applyRegistry();
    return toolbarCatalog.onDidChange(applyRegistry);
  }, [toolbarCatalog]);
  const [visibleToolsetIds, setVisibleToolsetIds] = useState(() =>
    initialPaletteMode === "hidden" ? new Set<string>() : new Set(defaultVisibleToolsetIds)
  );
  const [customizeToolbarsOpen, setCustomizeToolbarsOpen] = useState(
    // Dev/test seam: open the Customize dialog directly in the browser (where the menu item is not
    // wired) with ?forceCustomize=1, so its drag/hide behavior can be exercised without the native app.
    () => import.meta.env.DEV && new URLSearchParams(globalThis.location?.search ?? "").get("forceCustomize") === "1"
  );
  // In-place customize mode for the Main toolbar (Safari-style). MainWindow owns the flag and
  // broadcasts it to the palettes; the ref lets late effects read it without re-subscribing.
  const [customizeMainToolbarActive, setCustomizeMainToolbarActive] = useState(false);
  const customizeMainToolbarActiveRef = useRef(false);
  customizeMainToolbarActiveRef.current = customizeMainToolbarActive;
  const [webPaletteFallback, setWebPaletteFallback] = useState(false);
  const effectiveNativePalette = nativePalette && !webPaletteFallback;
  const [webPalettePositions, setWebPalettePositions] = useState<Record<string, PalettePosition>>(() =>
    createDefaultToolsetPositions(desktopToolsetRegistry)
  );
  const [rulersVisible, setRulersVisible] = useState(initialRulersVisible);
  const [crosshairsVisible, setCrosshairsVisible] = useState(initialCrosshairsVisible);
  const [hoveredNativeAtom, setHoveredNativeAtom] = useState<HoveredNativeAtom | undefined>();
  const [hoveredNativeDeleteTarget, setHoveredNativeDeleteTarget] = useState<NativeMoleculeDeleteTarget | undefined>();
  // The ghost of the ring a template click would place (fuse / spiro / standalone / closure),
  // rendered from the same plan the click commits so preview and result can never diverge.
  const [templatePreview, setTemplatePreview] = useState<NativeTemplatePlacementPlan | undefined>();
  // Phase 7: native-part selection is stored as one legacy slot per molecule (recency-ordered, so
  // the last entry is the "primary"). This lets shift/marquee/lasso accumulate atoms/bonds/rings
  // across *different* molecules. `selectedNativeMoleculePart` (the primary) still drives every
  // single-molecule operation — drag, spin, delete, the inspector, dependency arrays — unchanged.
  const [selectedNativeMoleculeParts, setSelectedNativeMoleculeParts] = useState<NativeMoleculeSelectionPart[]>([]);
  const selectedNativeMoleculePart = selectedNativeMoleculeParts.length > 0
    ? selectedNativeMoleculeParts[selectedNativeMoleculeParts.length - 1]
    : undefined;
  // Back-compat single-slot setter: most call sites replace the whole native-part selection with a
  // single part or clear it (drag start, plain click, tool change, delete). Those keep working
  // verbatim; only the additive handlers call `setSelectedNativeMoleculeParts` to retain the parts
  // of other molecules.
  const setSelectedNativeMoleculePart = useCallback(
    (
      next:
        | NativeMoleculeSelectionPart
        | undefined
        | ((current: NativeMoleculeSelectionPart | undefined) => NativeMoleculeSelectionPart | undefined)
    ) => {
      setSelectedNativeMoleculeParts((currentParts) => {
        const currentPrimary = currentParts.length > 0 ? currentParts[currentParts.length - 1] : undefined;
        const resolved = typeof next === "function"
          ? (next as (current: NativeMoleculeSelectionPart | undefined) => NativeMoleculeSelectionPart | undefined)(currentPrimary)
          : next;
        return resolved ? [resolved] : [];
      });
    },
    []
  );
  const [selectionMarquee, setSelectionMarquee] = useState<SelectionMarqueeState | undefined>();
  const [selectionLasso, setSelectionLasso] = useState<SelectionLassoState | undefined>();
  const [tapeMeasure, setTapeMeasure] = useState<TapeMeasureOverlayState | undefined>();
  const [objectContextMenu, setObjectContextMenu] = useState<ObjectContextMenuState | undefined>();
  const [freeformNativeBond, setFreeformNativeBond] = useState<FreeformNativeBondPreview | undefined>();
  const [nativeDoubleBondSidePreview, setNativeDoubleBondSidePreview] = useState<NativeDoubleBondSidePreview | undefined>();
  const [graphicCornerRadiusReadout, setGraphicCornerRadiusReadout] = useState<GraphicCornerRadiusReadoutState | undefined>();
  const [objectRotateReadout, setObjectRotateReadout] = useState<ObjectRotateReadoutState | undefined>();
  const [projectedPlaneTiltReadout, setProjectedPlaneTiltReadout] = useState<ProjectedPlaneTiltReadoutState | undefined>();
  const [rotationInput, setRotationInput] = useState<RotationInputState | undefined>();
  const [transformRotationHandlesVisible, setTransformRotationHandlesVisible] = useState(false);
  const [objectResizeInput, setObjectResizeInput] = useState<ObjectResizeInputState | undefined>();
  const [objectResizeReadout, setObjectResizeReadout] = useState<ObjectResizeReadoutState | undefined>();
  const [artTransformQaDraft, setArtTransformQaDraft] = useState<ArtTransformQaDraft>({
    rotationDegrees: "28",
    tiltXDegrees: "35",
    tiltYDegrees: "-20"
  });
  const artTransformQaEnabled = useMemo(() => shouldEnableArtTransformQaLayer(), []);
  const artStyleQaEnabled = useMemo(() => shouldEnableArtStyleQaLayer(), []);
  const [artStyleQaRunCount, setArtStyleQaRunCount] = useState(0);
  const [viewport, setViewport] = useState(() =>
    createViewportState({ rulerUnit: rulerUnitForDocument(initialDocument) })
  );
  const [rulerFrame, setRulerFrame] = useState<RulerFrame>(() => ({
    horizontalScrollPx: 0,
    verticalScrollPx: 0,
    width: 0,
    height: 0
  }));
  const [status, setStatus] = useState("Blank native document");
  const [exportDialog, setExportDialog] = useState<ExportDialogState | undefined>();
  const [pageFitPrompt, setPageFitPrompt] = useState<ImportedPageFitPromptState | undefined>();
  const [customPageSizeDialog, setCustomPageSizeDialog] = useState<CustomPageSizeDialogState | undefined>();
  const [moleculeStyleOverridePrompt, setMoleculeStyleOverridePrompt] =
    useState<MoleculeStyleOverridePromptState | undefined>();
  const [interactive3dWorkspace, setInteractive3dWorkspace] = useState<Interactive3dWorkspaceState | undefined>();
  const [, setLastAnalysis] = useState<StructureAnalysisResult | null>(null);
  const invokeCommandRef = useRef<(commandId: string) => void | Promise<void>>(() => undefined);
  const documentRef = useRef(document);
  const documentHistoryRef = useRef<DocumentHistory>(documentHistory);
  const fileStateRef = useRef<NativeFileState>(fileState);
  // Flips true once the startup session-restore attempt has resolved; autosave waits for it.
  const documentSessionHydratedRef = useRef(false);
  const statusRef = useRef(status);
  const lastExportDirectoryRef = useRef<string | undefined>(undefined);
  const rotationInputRef = useRef<RotationInputState | undefined>(undefined);
  const objectResizeInputRef = useRef<ObjectResizeInputState | undefined>(undefined);
  const interactive3dWorkspaceRef = useRef<Interactive3dWorkspaceState | undefined>(undefined);
  const interactive3dCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const interactive3dOpenSerialRef = useRef(0);
  const interactive3dDragGenerationRef = useRef(0);
  const interactive3dDragSchedulerRef = useRef<Interactive3dDragSchedulerState | undefined>(undefined);
  const scheduleInteractive3dDragUpdateRef = useRef<(scheduler: Interactive3dDragSchedulerState) => void>(() => undefined);
  // Interactive 3D rides the spin overlay (owner directive: the tug experience must be
  // indistinguishable from ChemDraft — no separate surface, the sidecar stays invisible).
  // The command ARMS a tug attach; an effect opens a HEADLESS sidecar session once the spin
  // overlay is live, seeded from the spin conformer (a real embed — never flat 2D). The
  // session's coordinatesChanged events flow back into the same spin3dState the overlay
  // renders, so the molecule the user tugs IS the drawing.
  const interactive3dArmRef = useRef<{ objectId: string } | undefined>(undefined);
  const [interactive3dArmToken, setInteractive3dArmToken] = useState(0);
  // Maps a coords3d index → sidecar atomId, for writing streamed coordinates back into the
  // overlay geometry.
  const interactive3dAtomIdByIndexRef = useRef<string[]>([]);
  // Live tug gesture: which atom is grabbed and where it started, so screen motion maps to a
  // model-frame target for the dragged atom.
  const spin3dTugDragRef = useRef<{
    pointerId: number;
    atomId: string;
    startPageX: number;
    startPageY: number;
    startModel: Vec3;
  } | undefined>(undefined);
  // Forward reference to the drag-command dispatcher (defined below the spin pointer handlers),
  // so those handlers stay stable and free of a temporal-dead-zone dependency.
  const sendInteractive3dDragCommandRef = useRef<
    (phase: "beginDrag" | "updateDrag" | "endDrag", atomId: string, target?: Engine3DCoordinate) => void
  >(() => undefined);
  const activeToolCommandIdRef = useRef(activeToolState.activeCommandId);
  const nativePaletteRef = useRef(nativePalette);
  const toolBeforeTextPlacementRef = useRef<ActiveToolState | undefined>(undefined);
  const toolBeforeEyedropperRef = useRef<ActiveToolState | undefined>(undefined);
  const artPaintTargetCueTimerRef = useRef<number | undefined>(undefined);
  const hoveredNativeDeleteTargetRef = useRef<NativeMoleculeDeleteTarget | undefined>(undefined);
  const selectedNativeMoleculePartRef = useRef<NativeMoleculeSelectionPart | undefined>(undefined);
  const selectedNativeMoleculePartsRef = useRef<NativeMoleculeSelectionPart[]>([]);
  // Latest visible-toolset set, read synchronously in toggleToolset to decide whether a toggle is
  // closing the Rings toolbar (so we can clear the ring selection deliberately) without depending
  // on a possibly-stale render closure.
  const visibleToolsetIdsRef = useRef(visibleToolsetIds);
  // Last layout/customization state loaded from (or saved to) disk, so a visibility save merges onto
  // any other customization instead of clobbering it. `layoutHydratedRef` gates the visibility save
  // effect until the initial load has run, so the first render's default set can't overwrite the
  // saved file before we've read it.
  const layoutStateRef = useRef<ToolsetLayoutState | undefined>(undefined);
  // Live registry, read by the customize-edit listener so it never holds a stale snapshot.
  const toolsetRegistryRef = useRef(toolsetRegistry);
  const layoutHydratedRef = useRef(false);
  // Only persist visibility once we've SUCCESSFULLY read the existing layout file. If the load
  // failed (unreadable file, or a newer build's file that fails our strict schema), overwriting it
  // with defaults would silently destroy the user's saved customization — so we leave it untouched.
  const layoutSaveEnabledRef = useRef(false);
  // The toolsets whose visibility `visibleToolsetIds` is authoritative for: everything present at
  // load, plus anything the user has since toggled. A toolset that appears LATER (e.g. a plugin
  // contribution) is excluded until it's resolved, so a visibility save can't clobber its saved
  // `visible: true` down to `false` just because it isn't in the current visible set yet.
  const resolvedToolsetIdsRef = useRef<Set<string>>(new Set());
  // Serializes the fire-and-forget layout saves so two rapid visibility changes can't have their
  // disk writes complete out of order and leave the file disagreeing with the in-memory state.
  const layoutSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const shiftKeyPressedRef = useRef(false);
  const agentPointerTargetsRef = useRef<Map<number, EventTarget>>(new Map());
  const agentRuntimeSourceRef = useRef("disabled");
  // The last template-tool hover (page point + tool/template identity + resolved target), so a
  // template click can reuse exactly what the highlight is painting (see
  // currentTemplateTargetFromHoverOrHit) rather than recompute a possibly-disagreeing hit.
  const templateHoverTargetRef = useRef<TemplateHoverSample | undefined>(undefined);
  // Memo key for the ghost preview so we only recompute the plan (and its Kekulé pass) when the
  // hovered target or pointer cell changes, not on every sub-pixel pointer move.
  const templatePreviewKeyRef = useRef<string | undefined>(undefined);
  const activeTextSelectionRef = useRef<{ objectId: string; range: NativeTextSelectionRange } | undefined>(undefined);
  const toolbarStyleTargetRef = useRef<ToolbarStyleTargetSnapshot | undefined>(undefined);
  const viewportRef = useRef(viewport);
  // Shared across the page and object selection handlers so a whole-molecule double-click is
  // detected regardless of which handler each of the two presses routes to (see
  // isSelectionDoublePress).
  const lastSelectionPressRef = useRef<SelectionPressSample | undefined>(undefined);
  const lastTransformHandlePressRef = useRef<TransformHandlePressSample | undefined>(undefined);

  documentRef.current = document;
  documentHistoryRef.current = documentHistory;
  fileStateRef.current = fileState;
  statusRef.current = status;
  rotationInputRef.current = rotationInput;
  objectResizeInputRef.current = objectResizeInput;
  interactive3dWorkspaceRef.current = interactive3dWorkspace;
  activeToolCommandIdRef.current = activeToolState.activeCommandId;
  nativePaletteRef.current = nativePalette;
  hoveredNativeDeleteTargetRef.current = hoveredNativeDeleteTarget;
  selectedNativeMoleculePartRef.current = selectedNativeMoleculePart;
  selectedNativeMoleculePartsRef.current = selectedNativeMoleculeParts;
  visibleToolsetIdsRef.current = visibleToolsetIds;
  toolsetRegistryRef.current = toolsetRegistry;

  const selectedMolecule = getSelectedMolecule(document);
  const selectedTextObject = getSelectedTextObject(document);
  const selectedTextRange = selectedTextObject &&
    activeTextEditObjectId === selectedTextObject.id &&
    activeTextSelection?.objectId === selectedTextObject.id &&
    activeTextSelection.range.start !== activeTextSelection.range.end
    ? activeTextSelection.range
    : undefined;
  const selectedTextScript = selectedTextObject
    ? selectedTextRange
      ? textScriptForTextRange(selectedTextObject, selectedTextRange)
      : textScriptForTextObject(selectedTextObject)
    : "normal";
  const selectedNativePartObject = selectedNativeMoleculePart
    ? findDocumentObject(document, selectedNativeMoleculePart.objectId)
    : undefined;
  const selectedMoleculeForStyle = selectedNativePartObject?.type === "molecule"
    ? selectedNativePartObject
    : selectedMolecule;
  const selectedToolbarObject = document.selection.objectIds.length === 1
    ? findDocumentObject(document, document.selection.objectIds[0])
    : undefined;
  useEffect(() => {
    prewarmNativeDialogModule();
  }, []);
  useEffect(() => {
    if (!selectedGraphicPathNode) {
      return;
    }

    const object = findDocumentObject(document, selectedGraphicPathNode.objectId);
    const nodeEditPoints = object?.type === "graphic" ? nativeGraphicPathNodeEditPoints(object) : undefined;
    const pathFeedbackToolActive = activeToolState.activeKind === "selection" ||
      activeToolState.activeCommandId === "tool.art.scissors";
    const stillSelected = pathFeedbackToolActive &&
      document.selection.objectIds.includes(selectedGraphicPathNode.objectId);
    const nodeStillExists = nodeEditPoints?.nodes.some((node) => node.index === selectedGraphicPathNode.nodeIndex) ?? false;
    if (!stillSelected || !nodeStillExists) {
      setSelectedGraphicPathNode(undefined);
    }
  }, [activeToolState.activeCommandId, activeToolState.activeKind, document, selectedGraphicPathNode]);
  const currentToolbarTextStyle = useMemo(() => {
    if (selectedTextObject) {
      return selectedTextRange
        ? nativeTextStyleFromObjectStyle({
            ...selectedTextObject.style,
            ...textStyleForTextRange(selectedTextObject, selectedTextRange)
          })
        : nativeTextStyleFromObjectStyle(selectedTextObject.style);
    }

    if (selectedMoleculeForStyle) {
      const drawingStyle = nativeDrawingStyleFromObjectStyle(selectedMoleculeForStyle.style);
      return nativeTextStyleFromObjectStyle({
        ...textStyleDefaults,
        color: selectedNativeMoleculePart?.objectId === selectedMoleculeForStyle.id
          ? nativeMoleculeSelectionColor(selectedMoleculeForStyle, selectedNativeMoleculePart, drawingStyle)
          : drawingStyle.bondColor
      });
    }

    if (selectedToolbarObject) {
      return nativeTextStyleFromObjectStyle({
        ...textStyleDefaults,
        color: documentObjectToolbarColor(selectedToolbarObject)
      });
    }

    return textStyleDefaults;
  }, [
    selectedMoleculeForStyle,
    selectedNativeMoleculePart,
    selectedTextObject,
    selectedTextRange,
    selectedToolbarObject,
    textStyleDefaults
  ]);
  const currentToolbarObjectColor = useMemo(() => {
    if (selectedMoleculeForStyle) {
      const drawingStyle = nativeDrawingStyleFromObjectStyle(selectedMoleculeForStyle.style);
      return selectedNativeMoleculePart?.objectId === selectedMoleculeForStyle.id
        ? nativeMoleculeSelectionColor(selectedMoleculeForStyle, selectedNativeMoleculePart, drawingStyle)
        : drawingStyle.bondColor;
    }

    if (selectedToolbarObject) {
      return documentObjectToolbarColor(selectedToolbarObject);
    }

    return textStyleDefaults.color;
  }, [
    selectedMoleculeForStyle,
    selectedNativeMoleculePart,
    selectedToolbarObject,
    textStyleDefaults.color
  ]);
  /**
   * The §1 "— change" affordance, from the palette. Re-runs the current selection against another
   * interpretation; a palette with no selection behind it simply does nothing.
   */
  const recomputeAnalysisFor = useCallback(
    (interpretationId: string | undefined) => {
      const molecule = getSelectedMolecule(document);
      if (!molecule) return;
      void runMolecularProperties(molecule.structureFormat, molecule.structure, interpretationId);
    },
    [document, runMolecularProperties]
  );

  const currentMoleculeInspector = useMemo(
    () => createMoleculeInspectorModel(document, {
      selectedObjectIds: document.selection.objectIds,
      selectedPart: selectedNativeMoleculePart,
      selectedParts: selectedNativeMoleculeParts
    }),
    [document, document.selection.objectIds, selectedNativeMoleculePart, selectedNativeMoleculeParts]
  );
  const currentArtStyle = useMemo(() => {
    const model = createArtInspectorModel({
      document,
      selectedGraphicObjects: [],
      selectedVisualObjects: selectedVisualObjectsForArtInspector(document, {
        excludeMoleculeObjectIds: new Set(selectedNativeMoleculeParts.map((part) => part.objectId))
      }),
      requestedPaintTarget: activeArtPaintTarget
    });
    return model.selectedCount > 0 ? model : undefined;
  }, [activeArtPaintTarget, document, selectedNativeMoleculeParts]);
  const effectiveArtPaintTarget = currentArtStyle?.activePaintTarget ?? activeArtPaintTarget;
  const currentEyedropperStatus = currentArtStyle
    ? eyedropperStatusLabel(effectiveArtPaintTarget)
    : eyedropperChooseTargetStatusLabel(effectiveArtPaintTarget);
  const currentToolbarTextScript = selectedTextObject ? selectedTextScript : "normal";

  useEffect(() => {
    if (activeToolState.activeCommandId === "tool.art.eyedropper") {
      setStatus(currentEyedropperStatus);
    }
  }, [activeToolState.activeCommandId, currentEyedropperStatus]);

  const currentToolbarTextStateRef = useRef(
    createToolsetTextStylePayload(
      currentToolbarTextStyle,
      currentToolbarTextScript,
      currentArtStyle,
      activeArtPaintTarget,
      currentMoleculeInspector,
      analysisReport,
      analysisBusy
    )
  );
  currentToolbarTextStateRef.current = createToolsetTextStylePayload(
    currentToolbarTextStyle,
    currentToolbarTextScript,
    currentArtStyle,
    activeArtPaintTarget,
    currentMoleculeInspector,
    analysisReport,
    analysisBusy
  );
  const activeEditorMolecule =
    selectedMolecule && selectedMolecule.id === activeEditorObjectId ? selectedMolecule : undefined;
  const activeNativeBondToolStyle = nativeBondStyleForToolCommand(activeToolState.activeCommandId);
  const activeNativeBondDisplayStyle = activeNativeBondToolStyle && activeNativeBondToolStyle !== "solid"
    ? activeNativeBondToolStyle
    : undefined;
  const activeNativeTemplateId = nativeTemplateForToolCommand(activeToolState.activeCommandId);
  const bondToolActive = activeNativeBondToolStyle !== undefined;
  const activeChargeToolValue = chargeValueForToolCommand(activeToolState.activeCommandId);
  const activeNativeArtTool = nativeArtToolForCommand(activeToolState.activeCommandId);
  const activePage = document.pages[0];
  const plannedDisplayPage = useMemo(() => {
    if (!nativeDoubleBondSidePreview) {
      return activePage;
    }

    return {
      ...activePage,
      objects: activePage.objects.map((object) => {
        if (object.type !== "molecule" || object.id !== nativeDoubleBondSidePreview.objectId) {
          return object;
        }

        return {
          ...object,
          bonds: object.bonds.map((bond) => (
            bond.id === nativeDoubleBondSidePreview.bondId && bond.order === "double"
              ? { ...bond, display: { ...(bond.display ?? {}), doubleBondSide: nativeDoubleBondSidePreview.side } }
              : bond
          ))
        };
      })
    };
  }, [activePage, nativeDoubleBondSidePreview]);
  const editorSvgDisplayPage = useMemo(() => {
    const svgObjects = plannedDisplayPage.objects.filter((object) => editorPageSvgSurfaceIncludesObject(object));
    if (svgObjects.length === plannedDisplayPage.objects.length) {
      return plannedDisplayPage;
    }

    return { ...plannedDisplayPage, objects: svgObjects };
  }, [plannedDisplayPage]);
  const pageSvgRenderPlan = useMemo(() =>
    markFrame("planPageSvgRender", () => planPageSvgRender(editorSvgDisplayPage)), [editorSvgDisplayPage]);
  const nativeMoleculeOverlayFragments = useMemo(() =>
    markFrame("planNativeMoleculeOverlayRender", () => nativeMoleculeOverlayFragmentsByObjectId(plannedDisplayPage)), [plannedDisplayPage]);
  const pageRulerUnit = useMemo(() => rulerUnitForPageLayout(activePage.layout), [activePage.layout.sourceUnit]);
  const canUndo = documentHistory.past.length > 0;
  const canRedo = documentHistory.future.length > 0;
  const quickActions = useMemo(
    () => createQuickActions(document, selectedMolecule, { canUndo, canRedo }),
    [canRedo, canUndo, document, selectedMolecule]
  );
  const layerActions = useMemo(() => createLayerActions(document), [document]);
  const pageCssVars = useMemo(
    () =>
      ({
        "--page-layout-width": `${activePage.width}px`,
        "--page-layout-height": `${activePage.height}px`,
        // Bond pointer catcher width — single source of truth in hitTest.ts so the DOM
        // catcher stays a routing superset of the model tolerance (invariant #1).
        "--bond-hit-stroke-px": `${BOND_HIT_CATCHER_STROKE_PX}`
      }) as CSSProperties,
    [activePage.height, activePage.width]
  );
  const horizontalCrosshairTicks = useMemo(
    () => buildCrosshairTicks(activePage.width, pageRulerUnit),
    [activePage.width, pageRulerUnit]
  );
  const verticalCrosshairTicks = useMemo(
    () => buildCrosshairTicks(activePage.height, pageRulerUnit),
    [activePage.height, pageRulerUnit]
  );
  const visibleFloatingToolsets = useMemo(
    () => toolsetRegistry.listToolsets().filter((toolset) => visibleToolsetIds.has(toolset.id)),
    [toolsetRegistry, visibleToolsetIds]
  );
  const ringInspectorOpen = visibleToolsetIds.has(ringInspectorToolsetId);
  const chargeResolutionByMoleculeId = useMemo(() => {
    const byMoleculeId = new Map<string, ReadonlyMap<string, number>>();
    activePage.objects.forEach((object) => {
      if (object.type !== "molecule") {
        return;
      }

      const associations = nativeChargeAssociationsForMolecule(object, activePage.objects);
      byMoleculeId.set(object.id, nativeChargeByAtomIdFromAssociations(associations));
    });
    return byMoleculeId;
  }, [activePage.objects]);
  const activeTool = activeToolState.activeCommandId;
  const [distributeMode, setDistributeMode] = useState<DocumentDistributeMode>("centers");
  useEffect(() => {
    if (activeTool !== "tool.art.measure") {
      tapeMeasureDragRef.current = null;
      setTapeMeasure(undefined);
    }
  }, [activeTool]);
  const toolCommandSpecs = useMemo(
    () => withStandaloneDrawingToolCommands(getToolsetCommandSpecs(toolsetRegistry)),
    [toolsetRegistry]
  );
  const shellCommandSpecs = useMemo(
    () => allShellCommands(document, selectedMolecule, {
      availability: { canUndo, canRedo },
      registry: toolsetRegistry
    }),
    [canRedo, canUndo, document, selectedMolecule, toolsetRegistry]
  );
  const shellCommandsById = useMemo(
    () => createShellCommandMap(shellCommandSpecs),
    [shellCommandSpecs]
  );
  const shellCommandSpecsRef = useRef(shellCommandSpecs);
  shellCommandSpecsRef.current = shellCommandSpecs;
  const shellCommandSpecsSignature = useMemo(
    () => toolsetCommandSpecsSignature(shellCommandSpecs),
    [shellCommandSpecs]
  );
  useEffect(() => {
    void broadcastToolsetCommandSpecs(shellCommandSpecsRef.current).catch(() => undefined);
  }, [shellCommandSpecsSignature]);
  const shortcutCommands = useMemo(
    () => [
      ...quickActions,
      ...layerActions,
      ...editActions,
      ...toolCommandSpecs,
      ...viewActions,
      ...pageSizeActions,
      ...pageOrientationActions,
      ...textToolbarActions,
      ...toolbarCustomizationActions
    ],
    [layerActions, quickActions, toolCommandSpecs]
  );
  const shortcutRegistry = useMemo(
    () => createDesktopShortcutRegistry(shortcutCommands),
    [shortcutCommands]
  );
  const assignHoveredNativeDeleteTarget = useCallback((target: NativeMoleculeDeleteTarget | undefined) => {
    hoveredNativeDeleteTargetRef.current = target;
    if (!target || target.kind !== "atom") {
      hoveredNativeAtomPointRef.current = undefined;
    }
    setHoveredNativeDeleteTarget(target);
  }, []);
  const flashArtPaintTargetControls = useCallback(() => {
    if (artPaintTargetCueTimerRef.current !== undefined) {
      window.clearTimeout(artPaintTargetCueTimerRef.current);
    }

    setArtPaintTargetCueActive(true);
    artPaintTargetCueTimerRef.current = window.setTimeout(() => {
      setArtPaintTargetCueActive(false);
      artPaintTargetCueTimerRef.current = undefined;
    }, 1500);
  }, []);
  useEffect(() => () => {
    if (artPaintTargetCueTimerRef.current !== undefined) {
      window.clearTimeout(artPaintTargetCueTimerRef.current);
      artPaintTargetCueTimerRef.current = undefined;
    }
  }, []);
  const updateToolbarStyleTargetSnapshot = useCallback((
    nextDocument: ChemDraftDocument,
    moleculePart: NativeMoleculeSelectionPart | undefined = selectedNativeMoleculePart
  ) => {
    const objectIds = [...nextDocument.selection.objectIds];
    const textRange = activeTextSelectionRef.current;
    const colorMoleculePart = nativeSelectionColorTarget(moleculePart);
    if (objectIds.length === 0 && !colorMoleculePart && !textRange) {
      return;
    }

    toolbarStyleTargetRef.current = {
      objectIds,
      moleculePart: colorMoleculePart,
      textRange
    };
  }, [selectedNativeMoleculePart]);
  const installDocumentHistory = useCallback((history: DocumentHistory) => {
    documentHistoryRef.current = history;
    documentRef.current = history.present;
    updateToolbarStyleTargetSnapshot(history.present);
    setDocumentHistory(history);
  }, [updateToolbarStyleTargetSnapshot]);
  const resetDocumentHistory = useCallback((nextDocument: ChemDraftDocument, nextFileState: NativeFileState = { dirty: false }) => {
    if (nextDocument.selection.objectIds.length === 0) {
      toolbarStyleTargetRef.current = undefined;
    }
    installDocumentHistory(createDocumentHistory(nextDocument));
    fileStateRef.current = nextFileState;
    setFileState(nextFileState);
  }, [installDocumentHistory]);
  const replacePresentDocument = useCallback((
    nextDocumentOrUpdate: ChemDraftDocument | ((current: ChemDraftDocument) => ChemDraftDocument)
  ): boolean => {
    const currentHistory = documentHistoryRef.current;
    const nextDocument = typeof nextDocumentOrUpdate === "function"
      ? nextDocumentOrUpdate(currentHistory.present)
      : nextDocumentOrUpdate;
    if (nextDocument === currentHistory.present) {
      return false;
    }

    installDocumentHistory({
      ...currentHistory,
      present: nextDocument
    });
    return true;
  }, [installDocumentHistory]);
  const commitDocumentChange = useCallback((
    nextDocumentOrUpdate: ChemDraftDocument | ((current: ChemDraftDocument) => ChemDraftDocument)
  ): boolean => {
    const currentHistory = documentHistoryRef.current;
    const nextDocument = typeof nextDocumentOrUpdate === "function"
      ? nextDocumentOrUpdate(currentHistory.present)
      : nextDocumentOrUpdate;
    if (nextDocument === currentHistory.present) {
      return false;
    }

    installDocumentHistory({
      past: [...currentHistory.past, currentHistory.present].slice(-DOCUMENT_HISTORY_LIMIT),
      present: nextDocument,
      future: []
    });
    setFileState((current) => {
      const nextFileState = { ...current, dirty: true };
      fileStateRef.current = nextFileState;
      return nextFileState;
    });
    return true;
  }, [installDocumentHistory]);
  /** Drag-session commits install their history entry directly so undo lands on the pre-drag
   *  document — `commitDocumentChange` would record the last preview frame instead. This is that
   *  shared install plus the unsaved-changes bookkeeping every document mutation owes. */
  const commitDocumentHistoryFrom = useCallback((
    startDocument: ChemDraftDocument,
    nextDocument: ChemDraftDocument
  ) => {
    const currentHistory = documentHistoryRef.current;
    installDocumentHistory({
      past: [...currentHistory.past, startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: nextDocument,
      future: []
    });
    setFileState((current) => {
      const nextFileState = { ...current, dirty: true };
      fileStateRef.current = nextFileState;
      return nextFileState;
    });
  }, [installDocumentHistory]);
  const applyArtTransformQaScene = useCallback(() => {
    const changed = commitDocumentChange((current) => artTransformQaSceneDocument(current, artTransformQaDraft));
    if (changed) {
      setSelectedNativeMoleculePart(undefined);
      setStatus("Art QA scene applied");
    }
  }, [artTransformQaDraft, commitDocumentChange]);
  const applyArtTransformQaToSelection = useCallback(() => {
    const changed = commitDocumentChange((current) =>
      artTransformQaSelectionDocument(current, artTransformQaDraft)
    );
    if (changed) {
      setSelectedNativeMoleculePart(undefined);
      setStatus("Art QA transform applied");
    } else {
      setStatus("Art QA needs a selected graphic object");
    }
  }, [artTransformQaDraft, commitDocumentChange]);
  const applyArtStyleQaScene = useCallback(() => {
    const changed = commitDocumentChange(artStyleQaSceneDocument);
    setArtStyleQaRunCount(0);
    if (changed) {
      setSelectedNativeMoleculePart(undefined);
      setStatus("Art style QA scene applied");
    }
  }, [commitDocumentChange]);
  const runArtStyleQaStress = useCallback(() => {
    const nextRunCount = artStyleQaRunCount + 1;
    const changed = commitDocumentChange((current) => artStyleQaStressDocument(current, nextRunCount));
    if (changed) {
      setSelectedNativeMoleculePart(undefined);
      setArtStyleQaRunCount(nextRunCount);
      setStatus(`Art style QA stress pass ${nextRunCount}`);
    } else {
      setStatus("Art style QA stress could not create graphics");
    }
  }, [artStyleQaRunCount, commitDocumentChange]);
  const updateRotationInput = useCallback((nextInput: RotationInputState | undefined) => {
    rotationInputRef.current = nextInput;
    setRotationInput(nextInput);
  }, []);
  const updateObjectResizeInput = useCallback((nextInput: ObjectResizeInputState | undefined) => {
    objectResizeInputRef.current = nextInput;
    setObjectResizeInput(nextInput);
  }, []);
  const markDocumentDirty = useCallback(() => {
    setFileState((current) => {
      const nextFileState = { ...current, dirty: true };
      fileStateRef.current = nextFileState;
      return nextFileState;
    });
  }, []);
  const commitLiveInputPreview = useCallback((startDocument: ChemDraftDocument): boolean => {
    const currentHistory = documentHistoryRef.current;
    if (currentHistory.present === startDocument) {
      return false;
    }

    installDocumentHistory({
      past: [...currentHistory.past, startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: currentHistory.present,
      future: []
    });
    markDocumentDirty();
    return true;
  }, [installDocumentHistory, markDocumentDirty]);

  useEffect(() => {
    if (!bondToolActive) {
      setNativeDoubleBondSidePreview(undefined);
    }
  }, [bondToolActive]);

  useEffect(() => {
    if (!nativePalette) {
      return undefined;
    }

    let active = true;
    void loadToolsetLayoutState()
      .then((layoutState) => {
        if (!active) {
          return;
        }

        if (layoutState !== undefined) {
          // Fold pre-flatten (7-group) Main-toolbar state onto the single-group manifest before anything
          // consumes it; the next save persists the migrated shape.
          const migrated = migrateLegacyMainToolbarLayoutState(layoutState);
          toolbarCatalog.setLayoutState(migrated);
          const nextRegistry = toolbarCatalog.registry();
          setWebPalettePositions(createDefaultToolsetPositions(nextRegistry));
          // The registry's default-visible set already reflects the saved toolsetOverrides[].visible,
          // so this restores exactly the palettes the user last had open.
          setVisibleToolsetIds(createDefaultVisibleToolsetIds(nextRegistry));
          try {
            layoutStateRef.current = parseToolsetLayoutState(migrated);
          } catch {
            layoutStateRef.current = undefined;
          }
        }

        // Initial load finished and the file read cleanly. Record which toolsets we've resolved
        // visibility for, and allow saves to persist — a save now merges onto the file we just read
        // rather than replacing it.
        resolvedToolsetIdsRef.current = new Set(toolbarCatalog.registry().listToolsets().map((toolset) => toolset.id));
        layoutSaveEnabledRef.current = true;
        layoutHydratedRef.current = true;
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setWebPaletteFallback(true);
        setVisibleToolsetIds(createDefaultVisibleToolsetIds(desktopToolsetRegistry));
        setStatus(`Native toolbar layout unavailable; using in-window toolbars (${error instanceof Error ? error.message : String(error)})`);
        resolvedToolsetIdsRef.current = new Set(desktopToolsetRegistry.listToolsets().map((toolset) => toolset.id));
        // layoutSaveEnabledRef stays FALSE on purpose: the existing file didn't read/parse cleanly
        // (unreadable, or a newer build's schema), so persisting defaults over it would destroy the
        // user's saved customization. Leave the file untouched until a launch reads it successfully.
        layoutHydratedRef.current = true;
      });

    return () => {
      active = false;
    };
  }, [nativePalette, toolbarCatalog]);

  // Persist palette visibility whenever it changes so the set of open palettes is restored next
  // launch. Gated on layoutHydratedRef so the first render's default set can't overwrite the saved
  // file before the load above has read it; merges onto the last known layout state so other
  // customization isn't clobbered.
  useEffect(() => {
    if (!nativePalette || !layoutHydratedRef.current || !layoutSaveEnabledRef.current) {
      return;
    }
    // Only record visibility for toolsets we've actually resolved (present at load or user-toggled).
    // A just-appeared toolset (e.g. a plugin contribution not yet reflected in visibleToolsetIds) is
    // left to `preserved` in the merge, so its saved `visible: true` isn't clobbered to `false`.
    const resolvedToolsetIds = toolsetRegistry
      .listToolsets()
      .map((toolset) => toolset.id)
      .filter((id) => resolvedToolsetIdsRef.current.has(id));
    const nextState = mergeVisibilityIntoLayoutState(layoutStateRef.current, resolvedToolsetIds, visibleToolsetIds);
    layoutStateRef.current = nextState;
    // Chain the writes so their completion order matches the order the states were produced.
    layoutSaveChainRef.current = layoutSaveChainRef.current
      .then(() => saveToolsetLayoutState(nextState))
      .catch(() => undefined);
  }, [visibleToolsetIds, nativePalette, toolsetRegistry]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => () => {
    if (objectRotateReadoutTimeoutRef.current !== undefined) {
      window.clearTimeout(objectRotateReadoutTimeoutRef.current);
    }
    if (projectedPlaneTiltReadoutTimeoutRef.current !== undefined) {
      window.clearTimeout(projectedPlaneTiltReadoutTimeoutRef.current);
    }
    if (objectResizeReadoutTimeoutRef.current !== undefined) {
      window.clearTimeout(objectResizeReadoutTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    void broadcastToolsetActiveTool(activeToolState.activeCommandId).catch(() => undefined);
  }, [activeToolState.activeCommandId]);

  useEffect(() => {
    void broadcastToolsetTextStyle(
      createToolsetTextStylePayload(
        currentToolbarTextStyle,
        currentToolbarTextScript,
        currentArtStyle,
        activeArtPaintTarget,
        currentMoleculeInspector,
        analysisReport,
        analysisBusy
      )
    ).catch(() => undefined);
    // `analysisReport` is in the deps so a detached Molecular Inspector window refreshes when a new
    // run lands — without it the palette would show the first report forever.
  }, [
    activeArtPaintTarget,
    analysisBusy,
    analysisReport,
    currentArtStyle,
    currentMoleculeInspector,
    currentToolbarTextScript,
    currentToolbarTextStyle
  ]);

  useEffect(() => {
    if (!bondToolActive) {
      nativeBondDragRef.current = null;
      setHoveredNativeAtom(undefined);
      setFreeformNativeBond(undefined);
    }
  }, [bondToolActive]);

  useEffect(() => {
    setSelectedNativeMoleculeParts((current) => {
      if (current.length === 0) {
        return current;
      }
      const pruned = current.flatMap((part) => {
        const next = pruneNativeMoleculePart(document, part);
        return next ? [next] : [];
      });
      // Preserve the identity when nothing dropped and each entry is unchanged, so an unrelated
      // document mutation doesn't churn the selection (atom/bond entries return the same ref).
      const unchanged = pruned.length === current.length && pruned.every((part, index) => part === current[index]);
      return unchanged ? current : pruned;
    });
  }, [document]);

  useEffect(() => {
    setActiveTextEditObjectId((current) => {
      if (!current) {
        return current;
      }

      return findDocumentObject(document, current)?.type === "text" ? current : undefined;
    });
  }, [document]);

  useEffect(() => {
    setActiveAtomLabelEdit((current) => {
      if (!current) {
        return current;
      }

      const object = findDocumentObject(document, current.objectId);
      if (object?.type !== "molecule" || !object.atoms.some((atom) => atom.id === current.atomId)) {
        return undefined;
      }

      return current;
    });
  }, [document]);

  useEffect(() => {
    setViewport((current) => {
      if (current.rulerUnit.kind === pageRulerUnit.kind) {
        return current;
      }

      const next = { ...current, rulerUnit: pageRulerUnit };
      viewportRef.current = next;
      return next;
    });
  }, [pageRulerUnit]);

  useEffect(() => {
    if (objectContextMenu && !findDocumentObject(document, objectContextMenu.objectId)) {
      setObjectContextMenu(undefined);
    }
  }, [document, objectContextMenu]);

  const updateRulerFrame = useCallback(() => {
    const canvas = canvasRegionRef.current;
    const page = pageRef.current;
    if (!canvas || !page) {
      return;
    }

    const canvasRect = canvas.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const thickness = rulersVisible ? RULER_THICKNESS : 0;
    const nextFrame = {
      horizontalScrollPx: (canvasRect.left + thickness - pageRect.left) / viewportRef.current.scale,
      verticalScrollPx: (canvasRect.top + thickness - pageRect.top) / viewportRef.current.scale,
      width: Math.max(0, canvas.clientWidth - thickness),
      height: Math.max(0, canvas.clientHeight - thickness)
    };

    setRulerFrame((current) =>
      rulerFramesEqual(current, nextFrame) ? current : nextFrame
    );
  }, [rulersVisible]);

  useEffect(() => {
    const canvas = canvasRegionRef.current;
    const page = pageRef.current;
    if (!canvas || !page) {
      return undefined;
    }

    let animationFrame = 0;
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(updateRulerFrame);
    };
    const resizeObserver = new ResizeObserver(scheduleUpdate);

    canvas.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    resizeObserver.observe(canvas);
    resizeObserver.observe(page);
    scheduleUpdate();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      canvas.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      resizeObserver.disconnect();
    };
  }, [rulersVisible, updateRulerFrame, viewport.scale]);

  const zoomCanvasAtClientPoint = useCallback((nextScale: number, clientPoint: ClientPoint) => {
    const canvas = canvasRegionRef.current;
    const page = pageRef.current;
    const currentScale = viewportRef.current.scale;

    if (!canvas || !page) {
      setViewport((current) => {
        const next = setViewportScale(current, nextScale);
        viewportRef.current = next;
        return next;
      });
      return;
    }

    const pageRect = page.getBoundingClientRect();
    const focalPagePoint = clientToPage(clientPoint, { pageRect, scale: currentScale });

    setViewport((current) => {
      const next = setViewportScale(current, nextScale);
      viewportRef.current = next;
      return next;
    });

    window.requestAnimationFrame(() => {
      const nextCanvas = canvasRegionRef.current;
      const nextPage = pageRef.current;
      if (!nextCanvas || !nextPage) {
        return;
      }

      const nextPageRect = nextPage.getBoundingClientRect();
      const nextClientPoint = pageToClient(focalPagePoint, {
        pageRect: nextPageRect,
        scale: viewportRef.current.scale
      });

      nextCanvas.scrollLeft += nextClientPoint.x - clientPoint.x;
      nextCanvas.scrollTop += nextClientPoint.y - clientPoint.y;
    });
  }, []);

  const zoomCanvasFromWheelEvent = useCallback((event: Pick<globalThis.WheelEvent, "clientX" | "clientY" | "ctrlKey" | "deltaY" | "metaKey">) => {
    if (!shouldUseViewportWheelZoom(event)) {
      return false;
    }

    zoomCanvasAtClientPoint(viewportRef.current.scale * wheelDeltaToZoomFactor(event.deltaY), {
      x: event.clientX,
      y: event.clientY
    });
    return true;
  }, [zoomCanvasAtClientPoint]);

  // Bind zoom gestures directly to the canvas element. Earlier this lived on
  // `window` behind an `eventIsInsideCanvas` guard that relied on `event.target`
  // (unreliable for WebKit gesture events) and a stale pointer-tracking ref, which
  // silently rejected valid trackpad pinches. Listening on the canvas makes every
  // event in-scope by construction, so no guard is needed.
  useEffect(() => {
    const canvas = canvasRegionRef.current;
    if (!canvas) {
      return undefined;
    }

    const handleNativeWheel = (event: globalThis.WheelEvent) => {
      if (!zoomCanvasFromWheelEvent(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    };
    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      gestureStartScaleRef.current = viewportRef.current.scale;
    };
    const handleGestureChange = (event: Event) => {
      const gesture = event as WebKitGestureEvent;
      event.preventDefault();
      event.stopPropagation();
      zoomCanvasAtClientPoint(
        gestureStartScaleRef.current * (gesture.scale ?? 1),
        clientPointFromGesture(gesture, canvas, lastCanvasPointerClientPointRef.current)
      );
    };
    const handleGestureEnd = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      gestureStartScaleRef.current = viewportRef.current.scale;
    };
    const listenerOptions = { capture: true, passive: false } as AddEventListenerOptions;

    canvas.addEventListener("wheel", handleNativeWheel, listenerOptions);
    canvas.addEventListener("gesturestart", handleGestureStart, listenerOptions);
    canvas.addEventListener("gesturechange", handleGestureChange, listenerOptions);
    canvas.addEventListener("gestureend", handleGestureEnd, listenerOptions);

    return () => {
      canvas.removeEventListener("wheel", handleNativeWheel, listenerOptions);
      canvas.removeEventListener("gesturestart", handleGestureStart, listenerOptions);
      canvas.removeEventListener("gesturechange", handleGestureChange, listenerOptions);
      canvas.removeEventListener("gestureend", handleGestureEnd, listenerOptions);
    };
  }, [zoomCanvasAtClientPoint, zoomCanvasFromWheelEvent]);

  const clearNativeRingParts = useCallback(() => {
    setSelectedNativeMoleculeParts((current) => {
      const next = current.filter((part) => part.kind !== "ring" && part.kind !== "rings");
      return next.length === current.length ? current : next;
    });
  }, []);

  // Window title/size for a palette, from the TS registry, so Rust doesn't read the manifest to open it.
  const toolsetWindowGeometry = useCallback((toolsetId: string): ToolsetWindowGeometry | undefined => {
    const toolset = toolsetRegistry.get(toolsetId);
    if (!toolset) {
      return undefined;
    }
    const size = toolset.preferredWindowSize;
    // Stagger a first-ever placement by the toolset's position in the registry (Rust used to derive
    // this from the manifest order); a persisted position overrides it in Rust.
    const offset = toolsetStaggerIndex(toolsetId, toolsetRegistry) * TOOLSET_STAGGER_STEP_PX;
    return {
      title: toolset.title,
      width: size?.width ?? 96,
      height: size?.height ?? 420,
      x: 88 + offset,
      y: 154 + offset
    };
  }, [toolsetRegistry]);

  const toggleToolset = useCallback(async (toolsetId: string) => {
    if (!toolsetRegistry.get(toolsetId)) {
      setStatus(`Unknown toolbar ${toolsetId}`);
      return;
    }
    // An explicit toggle makes this toolset's visibility authoritative (see resolvedToolsetIdsRef),
    // so a later-appearing plugin toolset the user opens is persisted normally from here on.
    resolvedToolsetIdsRef.current.add(toolsetId);

    if (effectiveNativePalette) {
      // JS owns visibility, so JS decides open vs close (and passes the window geometry on open)
      // rather than routing through Rust's toggle command.
      const nextState = visibleToolsetIdsRef.current.has(toolsetId)
        ? await closeToolsetWindow(toolsetId)
        : await openToolsetWindow(toolsetId, toolsetWindowGeometry(toolsetId));
      setVisibleToolsetIds((current) => updateVisibleToolsets(current, toolsetId, nextState.open));
      // Deliberately closing the Rings toolbar clears the ring selection. The pruning effect no
      // longer does this off `ringInspectorOpen`, so a spurious async "closed" window event can
      // no longer clobber a live selection — only an explicit toggle does.
      if (toolsetId === ringInspectorToolsetId && !nextState.open) {
        clearNativeRingParts();
      }
      setStatus(nextState.open ? `${toolsetRegistry.require(toolsetId).title} open` : `${toolsetRegistry.require(toolsetId).title} closed`);
      return;
    }

    const wasOpen = visibleToolsetIdsRef.current.has(toolsetId);
    setVisibleToolsetIds((current) => updateVisibleToolsets(current, toolsetId, !current.has(toolsetId)));
    if (toolsetId === ringInspectorToolsetId && wasOpen) {
      clearNativeRingParts();
    }
    setStatus(`Toggled ${toolsetRegistry.require(toolsetId).title}`);
  }, [clearNativeRingParts, effectiveNativePalette, toolsetRegistry, toolsetWindowGeometry]);

  // Enter/exit in-place customize mode for the Main toolbar. On enter, ensure the Main palette is
  // open (you can't customize a hidden toolbar); broadcast the flag so the palette renders customize
  // chrome (Phase 4). The palette echoes an `exitCustomize` edit op back to flip this off.
  const setCustomizeMode = useCallback((active: boolean) => {
    setCustomizeMainToolbarActive(active);
    if (active && !visibleToolsetIdsRef.current.has(DEFAULT_TOOLSET_ID)) {
      if (effectiveNativePalette) {
        resolvedToolsetIdsRef.current.add(DEFAULT_TOOLSET_ID);
        void openToolsetWindow(DEFAULT_TOOLSET_ID, toolsetWindowGeometry(DEFAULT_TOOLSET_ID))
          .then((nextState) => setVisibleToolsetIds((current) => updateVisibleToolsets(current, DEFAULT_TOOLSET_ID, nextState.open)))
          .catch(() => undefined);
      } else {
        setVisibleToolsetIds((current) => updateVisibleToolsets(current, DEFAULT_TOOLSET_ID, true));
      }
    }
    void broadcastToolsetCustomizeMode({ toolsetId: DEFAULT_TOOLSET_ID, active }).catch(() => undefined);
  }, [effectiveNativePalette, toolsetWindowGeometry]);

  // JS owns toolset visibility, so it also owns the native menu's checkmarks. Mirror the
  // current visible set onto every toggle item after each change (no-op in the browser).
  // This is what keeps View > Toolbars accurate now that Rust no longer toggles windows.
  useEffect(() => {
    for (const toolset of toolsetRegistry.listToolsets()) {
      void setMenuChecked(createToolsetToggleCommandId(toolset.id), visibleToolsetIds.has(toolset.id));
    }
  }, [toolsetRegistry, visibleToolsetIds]);

  // Push the Toolbars menu STRUCTURE (which toolsets + their titles) to the native menu whenever the
  // toolset set changes, so the menu comes from the TS registry rather than Rust's manifest copy —
  // this is what lets Rust stop parsing the manifest. Rebuilding resets checkmarks, so include the
  // current visibility; between rebuilds the checkmark effect above keeps them in sync in place.
  useEffect(() => {
    if (!nativePalette) {
      return;
    }
    const entries = toolsetRegistry.listToolsets().map((toolset) => ({
      toolsetId: toolset.id,
      title: toolset.title,
      visible: visibleToolsetIds.has(toolset.id)
    }));
    void setToolbarsMenu(entries, rulersVisible, crosshairsVisible).catch(() => undefined);
  }, [crosshairsVisible, nativePalette, rulersVisible, toolsetRegistry, visibleToolsetIds]);

  const deleteHoveredNativeTarget = useCallback(() => {
    const currentDocument = documentRef.current;
    // A lasso fragment selection ("parts") takes precedence over a hovered atom/bond:
    // delete every selected atom and bond in one step. A non-fragment selected part
    // (single atom/bond) still routes through the same part-delete path.
    // Delete EVERY selected native part, across molecules (Phase 7 cross-molecule selection), not
    // just the primary slot — otherwise selecting a bond on A then Shift-selecting a bond on B and
    // pressing Delete would remove only B. Ring parts aren't deletable (excluded here). A lasso
    // "parts" fragment or a genuine multi-molecule selection takes precedence over a hovered
    // atom/bond; a lone atom/bond part still defers to the hovered target (single-select feel).
    const selectedDeleteTargets = selectedNativeMoleculeParts
      .map((part) => nativeTransformableSelectionPart(part))
      .filter((part): part is NativeMoleculeTransformableSelectionPart => part !== undefined);
    const selectionTakesPrecedence = selectedDeleteTargets.length > 1
      || selectedDeleteTargets.some((part) => part.kind === "parts");
    const target = selectionTakesPrecedence ? undefined : hoveredNativeDeleteTargetRef.current;
    if (!target && selectedDeleteTargets.length > 0) {
      let nextDocument = currentDocument;
      for (const deleteTarget of selectedDeleteTargets) {
        nextDocument = applyNativeMoleculePartDeleteTarget(nextDocument, deleteTarget);
      }
      if (nextDocument === currentDocument) {
        setStatus("No selected atom, bond, or fragment");
        return;
      }

      const deletedObjectIds = new Set(selectedDeleteTargets.map((part) => part.objectId));
      commitDocumentChange(nextDocument);
      toolbarStyleTargetRef.current = undefined;
      setActiveEditorObjectId((current) => current && deletedObjectIds.has(current) ? undefined : current);
      setActiveTextEditObjectId(undefined);
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setSelectedNativeMoleculePart(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      setFreeformNativeBond(undefined);
      setNativeDoubleBondSidePreview(undefined);
      setObjectContextMenu(undefined);
      setStatus(selectedDeleteTargets.length > 1
        ? `Deleted ${selectedDeleteTargets.length} selected fragments`
        : selectedDeleteTargets[0]!.kind === "parts"
          ? "Deleted selected molecule fragment"
          : selectedDeleteTargets[0]!.kind === "atom" ? "Deleted carbon atom" : "Deleted carbon bond");
      return;
    }

    if (!target) {
      const nextDocument = deleteSelectedDocumentObjects(currentDocument);
      if (nextDocument === currentDocument) {
        setStatus("No selected object, atom, or bond");
        return;
      }

      const deletedCount = currentDocument.selection.objectIds.length;
      commitDocumentChange(nextDocument);
      toolbarStyleTargetRef.current = undefined;
      setActiveEditorObjectId(undefined);
      setActiveTextEditObjectId(undefined);
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setSelectedNativeMoleculePart(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      setFreeformNativeBond(undefined);
      setNativeDoubleBondSidePreview(undefined);
      setObjectContextMenu(undefined);
      setStatus(deletedCount === 1 ? "Deleted selected object" : `Deleted ${deletedCount} selected objects`);
      return;
    }

    const nextDocument = applyNativeMoleculeDeleteTarget(currentDocument, target);
    if (nextDocument === currentDocument) {
      setStatus("No hovered atom or bond");
      return;
    }

    commitDocumentChange(nextDocument);
    toolbarStyleTargetRef.current = undefined;
    setActiveEditorObjectId((current) => current === target.objectId ? undefined : current);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setObjectContextMenu(undefined);
    setStatus(target.kind === "atom"
      ? "Deleted carbon atom"
      : target.terminalAtomId ? "Deleted terminal carbon" : "Deleted carbon bond");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, selectedNativeMoleculePart]);

  const eraseDocumentObjectTarget = useCallback((
    object: DocumentObject | undefined,
    nativeTarget?: NativeMoleculeDeleteTarget
  ): boolean => {
    if (!object) {
      setStatus("Nothing to erase");
      return false;
    }

    const currentDocument = documentRef.current;
    const nextDocument = nativeTarget
      ? applyNativeMoleculeDeleteTarget(currentDocument, nativeTarget)
      : deleteSelectedDocumentObjects(selectDocumentObject(currentDocument, object.id));
    if (nextDocument === currentDocument) {
      setStatus(nativeTarget ? "No atom or bond to erase" : "Object could not be erased");
      return false;
    }

    commitDocumentChange(nextDocument);
    toolbarStyleTargetRef.current = undefined;
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setObjectContextMenu(undefined);
    setStatus(nativeTarget
      ? nativeTarget.kind === "atom" ? "Erased atom" : "Erased bond"
      : "Erased object");
    return true;
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange]);

  const cycleNativeBondOrder = useCallback((target: NativeBondOrderTarget) => {
    const currentDocument = documentRef.current;
    const selectedDocument = selectDocumentObject(currentDocument, target.objectId);
    const nextDocument = applyNativeMoleculeBondOrderTarget(selectedDocument, target);
    if (nextDocument === selectedDocument) {
      setStatus("Bond is already at its maximum allowed order");
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setStatus("Changed bond order");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange]);

  const setHoveredNativeBondOrder = useCallback((order: NativeBondOrderValue) => {
    const currentDocument = documentRef.current;
    const target = hoveredNativeDeleteTargetRef.current
      ?? nativeDeleteTargetFromSelectionPart(currentDocument, selectedNativeMoleculePart);
    if (!target || target.kind !== "bond") {
      setStatus(`No hovered bond for ${order} bond`);
      return;
    }

    const selectedDocument = selectDocumentObject(currentDocument, target.objectId);
    const nextDocument = applyNativeMoleculeBondOrderValueTarget(selectedDocument, target, order);
    if (nextDocument === selectedDocument) {
      setStatus(`Cannot set hovered bond to ${order}`);
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setStatus(`Set hovered bond to ${order}`);
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, selectedNativeMoleculePart]);

  const setHoveredNativeAtomElement = useCallback((element: NativeSingleLetterElement) => {
    const target = hoveredNativeDeleteTargetRef.current
      ?? nativeDeleteTargetFromSelectionPart(documentRef.current, selectedNativeMoleculePart);
    if (!target || target.kind !== "atom") {
      setStatus(`No hovered atom for ${element}`);
      return;
    }

    const currentDocument = documentRef.current;
    const nextDocument = applyNativeAtomElementTarget(currentDocument, target, element);
    if (nextDocument === currentDocument) {
      setStatus(`Cannot set hovered atom to ${element}`);
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setStatus(`Set hovered atom to ${element}`);
  }, [commitDocumentChange, selectedNativeMoleculePart]);

  const addCarbonylToHoveredNativeAtom = useCallback(() => {
    const target = hoveredNativeDeleteTargetRef.current
      ?? nativeDeleteTargetFromSelectionPart(documentRef.current, selectedNativeMoleculePart);
    if (!target || target.kind !== "atom") {
      setStatus("No hovered carbon for C=O");
      return;
    }

    const currentDocument = documentRef.current;
    const steeringPoint = hoveredNativeAtomPointRef.current?.objectId === target.objectId
      ? hoveredNativeAtomPointRef.current.point
      : undefined;
    const nextDocument = applyNativeCarbonylAtAtomTarget(currentDocument, target, steeringPoint);
    if (nextDocument === currentDocument) {
      setStatus("Cannot add C=O to hovered atom");
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setStatus("Added C=O to hovered carbon");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, selectedNativeMoleculePart]);

  const addSingleBondToHoveredNativeAtom = useCallback(() => {
    const target = hoveredNativeDeleteTargetRef.current
      ?? nativeDeleteTargetFromSelectionPart(documentRef.current, selectedNativeMoleculePart);
    if (!target || target.kind !== "atom") {
      setStatus("No hovered atom for single bond");
      return;
    }

    const currentDocument = documentRef.current;
    const steeringPoint = hoveredNativeAtomPointRef.current?.objectId === target.objectId
      ? hoveredNativeAtomPointRef.current.point
      : undefined;
    const nextDocument = applySingleBondToolAtNativeAtom(currentDocument, target, steeringPoint);
    if (nextDocument === currentDocument) {
      setStatus("Cannot add a single bond to hovered atom");
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setStatus("Added single bond to hovered atom");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, selectedNativeMoleculePart]);

  const addChargeToHoveredNativeAtom = useCallback((charge: NativeChargeValue, explicitTarget?: NativeMoleculeDeleteTarget) => {
    const target = explicitTarget
      ?? hoveredNativeDeleteTargetRef.current
      ?? nativeDeleteTargetFromSelectionPart(documentRef.current, selectedNativeMoleculePart);
    if (!target || target.kind !== "atom") {
      setStatus(charge > 0 ? "No hovered atom for positive charge" : "No hovered atom for negative charge");
      return;
    }

    const currentDocument = documentRef.current;
    const nextDocument = applyChargeToolAtNativeAtom(currentDocument, charge, target);
    if (nextDocument === currentDocument) {
      setStatus(charge > 0 ? "Cannot place positive charge on hovered atom" : "Cannot place negative charge on hovered atom");
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setStatus(charge > 0 ? "Placed positive charge on hovered atom" : "Placed negative charge on hovered atom");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, selectedNativeMoleculePart]);

  const cleanUpSelectedStructure = useCallback(() => {
    const currentDocument = documentRef.current;
    const targetObjectIds = [
      ...new Set([
        ...currentDocument.selection.objectIds,
        ...(selectedNativeMoleculePart ? [selectedNativeMoleculePart.objectId] : [])
      ])
    ];
    if (targetObjectIds.length === 0) {
      setStatus("No selected structure to clean up");
      return;
    }

    const changed = commitDocumentChange((current) => cleanUpNativeMolecules2d(current, targetObjectIds));
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setObjectContextMenu(undefined);
    const targetLabel = targetObjectIds.length === 1 ? "structure" : "structures";
    // Multi-ring systems are deliberately left as drawn by the 2D pass (its polygon+tree layout
    // would shear them) — tell the user where the full re-layout lives.
    const hasFusedTarget = targetObjectIds.some((targetId) => {
      const target = findDocumentObject(documentRef.current, targetId);
      return target?.type === "molecule" && isNativeMoleculeGraph(target) && moleculeHasFusedRingSystem(target);
    });
    const fusedHint = hasFusedTarget ? " — fused rings kept as drawn; use 3D Cleanup for a full re-layout" : "";
    setStatus(changed ? `Cleaned up selected ${targetLabel}${fusedHint}` : `Selected ${targetLabel} already clean${fusedHint}`);
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, selectedNativeMoleculePart]);

  // ── 3D spin (Phase 4) ──────────────────────────────────────────────────────
  const applySpin = useCallback((next: Spin3dState | undefined) => {
    // A new session's conformer is a distinct coords3d array; a drag/flag update reuses the same
    // reference. Bump the session token only when that identity changes, so async continuations
    // (e.g. stereo perception in commitSpinFlatten) can tell a replaced session from an orientation
    // change within the same one.
    if (next?.coords3d !== spin3dStateRef.current?.coords3d) {
      spin3dSessionGenerationRef.current += 1;
    }
    spin3dStateRef.current = next;
    setSpin3dStateRender(next);
    if (!next) {
      // Cancel any pending dirty-flag rAF so it doesn't fire after spin ends.
      if (spinRafRef.current !== null) {
        cancelAnimationFrame(spinRafRef.current);
        spinRafRef.current = null;
      }
      spinDirtyRef.current = false;
    }
  }, []);

  const cancelSpin3dSession = useCallback((
    message?: string,
    options: { clearModelCache?: boolean } = {}
  ): boolean => {
    const hadActiveSpin = spin3dStateRef.current !== undefined;
    const pendingSpin = spin3dPendingRef.current;

    if (pendingSpin) {
      pendingSpin.cancel();
      spin3dPendingRef.current = undefined;
      spin3dRequestRef.current += 1;
      setSpin3dGenerating(undefined); // a first-time embed was in flight — drop its cue
    }

    if (hadActiveSpin) {
      applySpin(undefined);
    }

    if (options.clearModelCache) {
      spin3dModelCacheRef.current.clear();
    }

    const cancelled = hadActiveSpin || pendingSpin !== undefined;
    if (cancelled) {
      lastSpinPrefetchRef.current = undefined;
      if (message) setStatus(message);
    }
    return cancelled;
  }, [applySpin]);

  useEffect(() => {
    if (!spin3dState) return;
    const spinObject = findDocumentObject(document, spin3dState.objectId);
    if (spinObject?.type !== "molecule") {
      applySpin(undefined);
    }
  }, [applySpin, document, spin3dState]);

  // Flatten the current spin orientation into the document as ONE undo step. On
  // refusal the document is untouched and the overlay stays so the user can re-spin.
  const commitSpinFlatten = useCallback(async () => {
    const state = spin3dStateRef.current;
    if (!state) return;
    // Capture the session token: the stereo perception below is async, and a cancel-and-restart on
    // the same molecule during that await must not let this stale continuation commit old coords.
    const sessionGeneration = spin3dSessionGenerationRef.current;
    // Perceive which atoms are ACTUAL stereocenters so graphic wedge/hash bonds on non-chiral
    // atoms (a common "projects toward/away" depiction cue) are dropped on flatten instead of
    // being mistaken for specified stereo and refusing the whole commit. OCL is lazy-loaded and
    // perception is best-effort — any failure falls back to the legacy "every drawn wedge is a
    // center" behavior.
    let stereoCenterAtomIds: ReadonlySet<string> | undefined;
    // Injected into flatten so it can READ ITS OWN wedge output back with the real CIP engine and
    // repair (or refuse) any center that would otherwise commit a different stereoisomer.
    let perceiveStereo: StereoPerceiver | undefined;
    // Axial stereochemistry (allene / atropisomer) has no 2D wedge encoding — warn on commit.
    let unrepresentableStereoKinds: string[] | undefined;
    let flattenTarget: MoleculeObject | undefined;
    for (const page of documentRef.current.pages) {
      const found = page.objects.find(
        (object): object is MoleculeObject => object.id === state.objectId && object.type === "molecule"
      );
      if (found) {
        flattenTarget = found;
        break;
      }
    }
    if (flattenTarget) {
      try {
        const molfile = moleculeToMolfileV2000(flattenTarget, { fromDocFrame: true });
        const { perceiveStereoCentersFromMolfile, perceiveUnrepresentableStereo } = await import("@chemdraft/ocl-adapter");
        perceiveStereo = perceiveStereoCentersFromMolfile;
        const perAtom = perceiveStereoCentersFromMolfile(molfile);
        if (perAtom.length === flattenTarget.atoms.length) {
          const ids = new Set<string>();
          flattenTarget.atoms.forEach((atom, index) => {
            if (perAtom[index]?.isStereoCenter) ids.add(atom.id);
          });
          stereoCenterAtomIds = ids;
        }
        const unrepresentable = perceiveUnrepresentableStereo(molfile);
        const kinds: string[] = [];
        if (unrepresentable.alleneAtoms.length > 0) kinds.push("allene");
        if (unrepresentable.atropisomerBonds.length > 0) kinds.push("atropisomer");
        if (kinds.length > 0) unrepresentableStereoKinds = kinds;
      } catch {
        /* best-effort: fall back to legacy behavior (treat every drawn wedge as a center) */
      }
      // The async perception yielded the event loop; abort if the spin session was replaced
      // (ended, switched molecule, or cancelled-and-restarted) while we awaited OCL.
      if (spin3dSessionGenerationRef.current !== sessionGeneration) return;
    }
    const viewMatrix = quatToViewMatrix(state.quat);
    let outcome: ReturnType<typeof flattenSpunMolecule>;
    try {
      outcome = flattenSpunMolecule(documentRef.current, state.objectId, state.coords3d, viewMatrix, {
        placement: state.placement,
        stereoCenterAtomIds,
        perceiveStereo
      });
    } catch (error) {
      // A flatten guard (e.g. a stale atom reference) throws rather than silently committing
      // wrong stereo. Surface it as a clean refusal and keep the overlay alive for a retry.
      setStatus(`Cannot flatten this view: ${error instanceof Error ? error.message : String(error)}`);
      applySpin({ ...state, dragging: false, lastClient: undefined });
      return;
    }
    if (outcome.status !== "committed") {
      setStatus(`Cannot flatten this view: ${outcome.refusalReasons[0] ?? "stereochemistry would change"}`);
      // Keep the overlay alive (end the drag) so the user can re-orient and retry.
      applySpin({ ...state, dragging: false, lastClient: undefined });
      return;
    }
    // Persist the conformer + committed orientation ON the molecule (under
    // compatibility.unknown) so the ordinary X/Y/Z rotate handles re-project this real 3D
    // model — durable across save/reload. The graph is unchanged by the flatten, so signing
    // the just-committed molecule is equivalent. Also kept in the session memo so a re-spin
    // reopens here instead of re-snapping to a fresh embed.
    const flattened = outcome.document.pages
      .flatMap((page) => page.objects)
      .find((object): object is MoleculeObject => object.id === state.objectId && object.type === "molecule");
    let committedDocument = outcome.document;
    if (flattened) {
      committedDocument = attachSpin3dModelFromConformer(outcome.document, state.objectId, {
        coords3d: state.coords3d,
        orientation: state.quat,
        engine: state.engine
      });
      spin3dModelCacheRef.current.set(state.objectId, {
        signature: conformerGraphSignature(flattened),
        coords3d: state.coords3d,
        quat: state.quat,
        engine: state.engine
      });
    }
    commitDocumentChange(committedDocument);
    applySpin(undefined);
    const meaningful = outcome.warnings.filter((warning) => warning.code !== "perspective-cleanup");
    // A dense polycyclic structure can emit the SAME benign warning (e.g. degenerate-drawn-parity)
    // for many centers at once; listing the code 23× reads like 23 distinct problems. Collapse to
    // one entry per code with a count so the status conveys "one kind of caveat, N centers".
    const codeCounts = new Map<string, number>();
    for (const warning of meaningful) codeCounts.set(warning.code, (codeCounts.get(warning.code) ?? 0) + 1);
    const codeSummary = [...codeCounts.entries()]
      .map(([code, count]) => (count > 1 ? `${code} ×${count}` : code))
      .join(", ");
    const baseStatus =
      meaningful.length > 0
        ? `Flattened perspective with ${meaningful.length} warning(s): ${codeSummary}`
        : "Flattened to a 2D perspective";
    // Axial stereochemistry has no 2D wedge encoding: the spun 3D model kept it, but the flat
    // drawing can't show it and it will not survive an export or a structural edit.
    const stereoNote = unrepresentableStereoKinds
      ? ` — note: ${unrepresentableStereoKinds.join(" & ")} stereochemistry isn't captured by the flat drawing (kept in the 3D model; lost on export or a structural edit)`
      : "";
    setStatus(baseStatus + stereoNote);
  }, [applySpin, commitDocumentChange]);

  // Preload the OCL stereo perceiver once so the synchronous rotate-commit paths can run the
  // read-back guard. Perception depends only on the molecule graph, so a single load serves every
  // orientation. Best-effort: on failure the rotate commits fall back to geometry-only flattening.
  useEffect(() => {
    let cancelled = false;
    void import("@chemdraft/ocl-adapter")
      .then((module) => {
        if (!cancelled) spin3dStereoPerceiverRef.current = module.perceiveStereoCentersFromMolfile;
      })
      .catch(() => {
        /* best-effort: rotate commits fall back to legacy geometry-only flatten */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Stereo read-back guard options for flattening a spun molecule — the SAME protection the Spin 3D
  // overlay commit applies (commitSpinFlatten), but synchronous, so the whole-molecule rotate paths
  // (drag handle + numeric X/Y) that also persist a flattened projection can't silently commit a
  // different stereoisomer. Returns {} (legacy geometry-only flatten) when the perceiver has not
  // loaded yet or the target isn't an editable native graph.
  const spin3dFlattenStereoOptions = useCallback((
    sourceDocument: ChemDraftDocument,
    objectId: string
  ): { stereoCenterAtomIds?: ReadonlySet<string>; perceiveStereo?: StereoPerceiver } => {
    const perceive = spin3dStereoPerceiverRef.current;
    if (!perceive) return {};
    const molecule = findDocumentObject(sourceDocument, objectId);
    if (molecule?.type !== "molecule" || !isNativeMoleculeGraph(molecule)) return {};
    try {
      const molfile = moleculeToMolfileV2000(molecule, { fromDocFrame: true });
      const perAtom = perceive(molfile);
      let stereoCenterAtomIds: ReadonlySet<string> | undefined;
      if (perAtom.length === molecule.atoms.length) {
        const ids = new Set<string>();
        molecule.atoms.forEach((atom, index) => {
          if (perAtom[index]?.isStereoCenter) ids.add(atom.id);
        });
        stereoCenterAtomIds = ids;
      }
      return { stereoCenterAtomIds, perceiveStereo: perceive };
    } catch {
      return {};
    }
  }, []);

  // Monotonic token: stale conformer results (from a superseded spin click) are ignored.
  const spin3dRequestRef = useRef(0);
  // Session-scoped 3D model memo, keyed by molecule objectId. The FIRST spin+flatten of a
  // structure cleans it up (the projected geometry differs from the hand-drawn layout — a
  // desired one-time reposition). After that we remember the exact conformer + committed
  // orientation, so re-spinning reopens the overlay landing on the current drawing instead
  // of re-snapping to a fresh embed's readable angle — letting the user fine-tune position.
  // Self-invalidating: the stored signature keys on graph identity, so editing the molecule
  // forces a fresh embed (treated as first-time again). Not persisted across reload.
  const spin3dModelCacheRef = useRef<Map<string, { signature: string; coords3d: Float64Array; quat: Quaternion; engine?: Spin3dEngineProvenance }>>(
    new Map()
  );
  // The generation currently awaited (no overlay yet): repeated Spin 3D clicks for
  // the same structure are absorbed instead of stacking engine jobs in the worker.
  const spin3dPendingRef = useRef<{ molfile: string; objectId: string; cancel: () => void } | undefined>(undefined);

  // Molfile of the last speculative prefetch, so a stable selection doesn't re-prefetch.
  const lastSpinPrefetchRef = useRef<string | undefined>(undefined);

  // User-chosen 3D refinement mode (Fast/Balanced/Quality), loaded from localStorage and
  // updated live from the Preferences window via a cross-window event. Mirrored into a ref
  // so the spin/prefetch callbacks can read the latest value without re-creating on change.
  const [spin3dSettings, setSpin3dSettings] = useState<Spin3dSettings>(() => loadSpin3dSettings());
  const spin3dSettingsRef = useRef(spin3dSettings);
  useEffect(() => {
    spin3dSettingsRef.current = spin3dSettings;
    // A mode change must invalidate the last speculative prefetch so the next
    // selection re-prefetches under the new mode.
    lastSpinPrefetchRef.current = undefined;
  }, [spin3dSettings]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForSpin3dSettings((next) => setSpin3dSettings(next)).then((listener) => {
      if (disposed) {
        listener();
        return;
      }
      unlisten = listener;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /** Compute the overlay placement for a conformer against the molecule's drawn 2D geometry. */
  const spinPlacementFor = useCallback((molecule: MoleculeObject, coords3d: Float64Array, orientation?: Quaternion): {
    bondPairs: [number, number][];
    bondRender: SpinBondRenderInfo[];
    atomLabels: (string | undefined)[];
    atomLabelStyles: (NativeDrawingStyle | undefined)[];
    atoms: readonly MoleculeAtom[];
    placement: ScreenPlacement;
  } => {
    const atomIndex = new Map(molecule.atoms.map((atom, index) => [atom.id, index] as const));
    const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom] as const));
    // Adjacency (atom index → neighbor indices) for the double-bond side heuristic.
    const adjacency = new Map<number, number[]>();
    for (const bond of molecule.bonds) {
      const from = atomIndex.get(bond.fromAtomId);
      const to = atomIndex.get(bond.toAtomId);
      if (from === undefined || to === undefined) continue;
      (adjacency.get(from) ?? adjacency.set(from, []).get(from)!).push(to);
      (adjacency.get(to) ?? adjacency.set(to, []).get(to)!).push(from);
    }
    // Smallest ring per bond, as atom INDICES — so a ring double bond's inner line can point
    // to the PROJECTED ring interior each frame (matching the 2D drawing and the flatten),
    // instead of the substituent-count heuristic that flips outward on substituted rings.
    const ringAtomIdsByBond = smallestRingAtomIdsByBondId(molecule);
    const bondPairs: [number, number][] = [];
    const bondRender: SpinBondRenderInfo[] = [];
    for (const bond of molecule.bonds) {
      const from = atomIndex.get(bond.fromAtomId);
      const to = atomIndex.get(bond.toAtomId);
      if (from === undefined || to === undefined) continue;
      bondPairs.push([from, to]);
      const fromAtom = atomById.get(bond.fromAtomId);
      const toAtom = atomById.get(bond.toAtomId);
      const neighborIndices = [...(adjacency.get(from) ?? []), ...(adjacency.get(to) ?? [])]
        .filter((index) => index !== from && index !== to);
      const ringAtomIds = ringAtomIdsByBond.get(bond.id);
      const ringAtomIndices = ringAtomIds
        ? ringAtomIds
            .map((atomId) => atomIndex.get(atomId))
            .filter((index): index is number => index !== undefined)
        : undefined;
      bondRender.push({
        // aromatic/unknown render as a single line ON PURPOSE: the 2D layout engine
        // (bondLineSegments) only draws inner lines for double/triple, so matching it here
        // keeps the spin overlay identical to the drawing it replaces (and to the flatten).
        order: bond.order === "double" ? 2 : bond.order === "triple" ? 3 : 1,
        bold: bond.display?.bondStyle === "bold",
        symmetric: fromAtom !== undefined && toAtom !== undefined &&
          isTerminalHeteroatomDoubleBond(fromAtom, toAtom, molecule, bond),
        neighborIndices,
        ringAtomIndices
      });
    }
    // The exact labels the 2D drawing shows (element + implicit H + charge; plain
    // bonded carbons stay unlabeled) so the spinning structure reads as the SAME one.
    const atomLabelPlanByAtomId = new Map(planMoleculeAtomLabels(molecule).map((plan) => [plan.atom.id, plan]));
    const atomLabels = molecule.atoms.map((atom) => atomLabelPlanByAtomId.get(atom.id)?.label);
    const atomLabelStyles = molecule.atoms.map((atom) => atomLabelPlanByAtomId.get(atom.id)?.drawingStyle);
    const points2d = molecule.atoms.map((atom) => ({ x: atom.x, y: atom.y }));
    const centerX = points2d.reduce((sum, p) => sum + p.x, 0) / points2d.length;
    const centerY = points2d.reduce((sum, p) => sum + p.y, 0) / points2d.length;
    const scale = orientation
      ? orientedOverlayScale(points2d, coords3d, bondPairs, quatToViewMatrix(orientation))
      : overlayScale(points2d, coords3d, bondPairs);
    return { bondPairs, bondRender, atomLabels, atomLabelStyles, atoms: molecule.atoms, placement: { centerX, centerY, scale } };
  }, []);

  const startSpin3d = useCallback(async () => {
    const plannedRequestId = spin3dRequestRef.current + 1;
    const sessionId = `spin3d:${plannedRequestId}:${Date.now()}`;
    const emitTrace = (event: Spin3dTraceEvent): void => {
      broadcastSpin3dTraceEvent(event);
    };
    const traceInfo = (
      stage: string,
      details: Partial<Parameters<typeof createSpin3dTraceEvent>[0]> = {}
    ): void => {
      emitTrace(createSpin3dTraceEvent({
        ...details,
        sessionId,
        requestId: plannedRequestId,
        kind: details.kind ?? "spin",
        stage,
        status: details.status ?? "info"
      }));
    };
    const commandSpan = startSpin3dTraceSpan({
      sessionId,
      requestId: plannedRequestId,
      kind: "spin",
      stage: "spin.command",
    }, emitTrace);
    const currentDocument = documentRef.current;
    const selectedIds = [
      ...new Set([
        ...currentDocument.selection.objectIds,
        ...(selectedNativeMoleculePart ? [selectedNativeMoleculePart.objectId] : [])
      ])
    ];
    if (selectedIds.length !== 1) {
      traceInfo("spin.selection", { message: `selected ${selectedIds.length}` });
      commandSpan.complete({ message: "selection rejected" });
      setStatus("Select a single molecule to spin in 3D");
      return;
    }
    const objectId = selectedIds[0];
    const molecule = currentDocument.pages[0]?.objects.find(
      (object): object is MoleculeObject => object.id === objectId && object.type === "molecule"
    );
    if (!molecule || !isNativeMoleculeGraph(molecule) || molecule.atoms.length < 2) {
      traceInfo("spin.selection", { message: "not an editable molecule" });
      commandSpan.complete({ message: "molecule rejected" });
      setStatus("Spin 3D needs an editable molecule");
      return;
    }
    if (spin3dStateRef.current?.objectId === objectId) {
      // Button mashed while the overlay is already up — keep the live session.
      traceInfo("spin.duplicate", { message: "overlay already active" });
      commandSpan.complete({ message: "already spinning" });
      setStatus("Spin 3D already active: drag the molecule to rotate · Esc to cancel");
      return;
    }

    // Refinement mode (Fast/Balanced/Quality) for this spin — read from the ref so the
    // callback need not re-create when the setting changes. Shared by the worker path
    // and the in-page fallback so both honour the user's choice.
    const conformerOptions = conformerOptionsForSpin3d(spin3dSettingsRef.current, molecule.atoms.length);

    // Already-modeled structure: reopen the stored conformer at its committed orientation
    // so the overlay lands exactly on the current drawing (no re-snap), letting the user
    // fine-tune. Prefer the session memo, then the model persisted on the molecule (which
    // survives reload), and only fall through to a fresh embed if neither is valid. Both are
    // graph-signature gated, so an edited structure re-embeds.
    const memo = spin3dModelCacheRef.current.get(objectId);
    const memoHit = memo && memo.signature === conformerGraphSignature(molecule) ? memo : undefined;
    let reopen: { coords3d: Float64Array; quat: Quaternion; engine?: Spin3dEngineProvenance } | undefined =
      memoHit ? { coords3d: memoHit.coords3d, quat: memoHit.quat, engine: memoHit.engine } : undefined;
    if (!reopen) {
      const documentModel = validSpin3dModelFor(molecule);
      const coords3d = documentModel ? spin3dModelCoordsForMolecule(documentModel, molecule) : undefined;
      if (documentModel && coords3d) {
        reopen = { coords3d, quat: documentModel.orientation, engine: documentModel.engine };
      }
    }
    if (reopen) {
      // Supersede any in-flight generation and invalidate stale async callbacks.
      spin3dPendingRef.current?.cancel();
      spin3dPendingRef.current = undefined;
      spin3dRequestRef.current += 1;
      const { bondPairs, bondRender, atomLabels, atomLabelStyles, atoms, placement } = spinPlacementFor(molecule, reopen.coords3d, reopen.quat);
      applySpin({
        objectId,
        quat: reopen.quat,
        coords3d: reopen.coords3d,
        bondPairs,
        bondRender,
        atomLabels,
        atomLabelStyles,
        atoms,
        placement,
        selectionBox: { x: molecule.x, y: molecule.y, width: molecule.width, height: molecule.height },
        dragging: false,
        engine: reopen.engine
      });
      traceInfo("spin.reused", {
        atomCount: molecule.atoms.length,
        message: "reused stored model — reopened at committed orientation (no re-snap)"
      });
      commandSpan.complete({ message: "reused stored model" });
      setStatus("Spin 3D: drag the molecule to rotate · click outside to flatten · Esc to cancel");
      return;
    }

    setStatus("Generating 3D conformer…");
    // Document is y-down; the molfile/engine frame is y-up → fromDocFrame negates y.
    const molfileSpan = startSpin3dTraceSpan({
      sessionId,
      requestId: plannedRequestId,
      kind: "spin",
      stage: "spin.molfile",
      atomCount: molecule.atoms.length
    }, emitTrace);
    let molfile: string;
    try {
      molfile = moleculeToMolfileV2000(molecule, { fromDocFrame: true });
      molfileSpan.complete({ atomCount: molecule.atoms.length });
    } catch (error) {
      molfileSpan.fail(error, { atomCount: molecule.atoms.length });
      commandSpan.fail(error);
      setStatus(`3D spin unavailable: ${(error as Error).message}`);
      return;
    }
    const pendingSpin = spin3dPendingRef.current;
    if (pendingSpin?.molfile === molfile) {
      // Same structure is already being generated — absorb the repeat click
      // instead of stacking another multi-second engine job in the worker.
      traceInfo("spin.duplicate", { message: "generation already pending" });
      commandSpan.complete({ message: "duplicate absorbed" });
      setStatus(`Generating 3D conformer… still working (${molecule.atoms.length} atoms)`);
      return;
    }
    // A different structure supersedes any pending generation: detach its handlers
    // and drop the queued worker job (a running engine call finishes + caches).
    pendingSpin?.cancel();
    spin3dPendingRef.current = undefined;
    const requestToken = ++spin3dRequestRef.current;
    commandSpan.complete({ atomCount: molecule.atoms.length });

    // Slow-path feedback: if no overlay after ~2s, tell the user the engine is
    // genuinely working (large/branched structures can take several seconds).
    const slowTimer = window.setTimeout(() => {
      if (spin3dRequestRef.current === requestToken && !spin3dStateRef.current) {
        setStatus(`Generating 3D conformer… still working (${molecule.atoms.length} atoms — large structures can take a few seconds)`);
      }
    }, 2000);
    const clearSlowTimer = (): void => window.clearTimeout(slowTimer);

    // Show the on-canvas "Generating 3D…" cue while the first embed runs (cleared the moment
    // an overlay goes up, generation fails, or the session is cancelled — see below).
    setSpin3dGenerating({
      objectId,
      box: { x: molecule.x, y: molecule.y, width: molecule.width, height: molecule.height },
      atomCount: molecule.atoms.length
    });

    // Stage 1 — the embedded conformer is fully manipulable; the overlay goes up NOW.
    const handleEmbedded = (conformer: Generate3DConformerResult): void => {
      clearSlowTimer();
      setSpin3dGenerating(undefined);
      spin3dPendingRef.current = undefined;
      traceInfo("spin.embedded-callback", {
        atomCount: conformer.originalAtomCount,
        warningCount: conformer.warnings.length,
        message: conformer.embed.status
      });
      if (conformer.embed.status !== "ok") {
        setStatus(`Could not generate a 3D conformer: ${conformer.embed.failureReason ?? "unknown"}`);
        return;
      }
      // Spin may only begin if the molecule is still selected and unchanged.
      if (documentRef.current.pages[0]?.objects.find((object) => object.id === objectId) !== molecule) {
        traceInfo("spin.cancelled", { message: "selection changed" });
        setStatus("Selection changed; spin cancelled");
        return;
      }
      const coords3d = conformer.mapping.coords3dByOriginalAtom;
      const { bondPairs, bondRender, atomLabels, atomLabelStyles, atoms, placement } = spinPlacementFor(molecule, coords3d);
      applySpin({
        objectId,
        // Open at a readable angle (principal plane toward the viewer + gentle tilt),
        // not the engine's arbitrary — often edge-on — embedding orientation.
        quat: initialViewQuaternion(coords3d),
        coords3d,
        bondPairs,
        bondRender,
        atomLabels,
        atomLabelStyles,
        atoms,
        placement,
        selectionBox: { x: molecule.x, y: molecule.y, width: molecule.width, height: molecule.height },
        dragging: false,
        engine: { name: conformer.engine.name, version: conformer.engine.version, forceField: conformer.forceField?.name }
      });
      // If RDKit could not load, the conformer came back from the OpenChemLib fallback and the
      // worker tags it with an `rdkit.unavailable` warning. Surface that reason here so a packaged
      // build (no devtools) shows WHY tug/planar cleanup are off, instead of silently no-op'ing.
      const rdkitUnavailable = conformer.warnings.find((warning) => warning.code === "rdkit.unavailable");
      setStatus(
        rdkitUnavailable
          ? `Spin 3D — ${rdkitUnavailable.message}`
          : "Spin 3D: drag the molecule to rotate · click outside to flatten · Esc to cancel"
      );
    };

    // Stage 2 — force-field-refined coordinates hot-swap under the live overlay,
    // preserving the user's current rotation. Ignored once the spin session ended.
    const handleRefined = (conformer: Generate3DConformerResult): void => {
      if (spin3dRequestRef.current !== requestToken) return;
      const state = spin3dStateRef.current;
      if (!state || state.objectId !== objectId) return;
      traceInfo("spin.refined-callback", {
        atomCount: conformer.originalAtomCount,
        warningCount: conformer.warnings.length,
        message: conformer.forceField?.status
      });
      const coords3d = conformer.mapping.coords3dByOriginalAtom;
      const { bondPairs, bondRender, atomLabels, placement } = spinPlacementFor(molecule, coords3d);
      applySpin({
        ...state,
        coords3d,
        bondPairs,
        bondRender,
        atomLabels,
        placement,
        engine: { name: conformer.engine.name, version: conformer.engine.version, forceField: conformer.forceField?.name }
      });
    };

    const runInPage = async (): Promise<void> => {
      const path: Spin3dTracePath = "in-page";
      try {
        const importSpan = startSpin3dTraceSpan({
          sessionId,
          requestId: requestToken,
          kind: "spin",
          stage: "fallback.import",
          path
        }, emitTrace);
        const ocl = await import("@chemdraft/ocl-adapter");
        const { oclResourcesUrl } = await import("./oclResources");
        ocl.setOclResourcesUrl(oclResourcesUrl);
        importSpan.complete();
        const generateSpan = startSpin3dTraceSpan({
          sessionId,
          requestId: requestToken,
          kind: "spin",
          stage: "fallback.generate",
          path,
          atomCount: molecule.atoms.length
        }, emitTrace);
        const { embedded, refineFromEmbedded } = await ocl.withOclConformerTrace(
          (event) => emitTrace(createSpin3dTraceEventFromOcl(event, { sessionId, requestId: requestToken, path })),
          () => ocl.generate3DConformerProgressive(
            { molfile, originalAtomCount: molecule.atoms.length },
            conformerOptions
          )
        );
        generateSpan.complete({ warningCount: embedded.warnings.length });
        if (spin3dRequestRef.current !== requestToken) return;
        handleEmbedded(embedded);
        if (embedded.embed.status !== "ok" || !refineFromEmbedded) return;
        // Let the overlay paint before the synchronous minimise blocks this thread.
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (spin3dRequestRef.current !== requestToken) return;
        const refineSpan = startSpin3dTraceSpan({
          sessionId,
          requestId: requestToken,
          kind: "spin",
          stage: "fallback.refine",
          path,
          atomCount: molecule.atoms.length
        }, emitTrace);
        const refined = await ocl.withOclConformerTrace(
          (event) => emitTrace(createSpin3dTraceEventFromOcl(event, { sessionId, requestId: requestToken, path })),
          async () => refineFromEmbedded()
        );
        refineSpan.complete({ warningCount: refined.warnings.length });
        handleRefined(refined);
      } catch (error) {
        clearSlowTimer();
        setSpin3dGenerating(undefined);
        traceInfo("fallback.error", {
          status: "failed",
          path,
          error: (error as Error).message
        });
        setStatus(`3D spin unavailable: ${(error as Error).message}`);
      }
    };

    const client = getConformerWorkerClient();
    if (client) {
      traceInfo("worker.client", { path: "worker", message: "available" });
      let retriedAfterCrash = false;
      const dispatch = (): void => {
        const cancel = client.generate(molfile, molecule.atoms.length, conformerOptions, spin3dSettingsRef.current.enginePreference, {
          onEmbedded: (result) => {
            if (spin3dRequestRef.current === requestToken) handleEmbedded(result);
          },
          onRefined: handleRefined,
          onError: (message, info) => {
            if (spin3dRequestRef.current !== requestToken) return;
            clearSlowTimer();
            spin3dPendingRef.current = undefined;
            if (info?.workerCrashed && !retriedAfterCrash) {
              // The client recreated the worker — retry once, transparently.
              retriedAfterCrash = true;
              traceInfo("worker.retry", { path: "worker", message });
              dispatch();
              return;
            }
            traceInfo("worker.error", { path: "worker", status: "failed", error: message });
            if (info?.workerCrashed && molecule.atoms.length <= SPIN_IN_PAGE_MAX_ATOMS) {
              // Worker is gone for good — small structures may fall back to the
              // in-page engine; large ones must NOT (it freezes the whole UI). The cue
              // stays up: runInPage owns it from here (clears on its embed or its catch).
              void runInPage();
              return;
            }
            setSpin3dGenerating(undefined);
            setStatus(`Could not generate a 3D conformer: ${message}`);
          }
        }, { sessionId });
        spin3dPendingRef.current = { molfile, objectId, cancel };
      };
      dispatch();
      return;
    }
    traceInfo("worker.client", { message: "unavailable" });
    if (molecule.atoms.length > SPIN_IN_PAGE_MAX_ATOMS) {
      clearSlowTimer();
      setSpin3dGenerating(undefined);
      setStatus("Spin 3D is unavailable for structures this large without background worker support");
      return;
    }
    await runInPage();
  }, [applySpin, selectedNativeMoleculePart, spinPlacementFor]);

  // Opt-in console mirror of the spin3d trace stream (localStorage flag / ?spin3dlog=1),
  // so the prefetch → cache → embed → overlay timeline is capturable without the debugger
  // window. No-op (returns null) when disabled, so this costs nothing in normal use.
  useEffect(() => { attachSpin3dTraceConsole(); }, []);

  // Warm the conformer worker (engine module + torsion resources + JIT) as soon as the
  // main thread goes idle — capped so it never waits past ~1.5s — instead of a flat 1.5s
  // delay. The first real embed then runs at its floor (no module-load/first-call cost),
  // which shrinks the window in which an eager Spin 3D click waits on a cold embed.
  useEffect(() => {
    const warm = (): void => { getConformerWorkerClient()?.warmup({ sessionId: `warmup:${Date.now()}` }); };
    const win = globalThis as typeof globalThis & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof win.requestIdleCallback === "function") {
      const handle = win.requestIdleCallback(warm, { timeout: 1500 });
      return () => win.cancelIdleCallback?.(handle);
    }
    const timer = setTimeout(warm, 600); // Safari < 17 etc.: no rIC, warm shortly after boot
    return () => clearTimeout(timer);
  }, []);

  // Speculatively generate the conformer when a single eligible molecule is selected:
  // by the time the user reaches the Spin 3D button the result is usually cached.
  useEffect(() => {
    if (spin3dState) return;
    const selectedIds = [
      ...new Set([
        ...document.selection.objectIds,
        ...(selectedNativeMoleculePart ? [selectedNativeMoleculePart.objectId] : [])
      ])
    ];
    if (selectedIds.length !== 1) return;
    const molecule = document.pages[0]?.objects.find(
      (object): object is MoleculeObject => object.id === selectedIds[0] && object.type === "molecule"
    );
    if (!molecule || !isNativeMoleculeGraph(molecule) || molecule.atoms.length < 2) return;
    if (molecule.atoms.length > SPIN_PREFETCH_MAX_ATOMS) {
      // Speculative embeds on large structures occupy the worker for seconds and
      // make an actual click feel hung behind them. Compute these on demand only.
      broadcastSpin3dTraceEvent(createSpin3dTraceEvent({
        sessionId: `prefetch:${molecule.id}`,
        kind: "spin",
        stage: "prefetch.skip-large",
        status: "info",
        atomCount: molecule.atoms.length
      }));
      return;
    }
    // Short debounce: long enough that browsing selections (marquee / arrow-key) still
    // coalesce to one prefetch, short enough that a deliberate selection (e.g. a paste)
    // starts its embed promptly — every ms shaved here is a ms sooner the embed completes
    // and the click lands in the fast cache-hit path.
    const timer = setTimeout(() => {
      const client = getConformerWorkerClient();
      if (!client) return;
      const molfile = moleculeToMolfileV2000(molecule, { fromDocFrame: true });
      if (lastSpinPrefetchRef.current === molfile) return;
      lastSpinPrefetchRef.current = molfile;
      client.warmup({ sessionId: `warmup:${Date.now()}` });
      const options = conformerOptionsForSpin3d(spin3dSettings, molecule.atoms.length);
      client.prefetch(molfile, molecule.atoms.length, options, spin3dSettings.enginePreference, { sessionId: `prefetch:${molecule.id}:${Date.now()}` });
    }, 120);
    return () => clearTimeout(timer);
  }, [document, selectedNativeMoleculePart, spin3dState, spin3dSettings]);

  const handleSpinOverlayPointerDown = useCallback((event: PointerEvent<SVGSVGElement>) => {
    const state = spin3dStateRef.current;
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();
    // Map the click to page coordinates (the overlay's viewBox spans the page).
    const rect = event.currentTarget.getBoundingClientRect();
    const page = documentRef.current.pages[0];
    const pageX = rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * page.width : 0;
    const pageY = rect.height > 0 ? ((event.clientY - rect.top) / rect.height) * page.height : 0;
    // Interactive 3D tug: if a sidecar session is attached to this molecule and the grab lands
    // ON an atom, tug that atom instead of rotating the whole molecule. Grabbing empty space
    // still rotates; clicking outside still flattens.
    const tugWorkspace = interactive3dWorkspaceRef.current;
    if (tugWorkspace?.session && tugWorkspace.objectId === state.objectId) {
      const projection = projectSpin(state.coords3d, state.bondPairs, state.quat, state.placement);
      const hitRadius = Math.max(6, 0.5 * state.placement.scale * medianBondLength3d(state.coords3d, state.bondPairs));
      let bestIndex = -1;
      let bestScore = Infinity;
      for (const atom of projection.atoms) {
        const dist = Math.hypot(atom.sx - pageX, atom.sy - pageY);
        // Break ties toward the nearer-the-viewer atom (larger depth) so overlapping atoms
        // grab the one on top.
        const score = dist - atom.depth * 1e-3;
        if (dist <= hitRadius && score < bestScore) {
          bestScore = score;
          bestIndex = atom.index;
        }
      }
      if (bestIndex >= 0) {
        const atomId = interactive3dAtomIdByIndexRef.current[bestIndex];
        if (atomId) {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* best-effort */
          }
          spin3dTugDragRef.current = {
            pointerId: event.pointerId,
            atomId,
            startPageX: pageX,
            startPageY: pageY,
            startModel: [
              state.coords3d[bestIndex * 3],
              state.coords3d[bestIndex * 3 + 1],
              state.coords3d[bestIndex * 3 + 2]
            ]
          };
          sendInteractive3dDragCommandRef.current("beginDrag", atomId);
          return;
        }
      }
    }
    const box = state.selectionBox;
    const pad = 14;
    const insideBox =
      pageX >= box.x - pad &&
      pageX <= box.x + box.width + pad &&
      pageY >= box.y - pad &&
      pageY <= box.y + box.height + pad;
    if (!insideBox) {
      // Click outside the selection box commits the current orientation. Fire-and-forget: the
      // flatten is async (it lazily perceives stereocenters first) and manages its own status.
      void commitSpinFlatten();
      return;
    }
    // Inside the box: grab to rotate. Capture is best-effort.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* ignore — pointer capture is an enhancement, not a requirement */
    }
    applySpin({ ...state, dragging: true, lastClient: { x: event.clientX, y: event.clientY } });
  }, [applySpin, commitSpinFlatten]);

  const handleSpinOverlayPointerMove = useCallback((event: PointerEvent<SVGSVGElement>) => {
    const state = spin3dStateRef.current;
    if (!state) return;
    // Tug in progress: map the cursor's page motion into a model-frame target for the grabbed
    // atom and stream it to the sidecar. The delta is un-projected through the inverse of the
    // current view rotation so the atom follows the cursor in the view plane at any orientation.
    const tug = spin3dTugDragRef.current;
    if (tug && tug.pointerId === event.pointerId) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const page = documentRef.current.pages[0];
      const pageX = rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * page.width : 0;
      const pageY = rect.height > 0 ? ((event.clientY - rect.top) / rect.height) * page.height : 0;
      const scale = state.placement.scale > 1e-6 ? state.placement.scale : 1;
      const viewDelta: Vec3 = [
        (pageX - tug.startPageX) / scale,
        -((pageY - tug.startPageY) / scale), // page y-down → view y-up
        0
      ];
      const modelDelta = rotateVectorByQuat(quatConjugate(state.quat), viewDelta);
      sendInteractive3dDragCommandRef.current("updateDrag", tug.atomId, {
        x: tug.startModel[0] + modelDelta[0],
        y: tug.startModel[1] + modelDelta[1],
        z: tug.startModel[2] + modelDelta[2]
      });
      return;
    }
    if (!state.dragging || !state.lastClient) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    // The overlay SVG fills the page area with viewBox "0 0 pageWidth pageHeight", so a
    // document-space point maps to client pixels by the page zoom (rect size / page size).
    // Pivot the trackball at the molecule's screen centroid (placement.center) — NOT the
    // page-spanning overlay's geometric center. A molecule drawn away from page center
    // would otherwise rotate about the wrong point and the grabbed atom slides off-cursor.
    const page = documentRef.current.pages[0];
    const scaleX = page && page.width > 0 ? rect.width / page.width : 1;
    const scaleY = page && page.height > 0 ? rect.height / page.height : 1;
    const trackball = {
      center: {
        x: rect.left + state.placement.centerX * scaleX,
        y: rect.top + state.placement.centerY * scaleY
      },
      radius: Math.max(120, Math.min(rect.width, rect.height) * 0.4)
    };
    const current = { x: event.clientX, y: event.clientY };
    const quat = applyTrackballDrag(state.quat, state.lastClient, current, trackball);
    // Update ref synchronously so the next event has fresh state; schedule a single
    // rAF to push to React. If one is already pending it will pick up this latest
    // state — no need to schedule another.
    spin3dStateRef.current = { ...state, quat, lastClient: current };
    spinDirtyRef.current = true;
    if (spinRafRef.current === null) {
      spinRafRef.current = requestAnimationFrame(() => {
        spinRafRef.current = null;
        if (spinDirtyRef.current) {
          spinDirtyRef.current = false;
          const s = spin3dStateRef.current;
          if (s) setSpin3dStateRender({ ...s });
        }
      });
    }
  }, []);

  const handleSpinOverlayPointerUp = useCallback((event: PointerEvent<SVGSVGElement>) => {
    const state = spin3dStateRef.current;
    if (!state) return;
    event.preventDefault();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* ignore */
    }
    // Releasing a tug ends the drag on the sidecar (which runs its release settle); the overlay
    // keeps the settled geometry and stays in spin mode for the next tug/rotate.
    const tug = spin3dTugDragRef.current;
    if (tug && tug.pointerId === event.pointerId) {
      spin3dTugDragRef.current = undefined;
      sendInteractive3dDragCommandRef.current("endDrag", tug.atomId);
      return;
    }
    // Releasing ends the rotation but STAYS in spin mode — grab inside the box again
    // to keep rotating, or click outside to flatten (handled in pointer-down). Esc cancels.
    if (state.dragging) {
      applySpin({ ...state, dragging: false, lastClient: undefined });
    }
  }, [applySpin]);

  const cleanUpSelectedStructure3d = useCallback(() => {
    const currentDocument = documentRef.current;
    const selectedObjectIds = [
      ...new Set([
        ...currentDocument.selection.objectIds,
        ...(selectedNativeMoleculePart ? [selectedNativeMoleculePart.objectId] : [])
      ])
    ];

    if (selectedObjectIds.length === 0) {
      setStatus("No selected structure for 3D cleanup");
      return;
    }

    if (selectedObjectIds.length !== 1) {
      setStatus("Select a single structure for 3D cleanup");
      return;
    }

    const objectId = selectedObjectIds[0];
    const object = objectId ? findDocumentObject(currentDocument, objectId) : undefined;
    if (!objectId || object?.type !== "molecule" || !isNativeMoleculeGraph(object) || object.atoms.length < 2) {
      setStatus("3D cleanup needs an editable native molecule");
      return;
    }

    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setObjectContextMenu(undefined);
    setStatus("Rebuilding clean 2D layout…");
    // Engine lazy-loads (same pattern as Spin 3D): the whole re-layout is pure once the module is in.
    void (async () => {
      try {
        const { relayoutMolfile2D } = await import("@chemdraft/ocl-adapter");
        const changed = commitDocumentChange((current) =>
          applyNativeMoleculeEngineRelayout(current, objectId, relayoutMolfile2D)
        );
        setStatus(changed ? "Rebuilt a clean 2D layout" : "Structure already matches the clean layout");
      } catch (error) {
        setStatus(`3D cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, selectedNativeMoleculePart]);

  const cancelInteractive3dDragScheduler = useCallback((): Interactive3dDragSchedulerState | undefined => {
    const scheduler = interactive3dDragSchedulerRef.current;
    if (scheduler?.timer !== undefined) {
      window.clearTimeout(scheduler.timer);
      scheduler.timer = undefined;
    }
    if (scheduler) {
      scheduler.ending = true;
    }
    interactive3dDragSchedulerRef.current = undefined;
    return scheduler;
  }, []);

  const updateInteractive3dWorkspaceSession = useCallback((
    openId: number,
    session: Engine3dWorkspaceSessionState,
    options: { clearDragVisualTarget?: boolean; status?: string } = {}
  ) => {
    setInteractive3dWorkspace((currentWorkspace) => currentWorkspace?.openId === openId
      ? {
          ...currentWorkspace,
          session,
          selectedAtomIds: session.selectedAtomIds.length > 0 ? session.selectedAtomIds : currentWorkspace.selectedAtomIds,
          status: options.status ?? describeEngine3dWorkspaceSession(session),
          energyLabel: interactive3dEnergyLabel(session) ?? currentWorkspace.energyLabel,
          dragVisualTarget: options.clearDragVisualTarget ? undefined : currentWorkspace.dragVisualTarget
        }
      : currentWorkspace);
  }, []);

  const queueInteractive3dSessionClose = useCallback((
    session: Engine3dWorkspaceSessionState | undefined,
    dragScheduler = interactive3dDragSchedulerRef.current
  ) => {
    if (!session) {
      return;
    }
    interactive3dCommandQueueRef.current = interactive3dCommandQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await dragScheduler?.updatePromise?.catch(() => undefined);
        return closeEngine3dWorkspaceSession(session).then(() => undefined);
      })
      .catch(() => undefined);
  }, []);

  const runInteractive3dDragUpdate = useCallback((scheduler: Interactive3dDragSchedulerState) => {
    if (
      scheduler.updateInFlight ||
      scheduler.ending ||
      interactive3dDragSchedulerRef.current !== scheduler ||
      !scheduler.latestTarget
    ) {
      return;
    }

    const target = scheduler.latestTarget;
    // Consume the target as it is dispatched. A newer pointer move re-populates it (and re-arms
    // pendingUpdate); if none arrives, endDrag must not re-send this already-delivered target.
    scheduler.latestTarget = undefined;
    scheduler.pendingUpdate = false;
    scheduler.updateInFlight = true;
    scheduler.lastSentAt = Date.now();
    const updatePromise = interactive3dCommandQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (interactive3dDragSchedulerRef.current !== scheduler) {
          return;
        }
        const latest = interactive3dWorkspaceRef.current;
        if (!latest?.session || latest.openId !== scheduler.openId) {
          return;
        }
        const session = await updateEngine3dWorkspaceDrag(scheduler.session, scheduler.atomId, target);
        if (interactive3dDragSchedulerRef.current !== scheduler) {
          return;
        }
        scheduler.session = session;
        if (!scheduler.ending) {
          updateInteractive3dWorkspaceSession(scheduler.openId, session);
        }
      })
      .catch((error) => {
        if (interactive3dDragSchedulerRef.current !== scheduler) {
          return;
        }
        setInteractive3dWorkspace((latest) => latest?.openId === scheduler.openId
          ? {
              ...latest,
              status: `Sidecar drag failed: ${String(error)}`
            }
          : latest);
      })
      .finally(() => {
        scheduler.updateInFlight = false;
        scheduler.updatePromise = undefined;
        if (interactive3dDragSchedulerRef.current !== scheduler || scheduler.ending) {
          return;
        }
        if (scheduler.pendingUpdate) {
          scheduleInteractive3dDragUpdateRef.current(scheduler);
        }
      });
    scheduler.updatePromise = updatePromise;
  }, [updateInteractive3dWorkspaceSession]);

  const scheduleInteractive3dDragUpdate = useCallback((scheduler: Interactive3dDragSchedulerState) => {
    if (
      scheduler.updateInFlight ||
      scheduler.ending ||
      scheduler.timer !== undefined ||
      interactive3dDragSchedulerRef.current !== scheduler
    ) {
      return;
    }
    const elapsed = Date.now() - scheduler.lastSentAt;
    const delay = Math.max(0, INTERACTIVE_3D_DRAG_UPDATE_INTERVAL_MS - elapsed);
    scheduler.timer = window.setTimeout(() => {
      scheduler.timer = undefined;
      runInteractive3dDragUpdate(scheduler);
    }, delay);
  }, [runInteractive3dDragUpdate]);

  useEffect(() => {
    scheduleInteractive3dDragUpdateRef.current = scheduleInteractive3dDragUpdate;
  }, [scheduleInteractive3dDragUpdate]);

  const pollInteractive3dSessionAfterOpen = useCallback((
    openId: number,
    startSession: Engine3dWorkspaceSessionState
  ) => {
    if (interactive3dPostOpenPollingComplete(startSession)) {
      return;
    }
    const poll = (session: Engine3dWorkspaceSessionState, remaining: number): void => {
      if (remaining <= 0 || interactive3dPostOpenPollingComplete(session)) {
        return;
      }
      window.setTimeout(() => {
        const current = interactive3dWorkspaceRef.current;
        if (
          current?.openId !== openId ||
          current.session?.processSessionId !== session.processSessionId ||
          interactive3dDragSchedulerRef.current?.openId === openId
        ) {
          return;
        }
        void pollEngine3dWorkspaceSessionState(session)
          .then((nextSession) => {
            if (interactive3dPostOpenSessionChanged(session, nextSession)) {
              updateInteractive3dWorkspaceSession(openId, nextSession);
            }
            poll(nextSession, remaining - 1);
          })
          .catch(() => undefined);
      }, INTERACTIVE_3D_POST_OPEN_POLL_MS);
    };
    poll(startSession, INTERACTIVE_3D_POST_OPEN_POLL_COUNT);
  }, [updateInteractive3dWorkspaceSession]);

  // Interactive 3D = Spin 3D overlay + a live sidecar tug session. Opening it ensures the
  // spin overlay is up (which runs a REAL 3D conformer embed — fixing the old flat-2D start)
  // and ARMS the tug attach; the attach effect below opens the sidecar session seeded from
  // that conformer and streams eased coordinates back into the same overlay. There is no
  // separate window or WebGL stage — the molecule the user manipulates IS the drawing.
  const openInteractive3dWorkspace = useCallback(async () => {
    const currentDocument = documentRef.current;
    const selectedObjectIds = [
      ...new Set([
        ...currentDocument.selection.objectIds,
        ...(selectedNativeMoleculePart ? [selectedNativeMoleculePart.objectId] : [])
      ])
    ];

    if (selectedObjectIds.length === 0) {
      setStatus("Select a structure before opening Interactive 3D");
      return;
    }
    if (selectedObjectIds.length !== 1) {
      setStatus("Select a single structure for Interactive 3D");
      return;
    }

    const objectId = selectedObjectIds[0];
    const object = objectId ? findDocumentObject(currentDocument, objectId) : undefined;
    if (object?.type !== "molecule" || !isNativeMoleculeGraph(object) || object.atoms.length < 2) {
      setStatus("Interactive 3D needs an editable native molecule");
      return;
    }

    const status = await readEngine3dSidecarStatus();
    if (!status?.available) {
      setStatus(
        status
          ? `Interactive 3D unavailable; sidecar not configured: ${status.bundledBinaryName}`
          : "Interactive 3D unavailable; Tauri bridge not present"
      );
      return;
    }

    // Arm the tug attach for this molecule and bump the token so the attach effect fires for
    // BOTH the fresh-embed path (spin3dState changes when the overlay mounts) and the reuse
    // path (spin overlay already up — only the token changes). Then ensure the spin overlay
    // is live: startSpin3d reuses a stored conformer or embeds a real one — never flat 2D.
    interactive3dArmRef.current = { objectId };
    setInteractive3dArmToken((token) => token + 1);
    if (spin3dStateRef.current?.objectId !== objectId) {
      await startSpin3d();
    }
  }, [selectedNativeMoleculePart, startSpin3d]);

  useEffect(() => () => {
    const closingDragScheduler = cancelInteractive3dDragScheduler();
    queueInteractive3dSessionClose(interactive3dWorkspaceRef.current?.session, closingDragScheduler);
  }, [cancelInteractive3dDragScheduler, queueInteractive3dSessionClose]);

  // Open a headless sidecar tug session for the armed molecule, seeded from the LIVE spin
  // conformer (a real 3D embed, engine frame). The session is invisible; its coordinate
  // stream flows back into spin3dState so the spin overlay renders the tug. Idempotent: once
  // a session exists for the armed molecule it no-ops.
  const attachInteractive3dTug = useCallback(async () => {
    const arm = interactive3dArmRef.current;
    const spin = spin3dStateRef.current;
    if (!arm || !spin || spin.objectId !== arm.objectId) {
      return;
    }
    const existing = interactive3dWorkspaceRef.current;
    if (existing?.objectId === arm.objectId && (existing.session || existing.status === "attaching")) {
      return; // already attaching/attached for this molecule
    }
    const molecule = findDocumentObject(documentRef.current, arm.objectId);
    if (molecule?.type !== "molecule" || !isNativeMoleculeGraph(molecule)) {
      return;
    }
    if (spin.coords3d.length < molecule.atoms.length * 3) {
      return;
    }

    // atomId -> coords3d index map, and the seed coordinates from the live conformer.
    const idByIndex: string[] = [];
    const seedCoords: Record<string, Engine3DCoordinate> = {};
    molecule.atoms.forEach((atom, index) => {
      idByIndex[index] = atom.id;
      seedCoords[atom.id] = {
        x: spin.coords3d[index * 3],
        y: spin.coords3d[index * 3 + 1],
        z: spin.coords3d[index * 3 + 2]
      };
    });
    interactive3dAtomIdByIndexRef.current = idByIndex;

    const openId = interactive3dOpenSerialRef.current + 1;
    interactive3dOpenSerialRef.current = openId;
    const closingScheduler = cancelInteractive3dDragScheduler();
    queueInteractive3dSessionClose(existing?.session, closingScheduler);

    const status = await readEngine3dSidecarStatus();
    setInteractive3dWorkspace({
      openId,
      objectId: arm.objectId,
      source: status?.source ?? "unknown",
      bridgeAvailable: true,
      status: "attaching",
      selectedAtomIds: [],
      atoms: interactive3dAtomsForMolecule(molecule),
      bonds: interactive3dBondsForMolecule(molecule)
    });
    try {
      const sessionInput = createEngine3dSessionInputFromMolecule(molecule, { coords3dByAtomId: seedCoords });
      const session = await openEngine3dWorkspaceSession({ input: sessionInput });
      // Superseded (a newer attach) or torn down (spin ended / Esc / selection change) while we
      // awaited startup: the workspace no longer carries our openId. Close the freshly opened
      // session so its native child process is not orphaned in the Rust session map.
      if (interactive3dWorkspaceRef.current?.openId !== openId) {
        queueInteractive3dSessionClose(session, cancelInteractive3dDragScheduler());
        return;
      }
      setInteractive3dWorkspace((current) => current?.openId === openId
        ? { ...current, session, status: "tug-ready" }
        : current);
      pollInteractive3dSessionAfterOpen(openId, session);
      setStatus("Interactive 3D: drag an atom to tug · drag empty space to rotate · click outside to flatten · Esc to cancel");
    } catch (error) {
      setInteractive3dWorkspace((current) => current?.openId === openId ? undefined : current);
      setStatus(`Interactive 3D sidecar session failed: ${String(error)}`);
    }
  }, [cancelInteractive3dDragScheduler, pollInteractive3dSessionAfterOpen, queueInteractive3dSessionClose]);

  // Fire the attach once the spin overlay is live for the armed molecule (covers both the
  // async fresh-embed path — spin3dState becomes defined — and the reuse path — only the arm
  // token changes). attachInteractive3dTug itself is idempotent.
  useEffect(() => {
    const arm = interactive3dArmRef.current;
    if (arm && spin3dState?.objectId === arm.objectId) {
      void attachInteractive3dTug();
    }
  }, [spin3dState, interactive3dArmToken, attachInteractive3dTug]);

  // Spin overlay ended (flatten / cancel / Esc / selection change) → tear the tug session
  // down. Flatten has already committed the tugged geometry via the overlay's coords3d, so
  // there is nothing to persist here.
  useEffect(() => {
    if (spin3dState || !interactive3dWorkspaceRef.current) {
      return;
    }
    interactive3dArmRef.current = undefined;
    const session = interactive3dWorkspaceRef.current.session;
    const closingScheduler = cancelInteractive3dDragScheduler();
    setInteractive3dWorkspace(undefined);
    queueInteractive3dSessionClose(session, closingScheduler);
  }, [spin3dState, cancelInteractive3dDragScheduler, queueInteractive3dSessionClose]);

  // Stream sidecar coordinates back into the spin overlay: rebuild the conformer's coords3d
  // from the latest snapshot (dragged atom pinned to its live cursor target for zero lag) and
  // hand it to applySpin. Placement/bond-render stay fixed so the molecule deforms in place
  // rather than re-centering each frame; the overlay recomputes depth cues from the new coords.
  const interactive3dSessionCoords = interactive3dWorkspace?.session?.coords3dByAtomId;
  const interactive3dDragVisualTarget = interactive3dWorkspace?.dragVisualTarget;
  useEffect(() => {
    if (!interactive3dSessionCoords) {
      return;
    }
    const spin = spin3dStateRef.current;
    const idByIndex = interactive3dAtomIdByIndexRef.current;
    if (!spin || idByIndex.length * 3 !== spin.coords3d.length) {
      return;
    }
    const next = new Float64Array(spin.coords3d.length);
    let changed = false;
    for (let index = 0; index < idByIndex.length; index += 1) {
      const atomId = idByIndex[index];
      const pinned = interactive3dDragVisualTarget?.atomId === atomId
        ? interactive3dDragVisualTarget.target
        : undefined;
      const coord = pinned ?? interactive3dSessionCoords[atomId];
      if (coord) {
        next[index * 3] = coord.x;
        next[index * 3 + 1] = coord.y;
        next[index * 3 + 2] = coord.z;
        if (coord.x !== spin.coords3d[index * 3] ||
            coord.y !== spin.coords3d[index * 3 + 1] ||
            coord.z !== spin.coords3d[index * 3 + 2]) {
          changed = true;
        }
      } else {
        next[index * 3] = spin.coords3d[index * 3];
        next[index * 3 + 1] = spin.coords3d[index * 3 + 1];
        next[index * 3 + 2] = spin.coords3d[index * 3 + 2];
      }
    }
    if (changed) {
      applySpin({ ...spin, coords3d: next });
    }
  }, [interactive3dSessionCoords, interactive3dDragVisualTarget, applySpin]);

  useEffect(() => {
    if (!interactive3dWorkspace?.bridgeAvailable || interactive3dWorkspace.session) {
      return undefined;
    }
    if (!interactive3dWorkspace.status.startsWith("Starting sidecar session")) {
      return undefined;
    }
    const openId = interactive3dWorkspace.openId;
    const timer = window.setTimeout(() => {
      setInteractive3dWorkspace((current) => current?.openId === openId && !current.session
        ? {
            ...current,
            status: "Sidecar session timed out. Close and reopen 3D Workspace."
          }
        : current);
      setStatus("Interactive 3D sidecar session timed out");
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [interactive3dWorkspace]);

  const sendInteractive3dDragCommand = useCallback((
    phase: "beginDrag" | "updateDrag" | "endDrag",
    atomId: string,
    target?: Engine3DCoordinate
  ) => {
    const current = interactive3dWorkspaceRef.current;
    if (!current?.session) {
      return;
    }

    if (phase === "beginDrag") {
      cancelInteractive3dDragScheduler();
      const generation = interactive3dDragGenerationRef.current + 1;
      interactive3dDragGenerationRef.current = generation;
      const scheduler: Interactive3dDragSchedulerState = {
        generation,
        openId: current.openId,
        atomId,
        session: current.session,
        pendingUpdate: false,
        updateInFlight: false,
        ending: false,
        lastSentAt: 0
      };
      interactive3dDragSchedulerRef.current = scheduler;
      setInteractive3dWorkspace((workspace) => workspace?.openId === current.openId
        ? {
            ...workspace,
            status: `beginDrag · ${atomId}`,
            dragVisualTarget: undefined
          }
        : workspace);
      interactive3dCommandQueueRef.current = interactive3dCommandQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (interactive3dDragSchedulerRef.current !== scheduler) {
            return;
          }
          const session = await beginEngine3dWorkspaceDrag(scheduler.session, atomId);
          if (interactive3dDragSchedulerRef.current !== scheduler) {
            return;
          }
          scheduler.session = session;
          updateInteractive3dWorkspaceSession(scheduler.openId, session);
        })
        .catch((error) => {
          if (interactive3dDragSchedulerRef.current === scheduler) {
            interactive3dDragSchedulerRef.current = undefined;
          }
          setInteractive3dWorkspace((latest) => latest?.openId === current.openId
            ? {
                ...latest,
                status: `Sidecar drag failed: ${String(error)}`,
                dragVisualTarget: undefined
              }
            : latest);
        });
      return;
    }

    const scheduler = interactive3dDragSchedulerRef.current;
    if (!scheduler || scheduler.openId !== current.openId || scheduler.atomId !== atomId) {
      return;
    }

    if (phase === "updateDrag") {
      if (!target || scheduler.ending) {
        return;
      }
      const latestTarget = { ...target };
      scheduler.latestTarget = latestTarget;
      scheduler.pendingUpdate = true;
      setInteractive3dWorkspace((workspace) => workspace?.openId === scheduler.openId
        ? {
            ...workspace,
            status: `${phase} · ${atomId} → ${latestTarget.x.toFixed(2)}, ${latestTarget.y.toFixed(2)}, ${latestTarget.z.toFixed(2)}`,
            dragVisualTarget: {
              generation: scheduler.generation,
              atomId,
              target: latestTarget
            }
          }
        : workspace);
      scheduleInteractive3dDragUpdate(scheduler);
      return;
    }

    scheduler.ending = true;
    if (scheduler.timer !== undefined) {
      window.clearTimeout(scheduler.timer);
      scheduler.timer = undefined;
    }
    setInteractive3dWorkspace((workspace) => workspace?.openId === scheduler.openId
      ? {
          ...workspace,
          status: `endDrag · ${atomId}`
        }
      : workspace);
    interactive3dCommandQueueRef.current = interactive3dCommandQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await scheduler.updatePromise?.catch(() => undefined);
        if (interactive3dDragSchedulerRef.current !== scheduler) {
          return;
        }
        let session = scheduler.session;
        if (scheduler.latestTarget) {
          session = await updateEngine3dWorkspaceDrag(session, atomId, scheduler.latestTarget);
          if (interactive3dDragSchedulerRef.current !== scheduler) {
            return;
          }
          scheduler.session = session;
        }
        session = await endEngine3dWorkspaceDrag(session, atomId);
        if (interactive3dDragSchedulerRef.current !== scheduler) {
          return;
        }
        scheduler.session = session;
        interactive3dDragSchedulerRef.current = undefined;
        updateInteractive3dWorkspaceSession(scheduler.openId, session, { clearDragVisualTarget: true });
      })
      .catch((error) => {
        if (interactive3dDragSchedulerRef.current === scheduler) {
          interactive3dDragSchedulerRef.current = undefined;
        }
        setInteractive3dWorkspace((latest) => latest?.openId === current.openId
          ? {
              ...latest,
              status: `Sidecar drag failed: ${String(error)}`,
              dragVisualTarget: undefined
            }
          : latest);
      });
  }, [
    cancelInteractive3dDragScheduler,
    scheduleInteractive3dDragUpdate,
    updateInteractive3dWorkspaceSession
  ]);
  // Keep the forward ref the spin pointer handlers call in sync with the latest dispatcher.
  sendInteractive3dDragCommandRef.current = sendInteractive3dDragCommand;

  const selectAllCanvasObjects = useCallback(() => {
    const currentDocument = documentRef.current;
    const page = currentDocument.pages[0];
    if (!page || page.objects.length === 0) {
      setStatus("No canvas objects to select");
      return;
    }

    const pageId = page.id;
    const changed = replacePresentDocument((current) => selectAllDocumentObjects(current, pageId));
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setObjectContextMenu(undefined);
    toolBeforeTextPlacementRef.current = undefined;
    const selectToolState = createActiveToolState("tool.select");
    activeToolCommandIdRef.current = selectToolState.activeCommandId;
    setActiveToolState(selectToolState);
    setStatus(changed
      ? page.objects.length === 1 ? "Selected 1 canvas object" : `Selected ${page.objects.length} canvas objects`
      : "All canvas objects already selected");
  }, [assignHoveredNativeDeleteTarget, replacePresentDocument]);

  const startAtomLabelEdit = useCallback((target: NativeMoleculeDeleteTarget, options: AtomLabelEditOptions = {}): boolean => {
    if (target.kind !== "atom") {
      return false;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, target.objectId);
    if (object?.type !== "molecule") {
      return false;
    }

    const atom = object.atoms.find((candidate) => candidate.id === target.atomId);
    if (!atom) {
      return false;
    }

    replacePresentDocument((current) => selectDocumentObject(current, target.objectId));
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit({
      objectId: target.objectId,
      atomId: target.atomId,
      initialElement: atom.element,
      draft: options.clearDraft ? "" : atom.element
    });
    setSelectedNativeMoleculePart({ objectId: target.objectId, kind: "atom", atomId: target.atomId });
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setStatus("Editing atom label");
    return true;
  }, [replacePresentDocument]);

  const updateAtomLabelDraft = useCallback((state: AtomLabelEditState, draft: string) => {
    setActiveAtomLabelEdit((current) =>
      current && current.objectId === state.objectId && current.atomId === state.atomId
        ? { ...current, draft }
        : current
    );

    if (draft.trim().length === 0) {
      return;
    }

    replacePresentDocument((current) =>
      applyNativeAtomElementTarget(current, {
        objectId: state.objectId,
        kind: "atom",
        atomId: state.atomId,
        distanceToPointer: 0
      }, draft)
    );
  }, [replacePresentDocument]);

  const cancelAtomLabelEdit = useCallback((state: AtomLabelEditState) => {
    replacePresentDocument((current) =>
      applyNativeAtomElementTarget(current, {
        objectId: state.objectId,
        kind: "atom",
        atomId: state.atomId,
        distanceToPointer: 0
      }, state.initialElement)
    );
    setActiveAtomLabelEdit(undefined);
    setStatus("Atom label unchanged");
  }, [replacePresentDocument]);

  const pastePointForViewport = useCallback((): ClientPoint => {
    const canvas = canvasRegionRef.current;
    const page = pageRef.current;
    if (!canvas || !page) {
      return {
        x: activePage.margin.left + 24,
        y: activePage.margin.top + 24
      };
    }

    const canvasRect = canvas.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const clientPoint = {
      x: canvasRect.left + canvas.clientWidth / 2,
      y: canvasRect.top + canvas.clientHeight / 2
    };

    return {
      x: clamp((clientPoint.x - pageRect.left) / viewportRef.current.scale, 0, activePage.width),
      y: clamp((clientPoint.y - pageRect.top) / viewportRef.current.scale, 0, activePage.height)
    };
  }, [activePage.height, activePage.margin.left, activePage.margin.top, activePage.width]);

  const clearScheduledTextEditorFocus = useCallback(() => {
    textEditorFocusTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    textEditorFocusTimeoutsRef.current = [];
  }, []);

  const focusTextObjectEditor = useCallback((objectId: string) => {
    clearScheduledTextEditorFocus();

    const focusEditor = () => {
      const editor = pageRef.current?.querySelector<HTMLTextAreaElement>(
        `[data-object-id="${objectId}"] .text-object-editor`
      );
      if (!editor) {
        return;
      }

      window.focus();
      editor.focus({ preventScroll: true });
      if (editor.value === "Text") {
        editor.select();
      }
    };

    const focusNativeSurfaceAndEditor = () => {
      void focusCurrentWindowAndWebview().finally(focusEditor);
      focusEditor();
    };

    focusNativeSurfaceAndEditor();
    textEditorFocusTimeoutsRef.current = [0, 16, 80].map((delay) =>
      window.setTimeout(focusNativeSurfaceAndEditor, delay)
    );
  }, [clearScheduledTextEditorFocus]);

  const recordTextSelection = useCallback((objectId: string, range: NativeTextSelectionRange) => {
    const nextSelection = { objectId, range };
    activeTextSelectionRef.current = nextSelection;
    setActiveTextSelection((current) =>
      current?.objectId === objectId &&
      current.range.start === range.start &&
      current.range.end === range.end
        ? current
        : nextSelection
    );
  }, []);

  useEffect(() => () => {
    clearScheduledTextEditorFocus();
  }, [clearScheduledTextEditorFocus]);

  const restoreToolAfterTextPlacement = useCallback(() => {
    const previousToolState = toolBeforeTextPlacementRef.current;
    toolBeforeTextPlacementRef.current = undefined;
    if (!previousToolState || previousToolState.activeCommandId === "tool.text") {
      return;
    }

    activeToolCommandIdRef.current = previousToolState.activeCommandId;
    setActiveToolState(previousToolState);
    void broadcastToolsetActiveTool(previousToolState.activeCommandId).catch(() => undefined);
  }, []);

  const restoreToolAfterEyedropper = useCallback(() => {
    const previousToolState = toolBeforeEyedropperRef.current ?? createActiveToolState("tool.select");
    const previousToolTitle = toolCommandSpecs.find((candidate) =>
      candidate.id === previousToolState.activeCommandId
    )?.title ?? "Selection Tool";

    toolBeforeEyedropperRef.current = undefined;
    toolBeforeTextPlacementRef.current = undefined;
    activeToolCommandIdRef.current = previousToolState.activeCommandId;
    setActiveToolState(previousToolState);
    void broadcastToolsetActiveTool(previousToolState.activeCommandId).catch(() => undefined);
    setStatus(drawingToolStatusLabel(previousToolState.activeCommandId, previousToolTitle));
  }, [toolCommandSpecs]);

  const switchToSelectTool = useCallback(() => {
    const selectToolState = createActiveToolState("tool.select");
    activeToolCommandIdRef.current = selectToolState.activeCommandId;
    setActiveToolState(selectToolState);
    void broadcastToolsetActiveTool(selectToolState.activeCommandId).catch(() => undefined);
  }, []);

  const applyTextDocumentAtPoint = useCallback((point: ClientPoint) => {
    const currentDocument = documentRef.current;
    const nextDocument = insertNativeTextObject(currentDocument, point, "Text", textStyleDefaults);
    const inserted = getSelectedTextObject(nextDocument);
    commitDocumentChange(nextDocument);
    restoreToolAfterTextPlacement();
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(inserted?.id);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    if (inserted) {
      focusTextObjectEditor(inserted.id);
    }
    setStatus("Inserted text - type to replace placeholder");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, focusTextObjectEditor, restoreToolAfterTextPlacement, textStyleDefaults]);

  /** Drop the interaction chrome a stamp invalidates. Every sibling placement path does this; a
   *  bond part-selection left lit here would keep receiving style commands aimed at the stamp.
   *  Uses only stable state setters, so callers need no extra dependencies. */
  const clearStampInteractionState = useCallback(() => {
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveGraphicTransformObjectId(undefined);
    setSelectedGraphicPathNode(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
  }, []);

  // Symbol tools stamp one glyph per click and stay active for repeated stamping — no inline text
  // editor, unlike tool.text.
  const applySymbolGlyphAtPoint = useCallback((point: ClientPoint, glyph: string) => {
    const currentDocument = documentRef.current;
    commitDocumentChange(insertNativeSymbolGlyph(currentDocument, point, glyph, textStyleDefaults));
    clearStampInteractionState();
    assignHoveredNativeDeleteTarget(undefined);
    setStatus(`Stamped ${glyph}`);
  }, [assignHoveredNativeDeleteTarget, clearStampInteractionState, commitDocumentChange, textStyleDefaults]);

  const applyBracketAtPoint = useCallback((point: ClientPoint, bracketKind: BracketObject["bracketKind"]) => {
    const currentDocument = documentRef.current;
    commitDocumentChange(insertNativeBracket(currentDocument, point, bracketKind));
    clearStampInteractionState();
    assignHoveredNativeDeleteTarget(undefined);
    setStatus(`Inserted ${bracketKind} bracket`);
  }, [assignHoveredNativeDeleteTarget, clearStampInteractionState, commitDocumentChange]);

  const applyNativeArtDocumentAtPoint = useCallback((point: ClientPoint, commandId: string) => {
    const currentDocument = documentRef.current;
    const nextDocument = insertNativeArtGraphicObject(currentDocument, point, commandId);
    if (nextDocument === currentDocument) {
      setStatus("Art tool unavailable");
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    switchToSelectTool();
    setStatus(selectToolStatusLabel());
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, switchToSelectTool]);

  const resetPasteUiState = useCallback((editTextObjectId?: string) => {
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(editTextObjectId);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
  }, [assignHoveredNativeDeleteTarget]);

  const applySyncClipboardPayload = useCallback((detectedPayload: ClipboardDetectedPayload) => {
    const result = applyClipboardPastePayload(
      documentRef.current,
      detectedPayload,
      pastePointForViewport(),
      textStyleDefaults
    );
    if (result.document !== documentRef.current) {
      commitDocumentChange(result.document);
    }
    resetPasteUiState(result.editTextObjectId);
    setStatus(result.status);
  }, [commitDocumentChange, pastePointForViewport, resetPasteUiState, textStyleDefaults]);

  // SMILES → editable 2D structure with stereochemistry. The depiction engines are loaded
  // on demand (kept out of the static startup graph). Returns false when the text isn't a
  // parseable SMILES, so callers can fall back to pasting it as plain text.
  const renderPastedSmiles = useCallback(async (smilesText: string): Promise<boolean> => {
    try {
      const ocl = await import("@chemdraft/ocl-adapter");
      let depiction: ReturnType<typeof pastedStructureDepictionFromMolfile>;
      let stereoCount = 0;
      try {
        const [{ registerRdkitWasmLoader }, rdkit] = await Promise.all([
          import("./rdkitWasmLoader"),
          import("@chemdraft/rdkit-adapter")
        ]);
        registerRdkitWasmLoader();
        const generatedMolfile = await rdkit.generateSmiles2DMolfile(smilesText);
        depiction = pastedStructureDepictionFromMolfile(generatedMolfile);
        stereoCount = ocl.perceiveStereoCentersFromMolfile(generatedMolfile)
          .filter((center) => center.isStereoCenter).length;
      } catch {
        // RDKit is the readability-first path for fused/bridged systems. OpenChemLib remains a
        // complete local fallback if its WASM asset cannot be loaded or cannot depict a SMILES.
        const fallback = ocl.depictSmiles2D(smilesText);
        try {
          depiction = pastedStructureDepictionFromMolfile(fallback.molfile);
          stereoCount = ocl.perceiveStereoCentersFromMolfile(fallback.molfile)
            .filter((center) => center.isStereoCenter).length;
        } catch {
          // Very large layouts can overflow V2000's fixed-width coordinate columns. Preserve
          // OCL's structured atoms/bonds directly in that case rather than rejecting a valid
          // peptide just because its compatibility molfile cannot be reparsed.
          depiction = {
            atoms: fallback.atoms.map((atom) => ({
              element: atom.element,
              x: atom.x,
              y: atom.y,
              charge: atom.charge
            })),
            bonds: fallback.bonds.map((bond) => ({
              from: bond.from,
              to: bond.to,
              order: bond.order === "aromatic" || bond.order === "unknown" ? "single" : bond.order,
              wedge: bond.wedge
            }))
          };
          // The status line reports stereocenters; OCL can usually still perceive its own
          // molfile even when the fixed-column reparse above failed. Only if perception also
          // fails do we approximate with the wedge-bond count.
          try {
            stereoCount = ocl.perceiveStereoCentersFromMolfile(fallback.molfile)
              .filter((center) => center.isStereoCenter).length;
          } catch {
            stereoCount = fallback.bonds.filter((bond) => bond.wedge !== null).length;
          }
        }
      }
      if (depiction.atoms.length === 0) {
        return false;
      }
      const nextDocument = insertSmilesMolecule(
        documentRef.current,
        pastePointForViewport(),
        {
          atoms: depiction.atoms,
          bonds: depiction.bonds
        },
        smilesText
      );
      commitDocumentChange(nextDocument);
      resetPasteUiState();
      // A pasted structure can be larger than the current page (e.g. a long peptide). Offer
      // the same page-resize prompt the external-CDXML import path uses, when the pasted
      // content overflows and a larger preset (up to A0) would fit it.
      const fit = recommendImportedPageFit(nextDocument);
      setPageFitPrompt(fit ? { ...fit, displayName: "The pasted structure" } : undefined);
      const baseStatus = `Pasted SMILES structure — ${depiction.atoms.length} atoms${stereoCount ? `, ${stereoCount} stereocenter${stereoCount === 1 ? "" : "s"}` : ""}`;
      setStatus(fit
        ? `${baseStatus}; content exceeds ${pageFitPromptLayoutLabel(fit.currentPageTitle, fit.currentOrientation)}`
        : baseStatus);
      return true;
    } catch {
      return false;
    }
  }, [commitDocumentChange, pastePointForViewport, resetPasteUiState]);

  const applyDetectedClipboardPayload = useCallback((detectedPayload: ClipboardDetectedPayload) => {
    if (detectedPayload.kind === "smiles") {
      void renderPastedSmiles(detectedPayload.text).then((rendered) => {
        if (!rendered) {
          applySyncClipboardPayload({ kind: "plain-text", text: detectedPayload.text, sourceType: detectedPayload.sourceType, warnings: [] });
          setStatus("Clipboard SMILES could not be parsed; pasted as text");
        }
      });
      return;
    }
    if (detectedPayload.kind === "inchi") {
      applySyncClipboardPayload({ kind: "plain-text", text: detectedPayload.text, sourceType: detectedPayload.sourceType, warnings: [] });
      setStatus("InChI detected — structure import from InChI isn't supported yet; pasted as text");
      return;
    }
    // Plain text that looks like a SMILES: confirm with the engine, else paste as text.
    if (detectedPayload.kind === "plain-text" && looksLikeSmiles(detectedPayload.text)) {
      void renderPastedSmiles(detectedPayload.text).then((rendered) => {
        if (!rendered) {
          applySyncClipboardPayload(detectedPayload);
        }
      });
      return;
    }
    applySyncClipboardPayload(detectedPayload);
  }, [applySyncClipboardPayload, renderPastedSmiles]);

  const applySelectionClipboardPayload = useCallback((payload: NonNullable<ReturnType<typeof createSelectionClipboardPayload>>) => {
    const placement = nextSelectionClipboardPastePlacement(
      payload,
      selectionClipboardPasteStateRef.current,
      activePage
    );
    const nextDocument = pasteSelectionClipboardPayload(
      documentRef.current,
      payload,
      placement.point
    );
    if (nextDocument === documentRef.current) {
      setStatus("Clipboard selection unchanged");
      return;
    }

    selectionClipboardPasteStateRef.current = placement.state;
    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setStatus("Pasted ChemDraft selection");
  }, [activePage, assignHoveredNativeDeleteTarget, commitDocumentChange]);

  const deleteSelectionAfterClipboardCut = useCallback(() => {
    const nextDocument = deleteSelectedDocumentObjects(documentRef.current);
    if (nextDocument !== documentRef.current) {
      commitDocumentChange(nextDocument);
      setActiveEditorObjectId(undefined);
      setActiveTextEditObjectId(undefined);
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setSelectedNativeMoleculePart(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      setFreeformNativeBond(undefined);
    }
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange]);

  const copySelectionToClipboard = useCallback(async (mode: "copy" | "cut") => {
    const payload = createSelectionClipboardPayload(documentRef.current);
    if (!payload) {
      setStatus(mode === "copy" ? "Select objects before copying" : "Select objects before cutting");
      return;
    }

    const didWrite = await writeClipboardTextItems(selectionClipboardTextItems(payload));
    if (!didWrite) {
      setStatus(mode === "copy" ? "Copy failed: clipboard unavailable" : "Cut canceled: clipboard unavailable");
      return;
    }

    selectionClipboardPayloadRef.current = payload;
    selectionClipboardPasteStateRef.current = initialSelectionClipboardPasteState(payload, mode);

    if (mode === "cut") {
      deleteSelectionAfterClipboardCut();
      setStatus("Cut ChemDraft selection");
      return;
    }

    setStatus("Copied ChemDraft selection");
  }, [deleteSelectionAfterClipboardCut]);

  const pasteClipboard = useCallback(async () => {
    const rawPayload = await readClipboardPayload();
    const selectionPayload = rawPayload.textItems
      .map((item) => parseSelectionClipboardPayload(item.text))
      .find((payload) => payload !== undefined);
    if (selectionPayload) {
      applySelectionClipboardPayload(selectionPayload);
      return;
    }

    const detectedPayload = inspectClipboardPayload(rawPayload);
    if (detectedPayload.kind !== "empty") {
      applyDetectedClipboardPayload(detectedPayload);
      return;
    }

    // Only reuse the last in-app ChemDraft selection when the clipboard has nothing usable;
    // otherwise the actual clipboard content above (e.g. external text/SMILES) wins.
    if (selectionClipboardPayloadRef.current) {
      applySelectionClipboardPayload(selectionClipboardPayloadRef.current);
    }
  }, [applyDetectedClipboardPayload, applySelectionClipboardPayload]);

  const updateTextObjectContent = useCallback((objectId: string, text: string) => {
    replacePresentDocument((current) => updateNativeTextObjectText(current, objectId, text));
  }, [replacePresentDocument]);

  const startTextObjectEdit = useCallback((objectId: string) => {
    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    if (object?.type !== "text") {
      return;
    }

    replacePresentDocument((current) => selectDocumentObject(current, objectId));
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(objectId);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    focusTextObjectEditor(objectId);
    setStatus("Editing text");
  }, [assignHoveredNativeDeleteTarget, focusTextObjectEditor, replacePresentDocument]);

  const applyTextStyleCommand = useCallback((commandId: string): boolean => {
    const currentDocument = documentRef.current;
    const toolbarStyleTarget = toolbarStyleTargetRef.current;
    const snapshotTextSelection = toolbarStyleTarget?.textRange;
    const activeTextObject = activeTextEditObjectId
      ? findDocumentObject(currentDocument, activeTextEditObjectId)
      : undefined;
    const selectedTextObject = getSelectedTextObject(currentDocument) ?? (
      activeTextObject?.type === "text" ? activeTextObject : undefined
    );
    const snapshotTextObject = !selectedTextObject && snapshotTextSelection
      ? findDocumentObject(currentDocument, snapshotTextSelection.objectId)
      : undefined;
    const selected = selectedTextObject ?? (
      snapshotTextObject?.type === "text" ? snapshotTextObject : undefined
    );
    const selectedTextRange = selected && (
      activeTextEditObjectId === selected.id &&
      activeTextSelectionRef.current?.objectId === selected.id
      ? activeTextSelectionRef.current.range
      : snapshotTextSelection?.objectId === selected.id
        ? snapshotTextSelection.range
        : undefined
    );
    const hasSelectedTextRange = Boolean(
      selectedTextRange && selectedTextRange.start !== selectedTextRange.end
    );
    const textScript = textScriptForCommand(commandId);
    if (textScript) {
      if (selected) {
        const currentScript = hasSelectedTextRange && selectedTextRange
          ? textScriptForTextRange(selected, selectedTextRange)
          : textScriptForTextObject(selected);
        const nextScript = textScript === "normal" || currentScript !== textScript ? textScript : "normal";
        const changed = commitDocumentChange(hasSelectedTextRange && selectedTextRange
          ? updateNativeTextObjectScriptRange(currentDocument, selected.id, selectedTextRange, nextScript)
          : updateNativeTextObjectScript(currentDocument, selected.id, nextScript));
        setActiveTextEditObjectId((current) => current === selected.id ? current : undefined);
        setActiveEditorObjectId(undefined);
        setStatus(changed ? "Updated selected text script" : "Selected text script unchanged");
        return true;
      }

      setStatus("Select text before changing baseline script");
      return true;
    }

    const currentStyle = selected
      ? nativeTextStyleFromObjectStyle(selected.style)
      : textStyleDefaults;
    const stylePatch = textStylePatchForCommand(commandId, currentStyle);

    if (!stylePatch) {
      return false;
    }

    setTextStyleDefaults((current) => nativeTextStyleFromObjectStyle({
      ...current,
      ...stylePatch
    }));

    if (stylePatch.color) {
      const selectedColor = stylePatch.color;
      const liveColorSelection: ToolbarColorSelection = {
        objectIds: [
          ...currentDocument.selection.objectIds,
          ...(activeTextEditObjectId ? [activeTextEditObjectId] : [])
        ],
        moleculePart: nativeSelectionColorTarget(selectedNativeMoleculePart),
        textRange: hasSelectedTextRange && selected && selectedTextRange
          ? { objectId: selected.id, range: selectedTextRange }
          : undefined
      };
      const colorSelection = resolveToolbarColorSelection(currentDocument, liveColorSelection, toolbarStyleTarget);
      const colorResult = applyToolbarColorToSelection(currentDocument, selectedColor, colorSelection);

      if (colorResult.targetedSelection) {
        const changed = commitDocumentChange(colorResult.document);
        setActiveTextEditObjectId((current) => selected && current === selected.id ? current : undefined);
        setActiveEditorObjectId(undefined);
        setStatus(changed ? "Updated selected color" : "Selected color unchanged");
        return true;
      }

      setStatus("Updated text defaults");
      return true;
    }

    if (selected) {
      const changed = commitDocumentChange(hasSelectedTextRange && selectedTextRange
        ? updateNativeTextObjectStyleRange(currentDocument, selected.id, selectedTextRange, stylePatch as Record<string, unknown>)
        : updateNativeTextObjectStyle(currentDocument, selected.id, stylePatch));
      setActiveTextEditObjectId((current) => current === selected.id ? current : undefined);
      setActiveEditorObjectId(undefined);
      setStatus(changed ? "Updated selected text style" : "Selected text style unchanged");
      return true;
    }

    setStatus("Updated text defaults");
    return true;
  }, [activeTextEditObjectId, commitDocumentChange, selectedNativeMoleculePart, textStyleDefaults]);

  const selectedMoleculeRingTargets = useCallback((): NativeMoleculeRingTarget[] => {
    return currentMoleculeInspector.rings.selectedRings.map((ring) => ({
      objectId: ring.objectId,
      kind: "ring" as const,
      ringKey: ring.ringKey
    }));
  }, [currentMoleculeInspector.rings.selectedRings]);

  const applyObjectStyleCommandToDocument = useCallback((
    currentDocument: ChemDraftDocument,
    commandId: string,
    target: GraphicStylePaintTarget,
    ringOverrideMode: ObjectStyleRingOverrideMode = "prompt"
  ): ObjectStyleCommandApplyResult => {
    const targetCommand = objectStyleTargetCommands.find((command) => command.id === commandId);
    if (targetCommand) {
      return { document: currentDocument, handled: true, targeted: true, message: `Targeting ${targetCommand.target}` };
    }

    const ringTargets = selectedMoleculeRingTargets();
    if (ringTargets.length > 0) {
      const ringResult = applyObjectStyleCommandToMoleculeRings(currentDocument, commandId, target, ringTargets);
      if (ringResult.handled) {
        return ringResult;
      }
    }

    const graphicObjectIds = selectedGraphicObjectIds(currentDocument);
    // Any molecule with a selected PART is styled through the part path, so exclude EVERY part-host
    // molecule from whole-molecule styling — not just the primary slot. Otherwise a non-primary
    // selected-part molecule (e.g. A while B is primary) would be styled as a whole object.
    const nativePartHostObjectIds = new Set(selectedNativeMoleculeParts.map((part) => part.objectId));
    const moleculeObjectIds = selectedMoleculeObjectIds(currentDocument).filter((objectId) =>
      !nativePartHostObjectIds.has(objectId)
    );
    const visualEffectObjectIds = selectedVisualEffectObjectIds(currentDocument, {
      excludeMoleculeObjectIds: nativePartHostObjectIds
    });
    const gradientObjectIds = target === "fill"
      ? [...graphicObjectIds, ...moleculeObjectIds]
      : graphicObjectIds;

    const noneCommand = objectStyleNoneCommands.find((command) => command.id === commandId);
    if (noneCommand) {
      let nextDocument = applyGraphicObjectNoneToSelection(currentDocument, noneCommand.target, graphicObjectIds);
      nextDocument = applyMoleculeObjectNoneToSelection(nextDocument, noneCommand.target, moleculeObjectIds);
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: nextDocument,
        handled: true,
        targeted: graphicObjectIds.length > 0 || (noneCommand.target === "fill" && moleculeObjectIds.length > 0),
        message: noneCommand.target === "fill" ? "Removed selected fill" : "Removed selected graphic stroke"
      }, noneCommand.target === "fill" ? moleculeObjectIds : [], ringOverrideMode);
    }

    if (commandId === objectStyleSwapCommand.id) {
      return {
        document: swapGraphicObjectFillAndStroke(currentDocument, graphicObjectIds),
        handled: true,
        targeted: graphicObjectIds.length > 0,
        message: "Swapped selected graphic fill and stroke"
      };
    }

    if (commandId === objectGradientReverseCommand.id) {
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: reverseGraphicObjectGradientStopsForSelection(currentDocument, target, gradientObjectIds),
        handled: true,
        targeted: gradientObjectIds.length > 0,
        message: target === "fill" ? "Reversed selected fill gradient" : "Reversed selected graphic stroke gradient"
      }, target === "fill" ? moleculeObjectIds : [], ringOverrideMode);
    }

    if (commandId === objectGradientRotateCommand.id) {
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: rotateGraphicObjectGradientStopsForSelection(currentDocument, target, gradientObjectIds),
        handled: true,
        targeted: gradientObjectIds.length > 0,
        message: target === "fill" ? "Rotated selected fill gradient stops" : "Rotated selected graphic stroke gradient stops"
      }, target === "fill" ? moleculeObjectIds : [], ringOverrideMode);
    }

    if (commandId === objectGradientAddStopCommand.id) {
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: addGraphicObjectGradientStopForSelection(currentDocument, target, gradientObjectIds),
        handled: true,
        targeted: gradientObjectIds.length > 0,
        message: target === "fill" ? "Added selected fill gradient stop" : "Added selected graphic stroke gradient stop"
      }, target === "fill" ? moleculeObjectIds : [], ringOverrideMode);
    }

    const gradientStopColor = objectGradientStopColorForCommand(commandId);
    if (gradientStopColor) {
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: applyGraphicObjectGradientStopColorForSelection(
          currentDocument,
          target,
          gradientStopColor.stopIndex,
          gradientStopColor.color,
          gradientObjectIds
        ),
        handled: true,
        targeted: gradientObjectIds.length > 0,
        message: target === "fill" ? "Updated selected fill gradient stop color" : "Updated selected graphic stroke gradient stop color"
      }, target === "fill" ? moleculeObjectIds : [], ringOverrideMode);
    }

    const gradientStopOpacity = objectGradientStopOpacityForCommand(commandId);
    if (gradientStopOpacity) {
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: applyGraphicObjectGradientStopOpacityForSelection(
          currentDocument,
          target,
          gradientStopOpacity.stopIndex,
          gradientStopOpacity.opacity,
          gradientObjectIds
        ),
        handled: true,
        targeted: gradientObjectIds.length > 0,
        message: target === "fill" ? "Updated selected fill gradient stop opacity" : "Updated selected graphic stroke gradient stop opacity"
      }, target === "fill" ? moleculeObjectIds : [], ringOverrideMode);
    }

    const gradientStopOffset = objectGradientStopOffsetForCommand(commandId);
    if (gradientStopOffset) {
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: applyGraphicObjectGradientStopOffsetForSelection(
          currentDocument,
          target,
          gradientStopOffset.stopIndex,
          gradientStopOffset.offset,
          gradientObjectIds
        ),
        handled: true,
        targeted: gradientObjectIds.length > 0,
        message: target === "fill" ? "Updated selected fill gradient stop position" : "Updated selected graphic stroke gradient stop position"
      }, target === "fill" ? moleculeObjectIds : [], ringOverrideMode);
    }

    const gradientStopDeleteIndex = objectGradientDeleteStopIndexForCommand(commandId);
    if (gradientStopDeleteIndex !== undefined) {
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: deleteGraphicObjectGradientStopAtIndexForSelection(
          currentDocument,
          target,
          gradientStopDeleteIndex,
          gradientObjectIds
        ),
        handled: true,
        targeted: gradientObjectIds.length > 0,
        message: target === "fill" ? "Deleted selected fill gradient stop" : "Deleted selected graphic stroke gradient stop"
      }, target === "fill" ? moleculeObjectIds : [], ringOverrideMode);
    }

    if (commandId === objectGradientDeleteStopCommand.id) {
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: deleteGraphicObjectGradientStopForSelection(currentDocument, target, gradientObjectIds),
        handled: true,
        targeted: gradientObjectIds.length > 0,
        message: target === "fill" ? "Deleted selected fill gradient stop" : "Deleted selected graphic stroke gradient stop"
      }, target === "fill" ? moleculeObjectIds : [], ringOverrideMode);
    }

    const paintType = objectPaintTypeForCommand(commandId);
    if (paintType) {
      let nextDocument = applyGraphicObjectPaintTypeToSelection(currentDocument, target, paintType, graphicObjectIds);
      nextDocument = applyMoleculeObjectPaintTypeToSelection(nextDocument, target, paintType, moleculeObjectIds);
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: nextDocument,
        handled: true,
        targeted: graphicObjectIds.length > 0 || (target === "fill" && moleculeObjectIds.length > 0),
        message: paintType === "gloss"
          ? "Applied selected gloss fill"
          : `Updated selected ${target} paint`
      }, target === "fill" ? moleculeObjectIds : [], ringOverrideMode);
    }

    const opacity = objectOpacityForCommand(commandId);
    if (opacity) {
      let nextDocument = applyGraphicObjectOpacityToSelection(currentDocument, opacity.key, opacity.value, graphicObjectIds);
      nextDocument = applyMoleculeObjectOpacityToSelection(nextDocument, opacity.key, opacity.value, moleculeObjectIds);
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: nextDocument,
        handled: true,
        targeted: graphicObjectIds.length > 0 || moleculeObjectIds.length > 0,
        message: "Updated selected object opacity"
      }, moleculeObjectIds, ringOverrideMode);
    }

    const disabledEffectKind = objectEffectDisableForCommand(commandId);
    if (disabledEffectKind) {
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: deactivateVisualEffectForSelection(currentDocument, disabledEffectKind, visualEffectObjectIds),
        handled: true,
        targeted: visualEffectObjectIds.length > 0,
        message: `Disabled selected visual ${disabledEffectKind} effect`
      }, moleculeObjectIds, ringOverrideMode);
    }

    const effectKind = objectEffectForCommand(commandId);
    if (effectKind) {
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: applyVisualEffectToSelection(currentDocument, effectKind, visualEffectObjectIds),
        handled: true,
        targeted: visualEffectObjectIds.length > 0,
        message: effectKind === "none"
          ? "Cleared selected visual effects"
          : `Applied selected visual ${effectKind} effect`
      }, moleculeObjectIds, ringOverrideMode);
    }

    const effectColor = objectEffectColorForCommand(commandId);
    if (effectColor) {
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: applyVisualEffectColorToSelection(currentDocument, effectColor.effectKind, effectColor.color, visualEffectObjectIds),
        handled: true,
        targeted: visualEffectObjectIds.length > 0,
        message: `Updated selected visual ${effectColor.effectKind} color`
      }, moleculeObjectIds, ringOverrideMode);
    }

    const effectOpacity = objectEffectOpacityForCommand(commandId);
    if (effectOpacity) {
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: applyVisualEffectOpacityToSelection(currentDocument, effectOpacity.effectKind, effectOpacity.opacity, visualEffectObjectIds),
        handled: true,
        targeted: visualEffectObjectIds.length > 0,
        message: `Updated selected visual ${effectOpacity.effectKind} opacity`
      }, moleculeObjectIds, ringOverrideMode);
    }

    const effectSize = objectEffectSizeForCommand(commandId);
    if (effectSize) {
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: applyVisualEffectSizeToSelection(currentDocument, effectSize.effectKind, effectSize.size, visualEffectObjectIds),
        handled: true,
        targeted: visualEffectObjectIds.length > 0,
        message: `Updated selected visual ${effectSize.effectKind} size`
      }, moleculeObjectIds, ringOverrideMode);
    }

    const strokeWidth = objectStrokeWidthCommands.find((command) => command.id === commandId);
    if (strokeWidth) {
      return {
        document: applyGraphicObjectStrokeStyleToSelection(currentDocument, { strokeWidth: strokeWidth.strokeWidth }, graphicObjectIds),
        handled: true,
        targeted: graphicObjectIds.length > 0,
        message: "Updated selected graphic stroke width"
      };
    }

    const strokeDash = objectStrokeDashCommands.find((command) => command.id === commandId);
    if (strokeDash) {
      const strokeStyle = {
        strokeDasharray: strokeDash.strokeDasharray,
        ...("strokeLineCap" in strokeDash && strokeDash.strokeLineCap ? { strokeLineCap: strokeDash.strokeLineCap } : {})
      };
      return {
        document: applyGraphicObjectStrokeStyleToSelection(currentDocument, strokeStyle, graphicObjectIds),
        handled: true,
        targeted: graphicObjectIds.length > 0,
        message: "Updated selected graphic dash"
      };
    }

    const strokeCap = objectStrokeLineCapCommands.find((command) => command.id === commandId);
    if (strokeCap) {
      return {
        document: applyGraphicObjectStrokeStyleToSelection(currentDocument, { strokeLineCap: strokeCap.strokeLineCap }, graphicObjectIds),
        handled: true,
        targeted: graphicObjectIds.length > 0,
        message: "Updated selected graphic cap"
      };
    }

    const strokeJoin = objectStrokeLineJoinCommands.find((command) => command.id === commandId);
    if (strokeJoin) {
      return {
        document: applyGraphicObjectStrokeStyleToSelection(currentDocument, { strokeLineJoin: strokeJoin.strokeLineJoin }, graphicObjectIds),
        handled: true,
        targeted: graphicObjectIds.length > 0,
        message: "Updated selected graphic join"
      };
    }

    const selectedColor = objectColorForCommand(commandId);
    if (!selectedColor) {
      return { document: currentDocument, handled: false, targeted: false, message: "" };
    }

    if (graphicObjectIds.length > 0 || moleculeObjectIds.length > 0) {
      let nextDocument = applyGraphicObjectColorToSelection(currentDocument, target, selectedColor, graphicObjectIds);
      nextDocument = applyMoleculeObjectColorToSelection(nextDocument, target, selectedColor, moleculeObjectIds);
      return objectStyleResultWithRingOverrideChoice(currentDocument, {
        document: nextDocument,
        handled: true,
        targeted: true,
        message: target === "fill" ? "Updated selected fill" : "Updated selected stroke"
      }, moleculeObjectIds, ringOverrideMode);
    }

    const toolbarStyleTarget = toolbarStyleTargetRef.current;
    const objectStyleObjectIds = currentDocument.selection.objectIds.filter((objectId) =>
      findDocumentObject(currentDocument, objectId)?.type !== "text"
    );
    const objectStyleTarget = toolbarStyleTarget
      ? {
          objectIds: toolbarStyleTarget.objectIds.filter((objectId) =>
            findDocumentObject(currentDocument, objectId)?.type !== "text"
          ),
          moleculePart: toolbarStyleTarget.moleculePart
        }
      : undefined;
    const liveColorSelection: ToolbarColorSelection = {
      objectIds: objectStyleObjectIds,
      moleculePart: nativeSelectionColorTarget(selectedNativeMoleculePart)
    };
    const colorSelection = resolveToolbarColorSelection(currentDocument, liveColorSelection, objectStyleTarget);
    const colorResult = applyToolbarColorToSelection(currentDocument, selectedColor, colorSelection);
    return {
      document: colorResult.document,
      handled: true,
      targeted: colorResult.targetedSelection,
      message: colorResult.changed ? "Updated selected object color" : "Selected object color unchanged"
    };
  }, [selectedMoleculeRingTargets, selectedNativeMoleculeParts]);

  const applyObjectStyleCommand = useCallback((commandId: string): boolean => {
    const targetCommand = objectStyleTargetCommands.find((command) => command.id === commandId);
    if (targetCommand) {
      if (targetCommand.target === "fill" && currentArtStyle && !currentArtStyle.supportsFillAny && currentArtStyle.supportsStrokeAny) {
        setActiveArtPaintTarget("stroke");
        setStatus("Selected graphic uses stroke only");
        return true;
      }
      if (targetCommand.target === "stroke" && currentArtStyle && !currentArtStyle.supportsStrokeAny && currentArtStyle.supportsFillAny) {
        setActiveArtPaintTarget("fill");
        setStatus("Selected graphic uses fill only");
        return true;
      }
      setActiveArtPaintTarget(targetCommand.target);
      setStatus(targetCommand.target === "fill" ? "Targeting graphic fill" : "Targeting graphic stroke");
      return true;
    }

    const result = applyObjectStyleCommandToDocument(documentRef.current, commandId, effectiveArtPaintTarget);
    if (!result.handled) {
      return false;
    }

    if (!result.targeted) {
      setStatus("Select a graphic before changing object style");
      return true;
    }

    if (result.needsRingOverrideChoice) {
      setMoleculeStyleOverridePrompt({
        commandId,
        target: effectiveArtPaintTarget,
        startDocument: documentRef.current,
        objectIds: result.ringOverrideObjectIds ?? []
      });
      setStatus("Choose how to handle per-ring attributes");
      return true;
    }

    const changed = commitDocumentChange(result.document);
    setActiveEditorObjectId(undefined);
    setStatus(changed ? result.message : "Selected object style unchanged");
    return true;
  }, [applyObjectStyleCommandToDocument, commitDocumentChange, currentArtStyle, effectiveArtPaintTarget]);

  const previewObjectStyleCommand = useCallback((commandId: string) => {
    const session = artStylePreviewRef.current;
    const startDocument = session?.startDocument ?? documentRef.current;
    const result = applyObjectStyleCommandToDocument(startDocument, commandId, effectiveArtPaintTarget, "keep");
    if (!result.handled || !result.targeted) {
      return;
    }

    artStylePreviewRef.current = session ?? { startDocument };
    const selectedColor = objectColorForCommand(commandId);
    const graphicObjectIds = selectedColor ? selectedGraphicObjectIds(startDocument) : [];
    if (
      selectedColor &&
      canPreviewGraphicObjectColorOnDom(startDocument, graphicObjectIds, effectiveArtPaintTarget) &&
      previewGraphicObjectColorOnDom(pageRef.current, startDocument, graphicObjectIds, effectiveArtPaintTarget, selectedColor)
    ) {
      return;
    }

    clearArtStyleDomPreview(pageRef.current);
    replacePresentDocument(result.document);
  }, [applyObjectStyleCommandToDocument, effectiveArtPaintTarget, replacePresentDocument]);

  const commitObjectStylePreview = useCallback((commandId: string) => {
    const session = artStylePreviewRef.current;
    if (!session) {
      applyObjectStyleCommand(commandId);
      return;
    }

    const result = applyObjectStyleCommandToDocument(session.startDocument, commandId, effectiveArtPaintTarget);
    artStylePreviewRef.current = null;
    clearArtStyleDomPreview(pageRef.current);
    replacePresentDocument(session.startDocument);
    if (!result.handled || !result.targeted) {
      setStatus("Select a graphic before changing object style");
      return;
    }

    if (result.needsRingOverrideChoice) {
      setMoleculeStyleOverridePrompt({
        commandId,
        target: effectiveArtPaintTarget,
        startDocument: session.startDocument,
        objectIds: result.ringOverrideObjectIds ?? []
      });
      setStatus("Choose how to handle per-ring attributes");
      return;
    }

    const changed = commitDocumentChange(result.document);
    setActiveEditorObjectId(undefined);
    setStatus(changed ? result.message : "Selected object style unchanged");
  }, [applyObjectStyleCommand, applyObjectStyleCommandToDocument, commitDocumentChange, effectiveArtPaintTarget, replacePresentDocument]);

  const cancelObjectStylePreview = useCallback(() => {
    const session = artStylePreviewRef.current;
    if (!session) {
      return;
    }

    artStylePreviewRef.current = null;
    clearArtStyleDomPreview(pageRef.current);
    replacePresentDocument(session.startDocument);
    setStatus("Canceled graphic style edit");
  }, [replacePresentDocument]);

  const applyPendingMoleculeStyleOverrideChoice = useCallback((choice: "keep" | "clear" | "cancel") => {
    const prompt = moleculeStyleOverridePrompt;
    if (!prompt) {
      return;
    }

    setMoleculeStyleOverridePrompt(undefined);
    if (choice === "cancel") {
      setStatus("Canceled molecule style edit");
      return;
    }

    const result = applyObjectStyleCommandToDocument(
      prompt.startDocument,
      prompt.commandId,
      prompt.target,
      choice
    );
    if (!result.handled || !result.targeted) {
      setStatus("Select a molecule before changing object style");
      return;
    }

    const changed = commitDocumentChange(result.document);
    setActiveEditorObjectId(undefined);
    setStatus(changed ? result.message : "Selected object style unchanged");
  }, [applyObjectStyleCommandToDocument, commitDocumentChange, moleculeStyleOverridePrompt]);

  const selectedMoleculeRingTargetsForCommand = useCallback((ringKey: string): NativeMoleculeRingTarget[] => {
    return selectedMoleculeRingTargets().some((target) => target.ringKey === ringKey)
      ? selectedMoleculeRingTargets()
      : [];
  }, [selectedMoleculeRingTargets]);

  const applyMoleculeInspectorCommandToDocument = useCallback((
    currentDocument: ChemDraftDocument,
    commandId: string
  ): { document: ChemDraftDocument; handled: boolean; targeted: boolean; message: string } => {
    const fillColor = moleculeRingFillColorForCommand(commandId);
    if (fillColor) {
      const targets = selectedMoleculeRingTargetsForCommand(fillColor.ringKey);
      return {
        document: targets.reduce(
          (nextDocument, target) => applyMoleculeRingFillColor(nextDocument, target, fillColor.color),
          currentDocument
        ),
        handled: true,
        targeted: targets.length > 0,
        message: targets.length === 1 ? "Updated selected ring fill" : `Updated ${targets.length} selected ring fills`
      };
    }

    const fillNone = moleculeRingFillNoneForCommand(commandId);
    if (fillNone) {
      const targets = selectedMoleculeRingTargetsForCommand(fillNone.ringKey);
      return {
        document: targets.reduce(
          (nextDocument, target) => applyMoleculeRingFillNone(nextDocument, target),
          currentDocument
        ),
        handled: true,
        targeted: targets.length > 0,
        message: targets.length === 1 ? "Removed selected ring fill" : `Removed ${targets.length} selected ring fills`
      };
    }

    const fillOpacity = moleculeRingFillOpacityForCommand(commandId);
    if (fillOpacity) {
      const targets = selectedMoleculeRingTargetsForCommand(fillOpacity.ringKey);
      return {
        document: targets.reduce(
          (nextDocument, target) => applyMoleculeRingFillOpacity(nextDocument, target, fillOpacity.opacity),
          currentDocument
        ),
        handled: true,
        targeted: targets.length > 0,
        message: targets.length === 1 ? "Updated selected ring fill opacity" : `Updated ${targets.length} selected ring fill opacities`
      };
    }

    const effect = moleculeRingEffectForCommand(commandId);
    if (effect) {
      const targets = selectedMoleculeRingTargetsForCommand(effect.ringKey);
      return {
        document: targets.reduce(
          (nextDocument, target) => applyMoleculeRingEffect(nextDocument, target, effect.effectKind),
          currentDocument
        ),
        handled: true,
        targeted: targets.length > 0,
        message: effect.effectKind === "none"
          ? targets.length === 1 ? "Cleared selected ring effects" : `Cleared ${targets.length} selected ring effects`
          : targets.length === 1 ? `Applied selected ring ${effect.effectKind} effect` : `Applied ${targets.length} selected ring ${effect.effectKind} effects`
      };
    }

    const disabledEffect = moleculeRingEffectDisableForCommand(commandId);
    if (disabledEffect) {
      const targets = selectedMoleculeRingTargetsForCommand(disabledEffect.ringKey);
      return {
        document: targets.reduce(
          (nextDocument, target) => deactivateMoleculeRingEffect(nextDocument, target, disabledEffect.effectKind),
          currentDocument
        ),
        handled: true,
        targeted: targets.length > 0,
        message: targets.length === 1
          ? `Disabled selected ring ${disabledEffect.effectKind} effect`
          : `Disabled ${targets.length} selected ring ${disabledEffect.effectKind} effects`
      };
    }

    const effectColor = moleculeRingEffectColorForCommand(commandId);
    if (effectColor) {
      const targets = selectedMoleculeRingTargetsForCommand(effectColor.ringKey);
      return {
        document: targets.reduce(
          (nextDocument, target) => applyMoleculeRingEffectColor(nextDocument, target, effectColor.effectKind, effectColor.color),
          currentDocument
        ),
        handled: true,
        targeted: targets.length > 0,
        message: targets.length === 1
          ? `Updated selected ring ${effectColor.effectKind} color`
          : `Updated ${targets.length} selected ring ${effectColor.effectKind} colors`
      };
    }

    const effectOpacity = moleculeRingEffectOpacityForCommand(commandId);
    if (effectOpacity) {
      const targets = selectedMoleculeRingTargetsForCommand(effectOpacity.ringKey);
      return {
        document: targets.reduce(
          (nextDocument, target) => applyMoleculeRingEffectOpacity(nextDocument, target, effectOpacity.effectKind, effectOpacity.opacity),
          currentDocument
        ),
        handled: true,
        targeted: targets.length > 0,
        message: targets.length === 1
          ? `Updated selected ring ${effectOpacity.effectKind} opacity`
          : `Updated ${targets.length} selected ring ${effectOpacity.effectKind} opacities`
      };
    }

    const effectSize = moleculeRingEffectSizeForCommand(commandId);
    if (effectSize) {
      const targets = selectedMoleculeRingTargetsForCommand(effectSize.ringKey);
      return {
        document: targets.reduce(
          (nextDocument, target) => applyMoleculeRingEffectSize(nextDocument, target, effectSize.effectKind, effectSize.size),
          currentDocument
        ),
        handled: true,
        targeted: targets.length > 0,
        message: targets.length === 1
          ? `Updated selected ring ${effectSize.effectKind} size`
          : `Updated ${targets.length} selected ring ${effectSize.effectKind} sizes`
      };
    }

    const moleculeObjectIds = currentMoleculeInspector.targets.moleculeObjectIds;
    const moleculeTargetCount = moleculeObjectIds.length;
    const baseStyleResult = (patch: Parameters<typeof applyMoleculeBaseStylePatch>[2], field: string) => ({
      document: applyMoleculeBaseStylePatch(currentDocument, moleculeObjectIds, patch),
      handled: true,
      targeted: moleculeTargetCount > 0,
      message: moleculeTargetCount === 1
        ? `Updated ${field} for 1 molecule`
        : `Updated ${field} for ${moleculeTargetCount} molecules`
    });
    const atomLabelTargets = currentMoleculeInspector.targets.atomLabelTargets;
    const atomLabelTargetCount = atomLabelTargets.length;
    const atomLabelStyleResult = (patch: Parameters<typeof applyMoleculeAtomLabelStylePatch>[2], field: string) => {
      if (atomLabelTargetCount > 0) {
        return {
          document: applyMoleculeAtomLabelStylePatch(currentDocument, atomLabelTargets, patch),
          handled: true,
          targeted: true,
          message: atomLabelTargetCount === 1
            ? `Updated ${field} for 1 atom label`
            : `Updated ${field} for ${atomLabelTargetCount} atom labels`
        };
      }
      return baseStyleResult(patch, field);
    };
    const atomTargets = currentMoleculeInspector.targets.atomTargets;
    const atomTargetCount = atomTargets.length;
    const atomIndicatorStyleResult = (patch: Parameters<typeof applyMoleculeAtomIndicatorStylePatch>[2], field: string) => {
      if (atomTargetCount > 0) {
        return {
          document: applyMoleculeAtomIndicatorStylePatch(currentDocument, atomTargets, patch),
          handled: true,
          targeted: true,
          message: atomTargetCount === 1
            ? `Updated ${field} for 1 atom`
            : `Updated ${field} for ${atomTargetCount} atoms`
        };
      }
      return baseStyleResult(patch, field);
    };
    const bondTargets = currentMoleculeInspector.targets.bondTargets;
    const bondTargetCount = bondTargets.length;
    const bondStyleResult = (patch: Parameters<typeof applyMoleculeBondStylePatch>[2], field: string) => {
      if (bondTargetCount > 0) {
        return {
          document: applyMoleculeBondStylePatch(currentDocument, bondTargets, patch),
          handled: true,
          targeted: true,
          message: bondTargetCount === 1
            ? `Updated ${field} for 1 bond`
            : `Updated ${field} for ${bondTargetCount} bonds`
        };
      }
      return baseStyleResult(patch, field);
    };

    const chainAngle = moleculeStructureChainAngleForCommand(commandId);
    if (chainAngle) {
      return baseStyleResult({ chainAngleDegrees: chainAngle.value }, "chain angle");
    }

    const bondLength = moleculeStructureBondLengthForCommand(commandId);
    if (bondLength) {
      if (bondTargetCount > 0) {
        return {
          document: applyMoleculeTargetBondLengthToBonds(currentDocument, bondTargets, bondLength.value),
          handled: true,
          targeted: true,
          message: bondTargetCount === 1
            ? "Updated target bond length for 1 bond"
            : `Updated target bond length for ${bondTargetCount} bonds`
        };
      }
      return {
        document: applyMoleculeTargetBondLength(currentDocument, moleculeObjectIds, bondLength.value),
        handled: true,
        targeted: moleculeTargetCount > 0,
        message: moleculeTargetCount === 1
          ? "Updated target bond length for 1 molecule"
          : `Updated target bond length for ${moleculeTargetCount} molecules`
      };
    }

    const bondStrokeWidth = moleculeStructureBondStrokeWidthForCommand(commandId);
    if (bondStrokeWidth) {
      return bondStyleResult({ bondStrokeWidthPx: bondStrokeWidth.value }, "bond stroke width");
    }

    const bondBoldWidth = moleculeStructureBondBoldWidthForCommand(commandId);
    if (bondBoldWidth) {
      return bondStyleResult({ bondBoldWidthPx: bondBoldWidth.value }, "bond bold width");
    }

    const bondColor = moleculeStructureBondColorForCommand(commandId);
    if (bondColor) {
      return bondStyleResult({ bondColor: bondColor.color }, "bond color");
    }

    const bondLineCap = moleculeStructureBondLineCapForCommand(commandId);
    if (bondLineCap) {
      return bondStyleResult({ bondLineCap: bondLineCap.value }, "bond line cap");
    }

    const bondSpacingMode = moleculeStructureBondSpacingModeForCommand(commandId);
    if (bondSpacingMode) {
      return bondStyleResult({ bondSpacingMode: bondSpacingMode.value }, "bond spacing mode");
    }

    const bondSpacingPercent = moleculeStructureBondSpacingPercentForCommand(commandId);
    if (bondSpacingPercent) {
      return bondStyleResult({ bondSpacingPercent: bondSpacingPercent.value }, "bond spacing percent");
    }

    const multipleBondGap = moleculeStructureMultipleBondGapForCommand(commandId);
    if (multipleBondGap) {
      return bondStyleResult({ multipleBondGapPx: multipleBondGap.value }, "multiple-bond gap");
    }

    const doubleBondInset = moleculeStructureDoubleBondInsetForCommand(commandId);
    if (doubleBondInset) {
      return bondStyleResult({ doubleBondInsetPx: doubleBondInset.value }, "double-bond inset");
    }

    const bondMarginWidth = moleculeStructureBondMarginWidthForCommand(commandId);
    if (bondMarginWidth) {
      return bondStyleResult({ bondMarginWidthPx: bondMarginWidth.value }, "bond margin width");
    }

    const bondHashSpacing = moleculeStructureBondHashSpacingForCommand(commandId);
    if (bondHashSpacing) {
      return bondStyleResult({ bondHashSpacingPx: bondHashSpacing.value }, "bond hash spacing");
    }

    const overlapClearance = moleculeStructureOverlapClearanceForCommand(commandId);
    if (overlapClearance) {
      return bondStyleResult({ bondOverlapClearancePx: overlapClearance.value }, "overlap clearance");
    }

    const atomQueryIndicators = moleculeStructureAtomQueryIndicatorsForCommand(commandId);
    if (atomQueryIndicators) {
      return atomIndicatorStyleResult({ atomIndicatorShowQuery: atomQueryIndicators.value }, "atom query indicators");
    }

    const atomStereochemistry = moleculeStructureAtomStereochemistryForCommand(commandId);
    if (atomStereochemistry) {
      return atomIndicatorStyleResult({ atomIndicatorShowStereochemistry: atomStereochemistry.value }, "atom stereochemistry indicators");
    }

    const atomEnhancedStereochemistry = moleculeStructureAtomEnhancedStereochemistryForCommand(commandId);
    if (atomEnhancedStereochemistry) {
      return atomIndicatorStyleResult({
        atomIndicatorShowEnhancedStereochemistry: atomEnhancedStereochemistry.value
      }, "enhanced atom stereochemistry indicators");
    }

    const atomNumbers = moleculeStructureAtomNumbersForCommand(commandId);
    if (atomNumbers) {
      return atomIndicatorStyleResult({ atomIndicatorShowAtomNumbers: atomNumbers.value }, "atom numbers");
    }

    const bondQueryIndicators = moleculeStructureBondQueryIndicatorsForCommand(commandId);
    if (bondQueryIndicators) {
      return bondStyleResult({ bondIndicatorShowQuery: bondQueryIndicators.value }, "bond query indicators");
    }

    const bondStereochemistry = moleculeStructureBondStereochemistryForCommand(commandId);
    if (bondStereochemistry) {
      return bondStyleResult({ bondIndicatorShowStereochemistry: bondStereochemistry.value }, "bond stereochemistry indicators");
    }

    const bondReactionIndicators = moleculeStructureBondReactionIndicatorsForCommand(commandId);
    if (bondReactionIndicators) {
      return bondStyleResult({ bondIndicatorShowReaction: bondReactionIndicators.value }, "bond reaction indicators");
    }

    const fontFamily = moleculeAtomLabelFontFamilyForCommand(commandId);
    if (fontFamily) {
      return atomLabelStyleResult({ atomLabelFontFamily: fontFamily.fontFamily }, "atom label font family");
    }

    const fontFace = moleculeAtomLabelFontFaceForCommand(commandId);
    if (fontFace) {
      return atomLabelStyleResult({
        atomLabelFontWeight: fontFace.weight,
        atomLabelFontStyle: fontFace.style
      }, "atom label font face");
    }

    const fontSize = moleculeAtomLabelFontSizeForCommand(commandId);
    if (fontSize) {
      return atomLabelStyleResult({ atomLabelFontSizePx: fontSize.value }, "atom label size");
    }

    const labelColor = moleculeAtomLabelColorForCommand(commandId);
    if (labelColor) {
      return atomLabelStyleResult({ atomLabelColor: labelColor.color }, "atom label color");
    }

    const labelBackground = moleculeAtomLabelBackgroundColorForCommand(commandId);
    if (labelBackground) {
      return atomLabelStyleResult({ atomLabelBackgroundColor: labelBackground.color }, "atom label background");
    }

    const labelPadding = moleculeAtomLabelPaddingForCommand(commandId);
    if (labelPadding) {
      return atomLabelStyleResult({ atomLabelPaddingPx: labelPadding.value }, "atom label padding");
    }

    const labelBondClearance = moleculeAtomLabelBondClearanceForCommand(commandId);
    if (labelBondClearance) {
      return atomLabelStyleResult({ atomLabelBondClearancePx: labelBondClearance.value }, "atom label bond clearance");
    }

    const labelAlignment = moleculeAtomLabelAlignmentForCommand(commandId);
    if (labelAlignment) {
      return atomLabelStyleResult({ atomLabelAlignment: labelAlignment.value }, "atom label alignment");
    }

    const labelPlacement = moleculeAtomLabelPlacementForCommand(commandId);
    if (labelPlacement) {
      return atomLabelStyleResult({ atomLabelPlacement: labelPlacement.value }, "atom label placement");
    }

    const showTerminalCarbons = moleculeAtomLabelShowTerminalCarbonsForCommand(commandId);
    if (showTerminalCarbons) {
      return atomLabelStyleResult({ atomLabelShowTerminalCarbons: showTerminalCarbons.value }, "terminal carbon labels");
    }

    const hideImplicitHydrogens = moleculeAtomLabelHideImplicitHydrogensForCommand(commandId);
    if (hideImplicitHydrogens) {
      return atomLabelStyleResult({ atomLabelHideImplicitHydrogens: hideImplicitHydrogens.value }, "implicit hydrogen visibility");
    }

    return { document: currentDocument, handled: false, targeted: false, message: "" };
  }, [
    currentMoleculeInspector.targets.atomTargets,
    currentMoleculeInspector.targets.atomLabelTargets,
    currentMoleculeInspector.targets.bondTargets,
    currentMoleculeInspector.targets.moleculeObjectIds,
    selectedMoleculeRingTargetsForCommand
  ]);

  const applyMoleculeInspectorCommand = useCallback((commandId: string): boolean => {
    const result = applyMoleculeInspectorCommandToDocument(documentRef.current, commandId);
    if (!result.handled) {
      return false;
    }

    if (!result.targeted) {
      setStatus("Select a molecule before changing Drawn Structure Settings style");
      return true;
    }

    const changed = commitDocumentChange(result.document);
    setActiveEditorObjectId(undefined);
    setStatus(changed ? result.message : "Selected molecule style unchanged");
    return true;
  }, [applyMoleculeInspectorCommandToDocument, commitDocumentChange]);

  const previewMoleculeInspectorCommand = useCallback((commandId: string) => {
    const session = moleculeInspectorPreviewRef.current;
    const startDocument = session?.startDocument ?? documentRef.current;
    const result = applyMoleculeInspectorCommandToDocument(startDocument, commandId);
    if (!result.handled || !result.targeted) {
      return;
    }

    moleculeInspectorPreviewRef.current = session ?? { startDocument };
    replacePresentDocument(result.document);
  }, [applyMoleculeInspectorCommandToDocument, replacePresentDocument]);

  const commitMoleculeInspectorPreview = useCallback((commandId: string) => {
    const session = moleculeInspectorPreviewRef.current;
    if (!session) {
      applyMoleculeInspectorCommand(commandId);
      return;
    }

    const result = applyMoleculeInspectorCommandToDocument(session.startDocument, commandId);
    moleculeInspectorPreviewRef.current = null;
    replacePresentDocument(session.startDocument);
    if (!result.handled || !result.targeted) {
      setStatus("Select a molecule before changing Drawn Structure Settings style");
      return;
    }

    const changed = commitDocumentChange(result.document);
    setActiveEditorObjectId(undefined);
    setStatus(changed ? result.message : "Selected molecule style unchanged");
  }, [applyMoleculeInspectorCommand, applyMoleculeInspectorCommandToDocument, commitDocumentChange, replacePresentDocument]);

  const cancelMoleculeInspectorPreview = useCallback(() => {
    const session = moleculeInspectorPreviewRef.current;
    if (!session) {
      return;
    }

    moleculeInspectorPreviewRef.current = null;
    replacePresentDocument(session.startDocument);
    setStatus("Canceled molecule inspector edit");
  }, [replacePresentDocument]);

  const applyMoleculeInspectorTemplateBytes = useCallback((
    bytes: Uint8Array,
    sourceName: string
  ) => {
    const moleculeObjectIds = currentMoleculeInspector.targets.moleculeObjectIds;
    let imported: ReturnType<typeof parseMoleculeInspectorTemplate>;
    try {
      imported = parseMoleculeInspectorTemplate(bytes, sourceName);
    } catch (error) {
      setStatus(`Template import failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (moleculeObjectIds.length === 0) {
      setStatus(`Loaded ${imported.name}; select a molecule before applying it`);
      return;
    }

    cancelMoleculeInspectorPreview();
    const { bondLengthPx, ...baseStylePatch } = moleculeInspectorTemplatePatchFromDrawingStyle(imported.drawing);
    // A template's bond length rescales the selected molecule's geometry. Clamp it to the same
    // range the Structure field enforces so a malformed / out-of-range template can't explode or
    // collapse the drawing. (The interactive edit path clamps via numberCommandValue; this one
    // fed the raw value straight into the scaler.)
    const bondLengthRange = moleculeStructureNumberRanges.bondLengthPx;
    const targetBondLengthPx = typeof bondLengthPx === "number" && Number.isFinite(bondLengthPx)
      ? Math.min(bondLengthRange.max, Math.max(bondLengthRange.min, bondLengthPx))
      : bondLengthPx;
    const startDocument = documentRef.current;
    const resizedDocument = applyMoleculeTargetBondLength(startDocument, moleculeObjectIds, targetBondLengthPx);
    const styledDocument = applyMoleculeBaseStylePatch(resizedDocument, moleculeObjectIds, baseStylePatch);
    const changed = commitDocumentChange(styledDocument);
    setActiveEditorObjectId(undefined);
    setStatus(
      changed
        ? `Imported ${imported.name} for ${moleculeObjectIds.length} molecule${moleculeObjectIds.length === 1 ? "" : "s"}${imported.warnings.length > 0 ? ` with ${imported.warnings.length} warning(s)` : ""}`
        : `Drawn Structure Settings template already matches selected molecule${moleculeObjectIds.length === 1 ? "" : "s"}`
    );
  }, [
    cancelMoleculeInspectorPreview,
    commitDocumentChange,
    currentMoleculeInspector.targets.moleculeObjectIds
  ]);

  const importMoleculeInspectorTemplate = useCallback(async () => {
    if (!isDesktopRuntime()) {
      moleculeTemplateInputRef.current?.click();
      return;
    }

    const path = await pickNativeMoleculeTemplateOpenPath();
    if (!path) {
      setStatus("Template import canceled");
      return;
    }

    try {
      const bytes = await readNativeBinaryFile(path);
      applyMoleculeInspectorTemplateBytes(bytes, nativePathBasename(path));
    } catch (error) {
      setStatus(`Template import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [applyMoleculeInspectorTemplateBytes]);

  const exportMoleculeInspectorTemplate = useCallback(async () => {
    const moleculeObjectIds = currentMoleculeInspector.targets.moleculeObjectIds;
    if (moleculeObjectIds.length === 0) {
      setStatus("Select a molecule before exporting a Molecule Inspector template");
      return;
    }

    cancelMoleculeInspectorPreview();
    const currentDocument = documentRef.current;
    const firstTarget = moleculeObjectIds
      .map((objectId) => findDocumentObject(currentDocument, objectId))
      .find((object): object is MoleculeObject => object?.type === "molecule");
    if (!firstTarget) {
      setStatus("Template export failed: selected molecule was not found");
      return;
    }

    const templateName = `${currentDocument.title.replace(/\.(chemdraft|template)$/i, "") || "Drawn Structure Settings"} Style`;
    const filename = moleculeInspectorTemplateFilename(templateName);
    const buildTemplateContents = () => {
      const drawing = {
        ...nativeDrawingStyleFromObjectStyle(firstTarget.style),
        bondLengthPx: representativeMoleculeBondLengthPx(firstTarget)
      };
      return serializeMoleculeInspectorTemplate(templateName, drawing);
    };

    if (!isDesktopRuntime()) {
      const contents = buildTemplateContents();
      downloadText(filename, contents, moleculeInspectorTemplateMimeType);
      setStatus(`Exported ${filename}`);
      return;
    }

    const defaultPath = nativePathWithBasename(fileStateRef.current.path, filename) ?? filename;
    const path = await pickNativeMoleculeTemplateSavePath(defaultPath);
    if (!path) {
      setStatus("Template export canceled");
      return;
    }

    try {
      const contents = buildTemplateContents();
      await writeNativeTextFile(path, contents);
      setStatus(`Exported ${nativePathBasename(path)}`);
    } catch (error) {
      setStatus(`Template export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [
    cancelMoleculeInspectorPreview,
    currentMoleculeInspector.targets.moleculeObjectIds
  ]);

  useEffect(() => {
    palettePreviewHandlersRef.current = {
      preview: (commandId) => {
        previewObjectStyleCommand(commandId);
        previewMoleculeInspectorCommand(commandId);
      },
      commit: (commandId) => {
        commitObjectStylePreview(commandId);
        commitMoleculeInspectorPreview(commandId);
      },
      cancel: () => {
        cancelObjectStylePreview();
        cancelMoleculeInspectorPreview();
      }
    };
  }, [
    cancelMoleculeInspectorPreview,
    cancelObjectStylePreview,
    commitMoleculeInspectorPreview,
    commitObjectStylePreview,
    previewMoleculeInspectorCommand,
    previewObjectStyleCommand
  ]);

  const restoreDocumentHistory = useCallback((direction: "undo" | "redo") => {
    if (cancelSpin3dSession("Spin cancelled")) {
      return;
    }

    const currentHistory = documentHistoryRef.current;
    const nextHistory = direction === "undo"
      ? undoDocumentHistory(currentHistory)
      : redoDocumentHistory(currentHistory);
    if (nextHistory === currentHistory) {
      setStatus(direction === "undo" ? "Nothing to undo" : "Nothing to redo");
      return;
    }

    installDocumentHistory(nextHistory);
    setFileState((current) => {
      const nextFileState = { ...current, dirty: true };
      fileStateRef.current = nextFileState;
      return nextFileState;
    });
    if (nextHistory.present.selection.objectIds.length === 0) {
      toolbarStyleTargetRef.current = undefined;
    }
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveGraphicTransformObjectId(undefined);
    setSelectedGraphicPathNode(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setLastAnalysis(null);
    setStatus(direction === "undo" ? "Undid last document change" : "Redid document change");
  }, [assignHoveredNativeDeleteTarget, cancelSpin3dSession, installDocumentHistory]);

  const clearDocumentInteractionState = useCallback((options: { clearSpin3dModelCache?: boolean } = {}) => {
    cancelSpin3dSession(undefined, { clearModelCache: options.clearSpin3dModelCache });
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveTextSelection(undefined);
    setActiveGraphicTransformObjectId(undefined);
    setSelectedGraphicPathNode(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setLastAnalysis(null);
  }, [assignHoveredNativeDeleteTarget, cancelSpin3dSession]);

  const openDocumentContents = useCallback((
    contents: string,
    displayName: string,
    path?: string,
    options?: {
      /** Restore-session path: the contents hold edits never written to `path`. */
      dirty?: boolean;
      /** Replaces the "Opened …" status line (e.g. "Restored last session — …"). */
      statusOverride?: string;
    }
  ) => {
    const opened = openNativeDocument(contents);
    const resolvedOpen = resolveOpenResultDocument(opened);
    if (!resolvedOpen) {
      throw new Error(formatOpenFailure(opened.warnings));
    }
    const fitRecommendation = resolvedOpen.source === "external-cdxml"
      ? recommendImportedPageFit(resolvedOpen.document)
      : undefined;
    const dirty = options?.dirty ?? false;
    resetDocumentHistory(resolvedOpen.document, {
      path,
      dirty,
      // Dirty contents were never saved anywhere, so they must not pose as the on-disk state.
      lastSavedPayloadHash: dirty ? undefined : sha256Utf8Hex(contents)
    });
    clearDocumentInteractionState({ clearSpin3dModelCache: true });
    setPageFitPrompt(fitRecommendation ? { ...fitRecommendation, displayName } : undefined);
    const openStatus = options?.statusOverride
      ?? formatOpenStatus(displayName, resolvedOpen.source, opened.warnings, resolvedOpen.statusSourceLabel);
    setStatus(fitRecommendation
      ? `${openStatus}; imported content exceeds ${pageFitPromptLayoutLabel(fitRecommendation.currentPageTitle, fitRecommendation.currentOrientation)}`
      : openStatus);
  }, [clearDocumentInteractionState, resetDocumentHistory]);

  const acceptPageFitRecommendation = useCallback(() => {
    if (!pageFitPrompt) {
      return;
    }

    const changed = commitDocumentChange((current) => applyImportedPageFitRecommendation(current, pageFitPrompt));
    setPageFitPrompt(undefined);
    setStatus(changed
      ? `Page changed to ${pageFitRecommendedLabel(pageFitPrompt)}`
      : "Page already fits imported content");
  }, [commitDocumentChange, pageFitPrompt]);

  const keepImportedPageOverflow = useCallback(() => {
    if (!pageFitPrompt) {
      return;
    }

    setPageFitPrompt(undefined);
    setStatus(`Kept ${pageFitPromptLayoutLabel(pageFitPrompt.currentPageTitle, pageFitPrompt.currentOrientation)}; imported content may extend beyond the page`);
  }, [pageFitPrompt]);

  const openCustomPageSizeDialog = useCallback(() => {
    const layout = documentRef.current.pages[0]?.layout;
    const unit: PageSizeUnit = layout ? pageLayoutSourceUnit(layout) : "inch";
    const width = layout?.sourceWidth ?? (layout ? cssPxToPageSize(layout.widthPx, unit) : 8.5);
    const height = layout?.sourceHeight ?? (layout ? cssPxToPageSize(layout.heightPx, unit) : 11);
    setCustomPageSizeDialog({ unit, width: formatPageSizeFieldValue(width), height: formatPageSizeFieldValue(height) });
  }, []);

  const applyCustomPageSize = useCallback((size: { width: number; height: number; unit: PageSizeUnit }) => {
    commitDocumentChange((current) => setDocumentCustomPageSize(current, size));
    setCustomPageSizeDialog(undefined);
    setStatus(`Page size: custom ${formatPageSizeFieldValue(size.width)} × ${formatPageSizeFieldValue(size.height)} ${pageSizeUnitShortLabel(size.unit)}`);
  }, [commitDocumentChange]);

  const openDocumentFromNativePicker = useCallback(async () => {
    if (!isDesktopRuntime()) {
      fileInputRef.current?.click();
      return;
    }

    const path = await pickNativeOpenPath();
    if (!path) {
      setStatus("Open canceled");
      return;
    }

    try {
      const contents = await readNativeTextFile(path);
      openDocumentContents(contents, nativePathBasename(path), path);
    } catch (error) {
      setStatus(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [openDocumentContents]);

  useEffect(() => {
    if (!shouldEnableAgentBridge()) {
      return undefined;
    }

    const openPayloadFromHash = () => {
      const payload = agentBridgeDocumentPayloadFromHash();
      if (!payload) {
        return;
      }

      try {
        openDocumentContents(payload.contents, payload.displayName, payload.path);
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      } catch (error) {
        setStatus(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    openPayloadFromHash();
    window.addEventListener("hashchange", openPayloadFromHash);
    return () => window.removeEventListener("hashchange", openPayloadFromHash);
  }, [openDocumentContents]);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return undefined;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    const openNativePayload = (payload: NativeOpenDocumentPayload) => {
      const payloadKey = `${payload.path}\n${sha256Utf8Hex(payload.contents)}`;
      const now = Date.now();
      const last = lastNativeOpenPayloadKeyRef.current;
      // A single OS open is delivered via both the Tauri event and the pending-document
      // poll, so coalesce identical payloads that arrive close together. Use a time window
      // rather than a permanent key so re-opening the same file later (e.g. to discard
      // in-app edits) still works.
      if (last && last.key === payloadKey && now - last.at < NATIVE_OPEN_DEDUPE_WINDOW_MS) {
        return;
      }
      lastNativeOpenPayloadKeyRef.current = { key: payloadKey, at: now };
      try {
        openDocumentContents(payload.contents, payload.displayName, payload.path);
      } catch (error) {
        setStatus(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    void listenForNativeOpenDocuments((payload) => {
      if (!disposed) {
        openNativePayload(payload);
      }
    })
      .then((cleanup) => {
        // The dynamic import may resolve after the effect was torn down; unsubscribe
        // immediately in that case instead of leaking the listener.
        if (disposed) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch(() => undefined);
    void takePendingNativeOpenDocument()
      .then((payload) => {
        if (!disposed && payload) {
          openNativePayload(payload);
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openDocumentContents]);

  // Restore the last edited document at startup (see documentSession.ts). Anything that landed
  // first wins: an OS "open with" or an early edit leaves the canvas non-pristine, and the restore
  // backs off. A corrupt/future envelope restores nothing — the blank document stands.
  useEffect(() => {
    if (documentSessionHydratedRef.current) {
      return undefined;
    }
    if (!isDesktopRuntime()) {
      documentSessionHydratedRef.current = true;
      return undefined;
    }

    let active = true;
    void loadDocumentSession()
      .then((raw) => {
        if (!active) {
          return;
        }
        const envelope = parseDocumentSessionEnvelope(raw);
        if (!envelope || !shouldRestoreDocumentSession(envelope)) {
          return;
        }
        const pristine = !fileStateRef.current.path
          && !fileStateRef.current.dirty
          && documentIsBlank(documentRef.current);
        if (!pristine) {
          return;
        }
        try {
          openDocumentContents(envelope.contents, envelope.displayName, envelope.path, {
            dirty: envelope.dirty,
            statusOverride: `Restored last session — ${envelope.displayName}${envelope.dirty ? " (unsaved changes)" : ""}`
          });
        } catch {
          // Never block startup on a bad autosave; the next edit overwrites it.
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) {
          documentSessionHydratedRef.current = true;
        }
      });

    return () => {
      active = false;
    };
  }, [openDocumentContents]);

  // Autosave the working document + file association (debounced) so a relaunch — or a crash —
  // resumes the last edited state with no explicit save. Gated on hydration so the startup blank
  // can't clobber the previous session before the restore above has read it.
  useEffect(() => {
    if (!isDesktopRuntime()) {
      return undefined;
    }
    const handle = window.setTimeout(() => {
      if (!documentSessionHydratedRef.current) {
        return;
      }
      try {
        const payload = createNativeSavePayload(documentRef.current);
        const path = fileStateRef.current.path;
        const envelope = buildDocumentSessionEnvelope(
          payload,
          fileStateRef.current,
          path ? nativePathBasename(path) : payload.filename,
          documentIsBlank(documentRef.current)
        );
        void saveDocumentSession(envelope).catch(() => undefined);
      } catch {
        // Serialization must never break editing; the previous autosave stays.
      }
    }, DOCUMENT_SESSION_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [document, fileState]);

  const saveCurrentDocument = useCallback(async (forceSaveAs: boolean) => {
    const payload = createNativeSavePayload(documentRef.current);

    if (!isDesktopRuntime()) {
      downloadText(payload.filename, payload.contents, payload.mimeType);
      setFileState((current) => {
        const nextFileState = {
          ...current,
          dirty: false,
          lastSavedPayloadHash: payload.payloadHash
        };
        fileStateRef.current = nextFileState;
        return nextFileState;
      });
      setStatus(formatSaveStatus(payload.filename, payload.warnings));
      return;
    }

    let path = forceSaveAs ? undefined : fileStateRef.current.path;
    if (!path) {
      path = await pickNativeSavePath(fileStateRef.current.path ?? payload.filename);
    }
    if (!path) {
      setStatus("Save canceled");
      return;
    }

    const finalPath = ensureChemDraftFileExtension(path);
    try {
      await writeNativeTextFile(finalPath, payload.contents);
      const nextFileState = {
        path: finalPath,
        dirty: false,
        lastSavedPayloadHash: payload.payloadHash
      };
      fileStateRef.current = nextFileState;
      setFileState(nextFileState);
      setStatus(formatSaveStatus(nativePathBasename(finalPath), payload.warnings));
    } catch (error) {
      setStatus(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const openExportDialog = useCallback(() => {
    setExportDialog(createDefaultExportDialogState(documentRef.current, lastExportDirectoryRef.current));
    setStatus("Export ready");
  }, []);

  const chooseExportDestination = useCallback(async () => {
    if (!exportDialog || exportDialog.busy) {
      return;
    }

    const descriptor = getExportFormatDescriptor(exportDialog.format);
    if (descriptor.status !== "implemented") {
      setStatus(`${descriptor.menuLabel} export is not available yet`);
      return;
    }

    if (!isDesktopRuntime()) {
      setStatus("Browser export will download the file");
      return;
    }

    try {
      const defaultPath = exportDialog.destinationPath ??
        nativePathJoin(lastExportDirectoryRef.current, exportDialog.filename) ??
        exportDialog.filename;
      const path = await pickNativeExportPath(
        defaultPath,
        descriptor.menuLabel,
        descriptor.extensions
      );
      if (!path) {
        setStatus("Export location unchanged");
        return;
      }

      lastExportDirectoryRef.current = nativePathDirname(path) ?? lastExportDirectoryRef.current;
      setExportDialog((current) => current
        ? {
            ...current,
            destinationPath: path,
            filename: nativePathBasename(path)
          }
        : current);
      setStatus(`Export location: ${nativePathBasename(path)}`);
    } catch (error) {
      setStatus(`Export location failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [exportDialog]);

  const submitExportDialog = useCallback(async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!exportDialog || exportDialog.busy) {
      return;
    }

    const dialog = exportDialog;
    const descriptor = getExportFormatDescriptor(dialog.format);
    setExportDialog({ ...dialog, busy: true });

    try {
      if (descriptor.status !== "implemented") {
        setStatus(`${descriptor.menuLabel} export is not available yet`);
        setExportDialog((current) => current ? { ...current, busy: false } : current);
        return;
      }

      const result = await createDialogExportResult(documentRef.current, dialog);
      const filename = ensureExportFileExtension(dialog.filename, descriptor.extensions);

      if (!isDesktopRuntime()) {
        downloadExportResult(filename, result);
        setStatus(formatExportStatus(descriptor.menuLabel, result.warnings.length));
        setExportDialog(undefined);
        return;
      }

      const defaultPath = nativePathJoin(lastExportDirectoryRef.current, filename) ?? filename;
      const path = dialog.destinationPath
        ? ensureExportFileExtension(dialog.destinationPath, descriptor.extensions)
        : await pickNativeExportPath(defaultPath, descriptor.menuLabel, descriptor.extensions);

      if (!path) {
        setStatus(`${descriptor.menuLabel} export canceled`);
        setExportDialog((current) => current ? { ...current, busy: false } : current);
        return;
      }

      await writeNativeExportResult(path, result);
      lastExportDirectoryRef.current = nativePathDirname(path) ?? lastExportDirectoryRef.current;
      setStatus(formatExportStatus(descriptor.menuLabel, result.warnings.length));
      setExportDialog(undefined);
    } catch (error) {
      setStatus(`${descriptor.menuLabel} export failed: ${error instanceof Error ? error.message : String(error)}`);
      setExportDialog((current) => current ? { ...current, busy: false } : current);
    }
  }, [exportDialog]);

  const cancelExportDialog = useCallback(() => {
    if (!exportDialog?.busy) {
      setExportDialog(undefined);
      setStatus("Export canceled");
    }
  }, [exportDialog]);

  // Plugin manager dialog (ADR-0027) + bundled-plugin diagnostics view toggles. Declared before the
  // core bindings memo because "plugins.manage" is a core binding that opens the manager.
  const [pluginDiagnosticsOpen, setPluginDiagnosticsOpen] = useState(false);
  const [pluginManagerOpen, setPluginManagerOpen] = useState(false);

  const coreCommandBindingsRef = useRef<Map<string, { spec: CommandSpec; run: () => Promise<void> }>>(
    new Map()
  );

  // Core command handlers are rebuilt every render (they close over live state), but they
  // now populate a plain Map instead of a fresh CommandRegistry. The registry instance
  // itself is created once (below) and its handlers delegate to this ref, so plugin
  // commands registered into the same registry survive re-renders (Phase 2 depends on this).
  const coreCommandBindings = useMemo(() => {
    const bindings = new Map<string, { spec: CommandSpec; run: () => Promise<void> }>();
    const register = (definition: CommandSpec, handler?: () => void | Promise<void>) => {
      bindings.set(definition.id, {
        spec: definition,
        run: async () => {
          await handler?.();
        }
      });
    };

    register(
      {
        id: PLUGIN_MANAGER_COMMAND_ID,
        title: "Add or Remove Plugins…",
        icon: "plugin",
        source: "core",
        category: "plugins",
        description: "Enable or disable bundled ChemDraft plugins"
      },
      () => setPluginManagerOpen(true)
    );

    quickActions.forEach((action) => {
      register(action, async () => {
        if (action.id === "document.new") {
          resetDocumentHistory(createPhase4Document());
          clearDocumentInteractionState({ clearSpin3dModelCache: true });
          setPageFitPrompt(undefined);
          setStatus("Blank native document");
        }
        if (action.id === "edit.undo") {
          restoreDocumentHistory("undo");
        }
        if (action.id === "edit.redo") {
          restoreDocumentHistory("redo");
        }
        if (action.id === "edit.selectAll") {
          selectAllCanvasObjects();
        }
        if (action.id === "clipboard.copy") {
          await copySelectionToClipboard("copy");
        }
        if (action.id === "clipboard.cut") {
          await copySelectionToClipboard("cut");
        }
        if (action.id === "document.open") {
          await openDocumentFromNativePicker();
        }
        if (action.id === "document.save") {
          await saveCurrentDocument(false);
        }
        if (action.id === "document.saveAs") {
          await saveCurrentDocument(true);
        }
        if (action.id === "clipboard.paste") {
          await pasteClipboard();
        }
        if (action.id === "view.zoomOut") {
          setViewport((current) => zoomViewportAtPoint(current, current.scale / VIEW_ZOOM_COMMAND_FACTOR, pageCenterPoint(current, activePage)));
        }
        if (action.id === "view.zoomIn") {
          setViewport((current) => zoomViewportAtPoint(current, current.scale * VIEW_ZOOM_COMMAND_FACTOR, pageCenterPoint(current, activePage)));
        }
        if (action.id === "view.toggleToolPalette") {
          await toggleToolset(DEFAULT_TOOLSET_ID);
          setStatus("Toggled main toolbar");
        }
        if (action.id === "export.open") {
          openExportDialog();
        }
        if (action.id === "analyze.molecularProperties") {
          // Open the window BEFORE looking at the selection, and regardless of it. Two reasons: the
          // window is up while a slow analysis runs (it shows its own empty state, then fills in),
          // and with nothing selected the command still does something visible instead of appearing
          // to do nothing at all.
          if (!visibleToolsetIdsRef.current.has(molecularInspectorToolsetId)) {
            await toggleToolset(molecularInspectorToolsetId);
          }
          const molecule = getSelectedMolecule(document);
          if (!molecule) {
            setStatus("Molecular Inspector opened — select a structure to analyse it");
            return;
          }
          await runMolecularProperties(molecule.structureFormat, molecule.structure, analysisInterpretation);
          return;
        }
        if (action.id === "chemistry.validateSelection") {
          const molecule = getSelectedMolecule(document);
          if (!molecule) {
            setStatus("No selected structure");
            return;
          }

          // The chemistry adapter is the real RDKit engine now, so the WASM loader has to be
          // registered before the first call. Dynamically imported for the same reason the SMILES
          // paste path does it: `rdkitWasmLoader` inlines the 102 KB Emscripten glue, and neither it
          // nor the 7.5 MB `.wasm` belongs in the static startup graph.
          const { registerRdkitWasmLoader } = await import("./rdkitWasmLoader");
          registerRdkitWasmLoader();

          // The real engine reads molfiles too, so the format is passed through rather than
          // collapsed to "unknown" as it was under the SMILES-only placeholder.
          const analysis = await chemistryAdapter.analyzeStructure({
            format: molecule.structureFormat,
            value: molecule.structure
          });
          setLastAnalysis(analysis);

          if (analysis.validation.valid) {
            const analyzed = applyAnalysisToSelectedMolecule(document, analysis);
            commitDocumentChange(analyzed);
            setStatus(formatAnalysisStatus(analysis));
            return;
          }

          setStatus(formatValidationFailure(analysis));
        }
      });
    });

    editActions.forEach((action) => {
      register(action, () => {
        if (action.id === "atom.addSingleBondToHoveredAtom") {
          addSingleBondToHoveredNativeAtom();
          return;
        }

        if (action.id === "bond.setHoveredBondOrder.single") {
          setHoveredNativeBondOrder("single");
          return;
        }

        if (action.id === "bond.setHoveredBondOrder.double") {
          setHoveredNativeBondOrder("double");
          return;
        }

        if (action.id === "bond.setHoveredBondOrder.triple") {
          setHoveredNativeBondOrder("triple");
          return;
        }

        if (action.id === "atom.addCarbonylToHoveredAtom") {
          addCarbonylToHoveredNativeAtom();
          return;
        }

        if (action.id === "atom.addPositiveChargeToHoveredAtom") {
          addChargeToHoveredNativeAtom(1);
          return;
        }

        if (action.id === "atom.addNegativeChargeToHoveredAtom") {
          addChargeToHoveredNativeAtom(-1);
          return;
        }

        deleteHoveredNativeTarget();
      });
    });

    layerActions.forEach((action) => {
      register(action, () => {
        if (action.id === distributeModeCommandIds.centers || action.id === distributeModeCommandIds.spacing) {
          const nextMode: DocumentDistributeMode = action.id === distributeModeCommandIds.spacing ? "spacing" : "centers";
          setDistributeMode(nextMode);
          setStatus(nextMode === "spacing" ? "Distribute mode: equal gaps" : "Distribute mode: centers");
          return;
        }

        const artBooleanOperation = artBooleanOperationByCommandId[action.id];
        if (artBooleanOperation) {
          let operationStatus = "";
          const changed = commitDocumentChange((current) => {
            const result = applyNativeArtBooleanOperationToSelection(current, artBooleanOperation);
            operationStatus = result.status;
            return result.document;
          });
          setHoveredNativeAtom(undefined);
          setSelectedNativeMoleculePart(undefined);
          setStatus(operationStatus || (changed ? action.title : "Select at least two closed art shapes"));
          return;
        }

        if (action.id === "layout.flipHorizontal" || action.id === "layout.flipVertical") {
          const axis = action.id === "layout.flipHorizontal" ? "horizontal" : "vertical";
          const changed = commitDocumentChange((current) => flipSelectedDocumentObjects(current, axis));
          setStatus(changed ? action.title : "No selected object");
          return;
        }

        const alignMode = alignModeForCommandId(action.id);
        if (alignMode) {
          const changed = commitDocumentChange((current) => alignSelectedDocumentObjects(current, alignMode));
          setStatus(changed ? action.title : "Select at least two objects");
          return;
        }

        const distributeAxis = distributeAxisForCommandId(action.id);
        if (distributeAxis) {
          const changed = commitDocumentChange((current) =>
            distributeSelectedDocumentObjects(current, distributeAxis, distributeMode)
          );
          setStatus(changed ? action.title : "Select at least three objects");
          return;
        }

        if (action.id === "layout.rotate90") {
          const changed = commitDocumentChange((current) => rotateSelectedDocumentObjects90(current));
          setStatus(changed ? action.title : "No selected object");
          return;
        }

        if (action.id === "layout.duplicate") {
          const changed = commitDocumentChange((current) => duplicateSelectedDocumentObjects(current));
          setStatus(changed ? action.title : "No selected object");
          return;
        }

        if (action.id === "layout.group") {
          const changed = commitDocumentChange((current) => groupSelectedDocumentObjects(current));
          setStatus(changed ? "Grouped selection" : "Select at least two objects");
          return;
        }

        if (action.id === "layout.ungroup") {
          const changed = commitDocumentChange((current) => ungroupSelectedDocumentObjects(current));
          setStatus(changed ? "Ungrouped selection" : "Select a group");
          return;
        }

        let result: LayerCommandSelectionResult | undefined;
        const changed = commitDocumentChange((current) => {
          result = applyLayerCommandToDocumentSelection(current, action.id, { selectedNativeMoleculePart });
          return result.document;
        });
        if (result?.bondDepthCommandId) {
          setStatus(changed
            ? bondDepthStatusForCommand(result.bondDepthCommandId)
            : result.bondDepthContext ? "Bond depth unchanged" : "No crossing bond under selected molecule part");
          return;
        }
        setStatus(changed ? action.title : "No selected object");
      });
    });

    atomElementActions.forEach((action) => {
      register(action, () => {
        const element = action.id.replace("atom.setHoveredElement.", "");
        const parsed = nativeElementFromKeyboardKey(element);
        if (parsed) {
          setHoveredNativeAtomElement(parsed);
        }
      });
    });

    const objectStyleCommandIds = new Set(objectStyleActions.map((action) => action.id));

    toolCommandSpecs.forEach((tool) => {
      if (
        isLayerCommandId(tool.id) ||
        objectStyleCommandIds.has(tool.id) ||
        tool.id === toggleRingInspectorCommandId ||
        tool.id === toggleDrawnStructureSettingsCommandId ||
        // Plugin commands are owned by PluginHost, which registers them into the same
        // registry with their permission context. Registering a core binding here too
        // would collide (duplicate id) and strip the plugin's permission checks.
        tool.source === "plugin"
      ) {
        return;
      }

      register(tool, () => {
        if (isDisabledPlaceholderCommand(tool)) {
          setStatus(tool.disabledReason ?? "Tool unavailable");
          return;
        }

        if (tool.id === structureCleanupCommandId) {
          cleanUpSelectedStructure();
          return;
        }

        if (tool.id === structureSpin3dCommandId) {
          void startSpin3d();
          return;
        }

        if (tool.id === structureInteractive3dCommandId) {
          void openInteractive3dWorkspace();
          return;
        }

        if (tool.id === structureCleanup3dCommandId) {
          cleanUpSelectedStructure3d();
          return;
        }

        if (applyTextStyleCommand(tool.id)) {
          return;
        }

        // Object Settings and Color Controls open the surface that owns the current selection's
        // edits. Routing by type matters: the Art inspector styles only graphics and molecules, so
        // sending a text or bracket selection there produced a panel with everything disabled.
        if (tool.id === "tool.settings" || tool.id === "style.color") {
          const types = selectedDocumentObjectTypes(documentRef.current);
          if (types.size === 0) {
            void toggleToolset(tool.id === "tool.settings" ? drawnStructureSettingsToolsetId : artToolsetId);
            return;
          }
          if (tool.id === "tool.settings" && types.has("molecule")) {
            void toggleToolset(drawnStructureSettingsToolsetId);
            return;
          }
          if (types.has("graphic") || types.has("molecule")) {
            void toggleToolset(artToolsetId);
            return;
          }
          if (types.has("text")) {
            void toggleToolset(textToolsetId);
            return;
          }
          setStatus(`${tool.title} does not cover the selected object yet`);
          return;
        }

        // One-shot formatting: rewrite the selected text objects' spans as chemical formulas.
        if (tool.id === "style.formulaText") {
          const nextDocument = applyFormulaTextFormatting(documentRef.current);
          if (nextDocument !== documentRef.current) {
            commitDocumentChange(nextDocument);
            setStatus("Formatted selected text as formula");
          } else {
            setStatus("Select a text object to format as formula");
          }
          return;
        }

        if (!isDrawingToolCommand(tool.id)) {
          setStatus(`${tool.title} command routed`);
          return;
        }

        if (tool.id === "tool.art.eyedropper" && activeToolState.activeCommandId === "tool.art.eyedropper") {
          restoreToolAfterEyedropper();
          return;
        }

        if (tool.id === "tool.art.eyedropper") {
          toolBeforeEyedropperRef.current = activeToolState;
        } else {
          toolBeforeEyedropperRef.current = undefined;
        }

        if (tool.id === "tool.text") {
          toolBeforeTextPlacementRef.current =
            activeToolState.activeCommandId === "tool.text" ? undefined : activeToolState;
        } else {
          toolBeforeTextPlacementRef.current = undefined;
        }

        const result = activateDrawingToolCommand(activeToolState, tool);
        setActiveToolState(result.state);
        if (result.outcome === "activated") {
          setActiveTextEditObjectId(undefined);
          setActiveAtomLabelEdit(undefined);
          if (tool.id === "tool.art.eyedropper" && currentArtStyle) {
            flashArtPaintTargetControls();
          }
          if (tool.id === "tool.art.directEdit") {
            pendingObjectTransformPreviewRef.current = undefined;
            setObjectTransformPreview(undefined);
            setActiveGraphicTransformObjectId(undefined);
            setSelectedNativeMoleculePart(undefined);
          }
        }
        setStatus(tool.id === "tool.art.eyedropper" ? currentEyedropperStatus : result.status);
      });
    });

    textToolbarActions.forEach((action) => {
      register(action, () => {
        if (!applyTextStyleCommand(action.id)) {
          setStatus(`${action.title} unavailable`);
        }
      });
    });

    objectStyleActions.forEach((action) => {
      register(action, () => {
        if (!applyObjectStyleCommand(action.id)) {
          setStatus(`${action.title} unavailable`);
        }
      });
    });

    getToolsetToggleActions(toolsetRegistry).forEach((action) => {
      register(action, async () => {
        const toolsetId = parseToolsetToggleCommandId(action.id);
        if (!toolsetId) {
          return;
        }

        await toggleToolset(toolsetId);
      });
    });

    viewActions.forEach((action) => {
      register(action, () => {
        if (action.id === PREFERENCES_COMMAND_ID) {
          if (!isDesktopRuntime()) {
            setStatus(openBrowserUtilityWindow(PREFERENCES_WINDOW_KIND)
              ? "Preferences opened in browser"
              : "Preferences pop-up blocked");
            return;
          }
          void togglePreferencesWindow().catch(() => {
            setStatus("Preferences unavailable");
          });
          return;
        }

        if (action.id === SPIN3D_DEBUGGER_COMMAND_ID) {
          if (!isDesktopRuntime()) {
            setStatus(openBrowserUtilityWindow(SPIN3D_DEBUGGER_WINDOW_KIND)
              ? "3D debugger opened in browser"
              : "3D debugger pop-up blocked");
            return;
          }
          void toggleSpin3dDebuggerWindow().catch(() => {
            setStatus("3D debugger unavailable");
          });
          return;
        }

        if (action.id === toggleRingInspectorCommandId) {
          void toggleToolset(ringInspectorToolsetId);
          return;
        }

        if (action.id === toggleDrawnStructureSettingsCommandId) {
          void toggleToolset(drawnStructureSettingsToolsetId);
          return;
        }

        if (action.id === "view.toggleRulers") {
          setRulersVisible((visible) => !visible);
          return;
        }

        if (action.id === "view.toggleCrosshairs") {
          setCrosshairsVisible((visible) => !visible);
        }
      });
    });

    pageSizeActions.forEach((action) => {
      register(action, () => {
        const presetId = action.id.replace("page.setSize.", "");
        commitDocumentChange((current) => setDocumentPageSize(current, presetId as Parameters<typeof setDocumentPageSize>[1]));
        setStatus(action.title.replace("Set Page Size: ", "Page size: "));
      });
    });

    pageOrientationActions.forEach((action) => {
      register(action, () => {
        const orientation = action.id.endsWith(".landscape") ? "landscape" : "portrait";
        commitDocumentChange((current) => setDocumentPageOrientation(current, orientation));
        setStatus(action.title.replace("Set Page Orientation: ", "Page orientation: "));
      });
    });

    register(pageCustomSizeAction, () => {
      openCustomPageSizeDialog();
    });

    toolbarCustomizationActions.forEach((action) => {
      register(action, () => {
        setStatus(action.disabledReason ?? "Toolbar customization UI is not implemented yet");
      });
    });

    return bindings;
  }, [
    activeToolState,
    addChargeToHoveredNativeAtom,
    addCarbonylToHoveredNativeAtom,
    addSingleBondToHoveredNativeAtom,
    applyObjectStyleCommand,
    applyMoleculeInspectorCommand,
    applyTextStyleCommand,
    assignHoveredNativeDeleteTarget,
    chemistryAdapter,
    clearDocumentInteractionState,
    cleanUpSelectedStructure3d,
    cleanUpSelectedStructure,
    startSpin3d,
    commitDocumentChange,
    copySelectionToClipboard,
    currentArtStyle,
    currentEyedropperStatus,
    deleteHoveredNativeTarget,
    distributeMode,
    document,
    flashArtPaintTargetControls,
    layerActions,
    nativePalette,
    openExportDialog,
    openInteractive3dWorkspace,
    openDocumentFromNativePicker,
    openCustomPageSizeDialog,
    pasteClipboard,
    quickActions,
    resetDocumentHistory,
    restoreDocumentHistory,
    restoreToolAfterEyedropper,
    saveCurrentDocument,
    selectAllCanvasObjects,
    selectedNativeMoleculePart,
    setHoveredNativeAtomElement,
    setHoveredNativeBondOrder,
    toggleToolset,
    toolCommandSpecs,
    toolsetRegistry
  ]);

  coreCommandBindingsRef.current = coreCommandBindings;

  // The registry and its core-command registrar are created exactly once. Handlers delegate
  // to the live bindings ref, so plugin commands registered into the same stable instance in
  // Phase 2 are never wiped when core bindings change. See createCoreCommandRegistrar.
  const { registry, syncCoreCommands } = useMemo(() => {
    const commandRegistry = new CommandRegistry();
    return {
      registry: commandRegistry,
      syncCoreCommands: createCoreCommandRegistrar(commandRegistry, () => coreCommandBindingsRef.current)
    };
  }, []);

  useEffect(() => {
    syncCoreCommands(coreCommandBindings);
  }, [syncCoreCommands, coreCommandBindings]);

  const [patchQueueVersion, setPatchQueueVersion] = useState(0);
  const pluginPanelReportsRef = useRef(new Map<string, PluginPanelReportPayload>());
  const pluginPanelRevisionRef = useRef(0);
  const pluginPanelStalenessSentRef = useRef(new Map<string, { revision: number; stale: boolean }>());
  // Serialize repeated analyzer requests per owning plugin. Reports do not expose an invocation id,
  // so overlapping runs cannot otherwise prove which late result is older. A monotonic generation
  // suppresses obsolete status updates while the queue guarantees the newest requested run settles
  // last; ordinary commands remain serialized only with repeats of that same command.
  const pluginCommandQueuesRef = useRef(new Map<string, Promise<void>>());
  const pluginCommandGenerationsRef = useRef(new Map<string, number>());

  // The persistent plugin runtime (host + panel controller + toolset stage), created exactly once on
  // main's stable registry: plugin commands register into the SAME CommandRegistry core commands use,
  // storage is disk-backed, and the proposed-patch queue feeds the review tray. Document/selection
  // reach the host through refs, so it is never rebuilt when they change (see usePluginRuntime).
  const pluginRuntime = usePluginRuntime({
    getActiveDocument: () => documentRef.current,
    getSelection: () => buildPluginSelectionSnapshot(documentRef.current),
    commandRegistry: registry,
    createStorage: createPersistentPluginStorage,
    onProposedPatchesChanged: () => setPatchQueueVersion((version) => version + 1)
  });
  const { isPluginCommand: pluginCommandExists, invokePluginCommand } = pluginRuntime;

  // Mirror the plugin runtime's Analyze menu items into the native macOS menu so they are invokable
  // from the OS menu bar, not only the in-window (web) bar (ADR-0016). No-op on the web build.
  useEffect(() => {
    void syncPluginNativeMenuItems(pluginRuntime.pluginMenuItems);
  }, [pluginRuntime.pluginMenuItems]);

  // Staleness (D-09): an open panel's report carries the source fingerprint it was computed against;
  // if the live molecule no longer matches (edited or removed), flag the panel as out of date.
  const pluginPanelSource = pluginRuntime.openPanel?.report.source;
  const pluginPanelStale = pluginPanelSource
    ? computeObjectFingerprint(document, pluginPanelSource.objectId) !== pluginPanelSource.sourceFingerprint
    : false;

  // Keep the catalog's plugin toolsets in sync with the runtime, and register the dev-only
  // fixture plugin so the whole contribute-a-toolset pipeline is exercised in development.
  useEffect(() => {
    const runtime = pluginRuntime.runtime;
    const syncPluginToolsets = () => toolbarCatalog.setPluginToolsets(runtime.listPluginToolsets());
    const unsubscribe = runtime.onDidChange(syncPluginToolsets);
    if (import.meta.env.DEV) {
      try {
        runtime.registerPlugin(fixturePluginManifest, createFixturePluginOptions());
      } catch (error) {
        console.warn("Fixture plugin registration failed", error);
      }
    }
    syncPluginToolsets();
    return () => {
      unsubscribe();
      if (import.meta.env.DEV) {
        try {
          runtime.unregisterPlugin(FIXTURE_PLUGIN_ID);
        } catch {
          // Already unregistered; nothing to clean up.
        }
      }
    };
  }, [pluginRuntime.runtime, toolbarCatalog]);

  // Panel windows request their content on mount; the main window re-serves the latest
  // report so a reopened or slow-loading panel is never blank.
  useEffect(() => {
    const unlisten = listenForPluginPanelRequests((identity) => {
      const key = pluginPanelIdentityKey(identity.pluginId, identity.panelId);
      const payload = pluginPanelReportsRef.current.get(key);
      if (payload) {
        void broadcastPluginPanelReport(payload).catch(() => undefined);
        const staleness = pluginPanelStalenessSentRef.current.get(key);
        if (staleness?.revision === payload.revision) {
          void broadcastPluginPanelStaleness({
            ...identity,
            stale: staleness.stale,
            revision: staleness.revision
          }).catch(() => undefined);
        }
      }
    });
    return unlisten;
  }, []);

  // "Open as window" (ADR-0030): move the in-app panel into a floating native window. The controller
  // detaches it WITHOUT a close notification — the panel is still open, just on another surface — and
  // the report is served over the panel bridge, so the window holds no plugin code.
  const popOutOpenPanel = useCallback(() => {
    const panel = pluginRuntime.runtime.panels.getOpenPanel();
    if (!panel) {
      return;
    }
    pluginRuntime.runtime.panels.detachPanel(panel.pluginId, panel.panelId);
    const payload: PluginPanelReportPayload = {
      pluginId: panel.pluginId,
      panelId: panel.panelId,
      report: panel.report,
      commandId: panel.commandId,
      revision: ++pluginPanelRevisionRef.current
    };
    const key = pluginPanelIdentityKey(panel.pluginId, panel.panelId);
    pluginPanelReportsRef.current.set(key, payload);
    void openPluginPanelWindow({
      pluginId: panel.pluginId,
      panelId: panel.panelId,
      title: panel.report.title || panel.title
    })
      .catch(() => undefined);
    void broadcastPluginPanelReport(payload).catch(() => undefined);
  }, [pluginRuntime.runtime]);

  // Detached panel windows: mirror report updates (a plugin may push pending -> result for a detached
  // panel) and staleness (D-09 recomputed against the live document) over the bridge.
  useEffect(() => {
    for (const panel of pluginRuntime.detachedPanels) {
      const key = pluginPanelIdentityKey(panel.pluginId, panel.panelId);
      let payload = pluginPanelReportsRef.current.get(key);
      if (!payload || payload.report !== panel.report) {
        payload = {
          pluginId: panel.pluginId,
          panelId: panel.panelId,
          report: panel.report,
          commandId: panel.commandId,
          revision: ++pluginPanelRevisionRef.current
        };
        pluginPanelReportsRef.current.set(key, payload);
        void broadcastPluginPanelReport(payload).catch(() => undefined);
      }
      const source = panel.report.source;
      const stale = source
        ? computeObjectFingerprint(document, source.objectId) !== source.sourceFingerprint
        : false;
      const sent = pluginPanelStalenessSentRef.current.get(key);
      if (!sent || sent.revision !== payload.revision || sent.stale !== stale) {
        pluginPanelStalenessSentRef.current.set(key, { revision: payload.revision, stale });
        void broadcastPluginPanelStaleness({
          pluginId: panel.pluginId,
          panelId: panel.panelId,
          stale,
          revision: payload.revision
        })
          .catch(() => undefined);
      }
    }
  }, [document, pluginRuntime.detachedPanels]);

  // A dismissed window is a real panel close (ADR-0012): the plugin gets its cancellation signal.
  // The stored report stays cached so a reopened window is re-served instantly.
  useEffect(() => {
    const runtime = pluginRuntime.runtime;
    return listenForPluginPanelCloses(({ pluginId, panelId }) => {
      runtime.panels.closeDetachedPanel(pluginId, panelId);
    });
  }, [pluginRuntime.runtime]);

  // Run again from a detached window executes in THIS window (the plugin runtime lives here). The
  // command id is resolved from the live detached entry, not trusted from the message.
  useEffect(() => {
    const runtime = pluginRuntime.runtime;
    return listenForPluginPanelReruns(({ pluginId, panelId }) => {
      const panel = runtime.panels
        .getDetachedPanels()
        .find((candidate) => candidate.pluginId === pluginId && candidate.panelId === panelId);
      if (panel?.commandId) {
        void invokeCommandRef.current?.(panel.commandId);
      }
    });
  }, [pluginRuntime.runtime]);

  // When a detached panel leaves the set some other way than its own close button (plugin disabled,
  // uninstalled, or closed programmatically), hide its native window too.
  const previouslyDetachedPanelsRef = useRef(new Map<string, PluginPanelIdentity>());
  useEffect(() => {
    const current = new Map(
      pluginRuntime.detachedPanels.map((panel) => [
        pluginPanelIdentityKey(panel.pluginId, panel.panelId),
        { pluginId: panel.pluginId, panelId: panel.panelId }
      ])
    );
    for (const [key, identity] of previouslyDetachedPanelsRef.current) {
      if (!current.has(key)) {
        void hidePluginPanelWindow(identity.pluginId, identity.panelId).catch(() => undefined);
        pluginPanelStalenessSentRef.current.delete(key);
      }
    }
    previouslyDetachedPanelsRef.current = current;
  }, [pluginRuntime.detachedPanels]);

  const acceptPluginProposal = useCallback(
    (proposal: QueuedProposedPatch) => {
      try {
        const updated = pluginRuntime.runtime.host.acceptProposedPatch(proposal.id, documentRef.current);
        commitDocumentChange(updated);
        setStatus("Applied plugin proposal");
      } catch (error) {
        setStatus(`Plugin proposal failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [commitDocumentChange, pluginRuntime.runtime]
  );

  const rejectPluginProposal = useCallback(
    (proposal: QueuedProposedPatch) => {
      try {
        pluginRuntime.runtime.host.rejectProposedPatch(proposal.id);
        setStatus("Rejected plugin proposal");
      } catch {
        setStatus("Plugin proposal was already resolved");
      }
    },
    [pluginRuntime.runtime]
  );

  const invoke = useCallback(async (commandId: string) => {
    if (commandId === "view.customizeToolbars") {
      setCustomizeToolbarsOpen(true);
      return;
    }

    if (commandId === "view.customizeMainToolbar") {
      setCustomizeMode(!customizeMainToolbarActiveRef.current);
      return;
    }

    if (commandId === drawnStructureSettingsTemplateImportCommandId) {
      await importMoleculeInspectorTemplate();
      return;
    }

    if (commandId === drawnStructureSettingsTemplateExportCommandId) {
      await exportMoleculeInspectorTemplate();
      return;
    }

    if (applyTextStyleCommand(commandId)) {
      return;
    }

    if (applyObjectStyleCommand(commandId)) {
      return;
    }

    if (applyMoleculeInspectorCommand(commandId)) {
      return;
    }

    if (commandId === PLUGIN_DIAGNOSTICS_COMMAND_ID) {
      setPluginDiagnosticsOpen((open) => !open);
      return;
    }

    // Route through the host so plugin commands run with their permission context; core commands
    // (no pluginId on the definition) dispatch straight through the shared registry as before.
    // For plugin-owned commands, ADR-0010 applies: a command may fail by throwing OR by resolving
    // { ok: false } — surface both on the status line, attributed to the plugin.
    if (pluginCommandExists(commandId)) {
      const owner = pluginRuntime.plugins.find((manifest) =>
        manifest.contributes.commands.some((command) => command.id === commandId)
      );
      const analyzerOwned = owner?.contributes.analyzers.some((analyzer) => analyzer.commandId === commandId) ?? false;
      const queueKey = analyzerOwned && owner ? `analyzer:${owner.id}` : `command:${commandId}`;
      const generation = (pluginCommandGenerationsRef.current.get(queueKey) ?? 0) + 1;
      pluginCommandGenerationsRef.current.set(queueKey, generation);
      const previous = pluginCommandQueuesRef.current.get(queueKey) ?? Promise.resolve();
      const run = previous
        .catch(() => undefined)
        .then(async () => {
          const result = await invokePluginCommand(commandId);
          if (pluginCommandGenerationsRef.current.get(queueKey) !== generation) {
            return;
          }
          const failure = pluginCommandFailure(result);
          if (failure) {
            setStatus(`Plugin command failed: ${failure}`);
          }
        })
        .catch((error: unknown) => {
          if (pluginCommandGenerationsRef.current.get(queueKey) !== generation) {
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          setStatus(`Plugin command failed: ${message}`);
        });
      let tracked: Promise<void>;
      tracked = run.finally(() => {
        if (pluginCommandQueuesRef.current.get(queueKey) === tracked) {
          pluginCommandQueuesRef.current.delete(queueKey);
          pluginCommandGenerationsRef.current.delete(queueKey);
        }
      });
      pluginCommandQueuesRef.current.set(queueKey, tracked);
      void tracked;
      return;
    }

    void invokePluginCommand(commandId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Command failed: ${message}`);
    });
  }, [
    applyMoleculeInspectorCommand,
    applyObjectStyleCommand,
    applyTextStyleCommand,
    exportMoleculeInspectorTemplate,
    importMoleculeInspectorTemplate,
    invokePluginCommand,
    pluginCommandExists,
    pluginRuntime.plugins
  ]);

  invokeCommandRef.current = invoke;

  // Apply the Customize Toolbars dialog's edited layout: feed it to the catalog (which rebuilds the
  // registry + fires onDidChange -> setToolsetRegistry), re-derive visibility, and persist. Mirrors
  // the startup load path so the palettes + menu refresh live.
  // Commit a toolbar layout state: rebuild the registry, reconcile which palettes are open, and
  // persist. `closeDialog` distinguishes the Customize dialog's live edits (each visibility toggle
  // applies immediately — no draft that can drift out of sync) from a final close.
  const commitToolbarLayout = useCallback((next: ToolsetLayoutState, closeDialog: boolean) => {
    toolbarCatalog.setLayoutState(next);
    const nextRegistry = toolbarCatalog.registry();
    const nextVisible = createDefaultVisibleToolsetIds(nextRegistry);
    // The native reconciler only OPENS desired windows; it never closes. So a toolset hidden in the
    // Customize dialog must be closed explicitly here (mirrors toggleToolset), or its floating window
    // lingers. Web palettes just re-render from visibleToolsetIds, so no close is needed.
    if (effectiveNativePalette) {
      const stillVisible = new Set(nextVisible);
      for (const toolsetId of visibleToolsetIdsRef.current) {
        if (!stillVisible.has(toolsetId)) {
          void closeToolsetWindow(toolsetId).catch(() => undefined);
        }
      }
    }
    setVisibleToolsetIds(nextVisible);
    try {
      layoutStateRef.current = parseToolsetLayoutState(next);
    } catch {
      layoutStateRef.current = undefined;
    }
    resolvedToolsetIdsRef.current = new Set(nextRegistry.listToolsets().map((toolset) => toolset.id));
    layoutSaveEnabledRef.current = true;
    // Push the new state into the open palette webviews NOW (they built their toolbar once, at
    // window creation — without this, item hides/reorders/renames never reach them), and again once
    // the save has flushed so a palette window created mid-save can't be left on the stale disk copy.
    void broadcastToolsetLayoutState(next).catch(() => undefined);
    layoutSaveChainRef.current = layoutSaveChainRef.current
      .then(() => saveToolsetLayoutState(next))
      .then(() => broadcastToolsetLayoutState(next))
      .catch(() => undefined);
    if (closeDialog) {
      setCustomizeToolbarsOpen(false);
    }
  }, [toolbarCatalog, effectiveNativePalette]);

  // Live edits from the Customize dialog (visibility toggles, hides, reorders) apply immediately so
  // palettes appear/disappear as you click — no Apply-then-reopen round trip, and no long-lived draft
  // that can revert a hidden toolset back to visible.
  const liveApplyCustomizeToolbars = useCallback(
    (next: ToolsetLayoutState) => commitToolbarLayout(next, false),
    [commitToolbarLayout]
  );
  const applyCustomizeToolbars = useCallback(
    (next: ToolsetLayoutState) => commitToolbarLayout(next, true),
    [commitToolbarLayout]
  );

  // Command catalog (id + title, deduped) offered by the Customize dialog's "add command" palette.
  // It follows the effective registry so user/plugin/renamed toolbar launchers appear immediately.
  const customizeCommandOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const command of shellCommandSpecs) {
      if (!byId.has(command.id)) {
        byId.set(command.id, command.title ?? command.id);
      }
    }
    return [...byId].map(([id, title]) => ({ id, title }));
  }, [shellCommandSpecs]);

  // Full live specs (including current enabled state) for the in-place customize gallery — minus
  // transitional stubs, which must never be draggable onto a real toolbar. The declared stub set is
  // used rather than live enabled state, so transiently disabled commands (Undo, align, boolean
  // ops) stay offered.
  const galleryCommands = useMemo(() => {
    // Deliberately the *shipped* manifest, not `toolsetRegistry`. The latter is the user's own
    // customized layout, so keying off it made the gallery eat its own tail: remove a tool from a
    // toolbar and it vanishes from the list you would put it back with, permanently. What the build
    // ships is a fixed fact; what the user has arranged is not.
    const shipped = new Set(getToolsetCommandSpecs(desktopToolsetRegistry).map((command) => command.id));
    return shellCommandSpecs.filter((command) =>
      !TRANSITIONAL_STUB_COMMAND_IDS.has(command.id) &&
      !isCompatOnlyArtVariantCommandId(command.id, shipped)
    );
  }, [shellCommandSpecs]);

  // Command id → title, for the customize-edit applier (an addCommand for a title-less/unknown id is
  // a no-op).
  const commandTitleById = useMemo(
    () => new Map(customizeCommandOptions.map((option) => [option.id, option.title])),
    [customizeCommandOptions]
  );

  // Command id → spec, so an added command's synthesized item carries the command's real icon/asset.
  const commandById = shellCommandsById;
  const commandTitleByIdRef = useRef(commandTitleById);
  const commandByIdRef = useRef(commandById);
  commandTitleByIdRef.current = commandTitleById;
  commandByIdRef.current = commandById;

  useEffect(() => {
    if (!activeTextEditObjectId) {
      activeTextSelectionRef.current = undefined;
      setActiveTextSelection(undefined);
      return;
    }

    focusTextObjectEditor(activeTextEditObjectId);
  }, [activeTextEditObjectId, document, focusTextObjectEditor]);

  useEffect(() => {
    const objectIds = [...document.selection.objectIds];
    const textRange = activeTextSelectionRef.current;
    if (objectIds.length === 0 && !selectedNativeMoleculePart && !textRange) {
      return;
    }

    toolbarStyleTargetRef.current = {
      objectIds,
      moleculePart: nativeSelectionColorTarget(selectedNativeMoleculePart),
      textRange
    };
  }, [activeTextSelection, document.selection.objectIds, selectedNativeMoleculePart]);

  useEffect(() => {
    if (!rotationInput) {
      return;
    }

    const stillSelected =
      document.selection.objectIds.includes(rotationInput.objectId) ||
      selectedNativeMoleculePart?.objectId === rotationInput.objectId;
    if (!stillSelected) {
      updateRotationInput(undefined);
    }
  }, [document.selection.objectIds, rotationInput, selectedNativeMoleculePart, updateRotationInput]);

  useEffect(() => {
    if (!objectResizeInput) {
      return;
    }

    const stillSelected =
      document.selection.objectIds.includes(objectResizeInput.objectId) ||
      selectedNativeMoleculePart?.objectId === objectResizeInput.objectId;
    if (!stillSelected) {
      updateObjectResizeInput(undefined);
    }
  }, [document.selection.objectIds, objectResizeInput, selectedNativeMoleculePart, updateObjectResizeInput]);

  useEffect(() => {
    const writeSelectionClipboardEvent = (
      event: ClipboardEvent,
      mode: "copy" | "cut"
    ): boolean => {
      if (event.defaultPrevented || shouldIgnoreShortcutTarget(event.target) || !event.clipboardData) {
        return false;
      }

      const payload = createSelectionClipboardPayload(documentRef.current);
      if (!payload) {
        return false;
      }

      const didWrite = writeClipboardDataTransfer(event.clipboardData, selectionClipboardTextItems(payload));
      if (!didWrite) {
        setStatus(mode === "copy" ? "Copy failed: clipboard unavailable" : "Cut canceled: clipboard unavailable");
        return false;
      }

      event.preventDefault();
      selectionClipboardPayloadRef.current = payload;
      selectionClipboardPasteStateRef.current = initialSelectionClipboardPasteState(payload, mode);
      if (mode === "cut") {
        deleteSelectionAfterClipboardCut();
        setStatus("Cut ChemDraft selection");
        return true;
      }

      setStatus("Copied ChemDraft selection");
      return true;
    };

    const handleCopy = (event: ClipboardEvent) => {
      writeSelectionClipboardEvent(event, "copy");
    };

    const handleCut = (event: ClipboardEvent) => {
      writeSelectionClipboardEvent(event, "cut");
    };

    const handlePaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || shouldIgnoreShortcutTarget(event.target)) {
        return;
      }

      if (!event.clipboardData) {
        // Some desktop WebView paste events arrive without populated clipboardData; read natively
        // so keyboard paste of CDXML/SMILES/ChemDraft payloads still works.
        if (isDesktopRuntime()) {
          event.preventDefault();
          void pasteClipboard();
        }
        return;
      }

      const selectionPayload =
        parseSelectionClipboardPayload(event.clipboardData.getData(CHEMDRAFT_SELECTION_CLIPBOARD_TYPE)) ??
        parseSelectionClipboardPayload(event.clipboardData.getData("text/plain"));
      if (selectionPayload) {
        event.preventDefault();
        applySelectionClipboardPayload(selectionPayload);
        return;
      }

      const detectedPayload = inspectClipboardPayload(clipboardPayloadFromDataTransfer(event.clipboardData));
      if (detectedPayload.kind !== "empty") {
        event.preventDefault();
        applyDetectedClipboardPayload(detectedPayload);
        return;
      }

      // The clipboard event carried nothing usable. On desktop, read the native clipboard (the
      // private ChemDraft flavor survives there); otherwise reuse the last in-app selection so an
      // in-session copy still pastes, without overriding real external clipboard content above.
      if (isDesktopRuntime()) {
        event.preventDefault();
        void pasteClipboard();
        return;
      }
      if (selectionClipboardPayloadRef.current) {
        event.preventDefault();
        applySelectionClipboardPayload(selectionClipboardPayloadRef.current);
      }
    };

    window.addEventListener("copy", handleCopy);
    window.addEventListener("cut", handleCut);
    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("copy", handleCopy);
      window.removeEventListener("cut", handleCut);
      window.removeEventListener("paste", handlePaste);
    };
  }, [applyDetectedClipboardPayload, applySelectionClipboardPayload, deleteSelectionAfterClipboardCut, pasteClipboard]);

  const clearFreehandArtPreview = useCallback(() => {
    if (freehandArtPreviewFrameRef.current !== undefined) {
      window.cancelAnimationFrame(freehandArtPreviewFrameRef.current);
      freehandArtPreviewFrameRef.current = undefined;
    }
    resetFreehandArtPreviewPath(freehandArtPreviewPathRef.current);
  }, []);

  const renderFreehandArtPreview = useCallback((drag: FreehandArtDragState) => {
    const path = freehandArtPreviewPathRef.current;
    if (!path || !drag.dragging || drag.points.length === 0) {
      resetFreehandArtPreviewPath(path);
      return;
    }

    const tool = nativeArtToolForCommand(drag.commandId);
    const size = tool?.data.freehandOptions?.size ?? 5;
    path.setAttribute("d", freehandArtPreviewPathD(drag.points));
    path.setAttribute("stroke", tool?.style.strokeColor ?? "#111111");
    path.setAttribute("stroke-width", `${Math.max(1, size)}`);
    path.setAttribute("data-active", "true");
  }, []);

  const scheduleFreehandArtPreview = useCallback((drag: FreehandArtDragState) => {
    if (freehandArtPreviewFrameRef.current !== undefined) {
      return;
    }

    freehandArtPreviewFrameRef.current = window.requestAnimationFrame(() => {
      freehandArtPreviewFrameRef.current = undefined;
      renderFreehandArtPreview(drag);
    });
  }, [renderFreehandArtPreview]);

  const clearNativeFreehandArtDrag = useCallback((event?: { pointerId: number; currentTarget?: Element }) => {
    const drag = freehandArtDragRef.current;
    if (!drag || (event && drag.pointerId !== event.pointerId)) {
      return;
    }

    freehandArtDragRef.current = null;
    clearFreehandArtPreview();
    const page = pageRef.current;
    if (page?.hasPointerCapture(drag.pointerId)) {
      page.releasePointerCapture(drag.pointerId);
    }
    const currentTarget = event?.currentTarget;
    if (currentTarget?.hasPointerCapture(drag.pointerId)) {
      currentTarget.releasePointerCapture(drag.pointerId);
    }
  }, [clearFreehandArtPreview]);

  const syncPathArtPreview = useCallback((draw: PathArtDrawState | null) => {
    setPathArtPreview(draw
      ? {
          pathKind: draw.pathKind,
          nodes: draw.nodes.map((node) => ({ ...node })),
          latestPoint: draw.latestPoint,
          closed: draw.closed
        }
      : undefined
    );
  }, []);

  const clearNativePathArtDraw = useCallback(() => {
    pathArtDrawRef.current = null;
    bezierArtNodeDragRef.current = null;
    syncPathArtPreview(null);
  }, [syncPathArtPreview]);

  const activateSelectToolAfterArtCommit = useCallback(() => {
    const selectToolState = createActiveToolState("tool.select");
    activeToolCommandIdRef.current = selectToolState.activeCommandId;
    setActiveToolState(selectToolState);
    void broadcastToolsetActiveTool(selectToolState.activeCommandId).catch(() => undefined);
  }, []);

  const finishNativePathArtDraw = useCallback((options: { point?: ClientPoint; closed?: boolean } = {}): boolean => {
    const draw = pathArtDrawRef.current;
    if (!draw) {
      return false;
    }

    const nodes = draw.nodes.map((node) => ({ ...node }));
    const lastNode = nodes[nodes.length - 1];
    if (
      options.point &&
      (!lastNode || clientPointDistance(lastNode.point, options.point) >= 0.75)
    ) {
      nodes.push({ point: options.point });
    }

    const closed = options.closed ?? draw.closed;
    const nextDocument = draw.pathKind === "bezier"
      ? nativeBezierPathDocument(draw.startDocument, nodes, draw.commandId, { closed })
      : nativePolylinePathDocument(draw.startDocument, nodes.map((node) => node.point), draw.commandId, { closed });
    clearNativePathArtDraw();
    if (nextDocument === draw.startDocument) {
      setStatus(draw.pathKind === "bezier"
        ? "Pen: add another point; drag handles; Enter ends, Esc cancels"
        : "Polyline: add another point; Backspace removes point; Enter/double-click ends, Esc cancels");
      return false;
    }

    const changed = commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    activateSelectToolAfterArtCommit();
    setStatus(selectToolStatusLabel());
    return changed;
  }, [
    activateSelectToolAfterArtCommit,
    assignHoveredNativeDeleteTarget,
    clearNativePathArtDraw,
    commitDocumentChange
  ]);

  const startOrAppendNativePathArtPoint = useCallback((
    point: ClientPoint,
    commandId: string,
    pathKind: PathArtDrawKind,
    options: { finish?: boolean; pointerId?: number; currentTarget?: Element } = {}
  ) => {
    const current = pathArtDrawRef.current;
    if (options.finish && current?.commandId === commandId) {
      finishNativePathArtDraw({ point });
      return;
    }

    if (!current || current.commandId !== commandId) {
      const draw: PathArtDrawState = {
        commandId,
        pathKind,
        startDocument: documentRef.current,
        nodes: [{ point }],
        latestPoint: point,
        closed: false
      };
      pathArtDrawRef.current = draw;
      syncPathArtPreview(draw);
      if (pathKind === "bezier" && options.pointerId !== undefined) {
        bezierArtNodeDragRef.current = {
          pointerId: options.pointerId,
          commandId,
          nodeIndex: 0,
          startPoint: point,
          latestPoint: point,
          dragging: false
        };
        options.currentTarget?.setPointerCapture(options.pointerId);
      }
      setActiveEditorObjectId(undefined);
      setActiveTextEditObjectId(undefined);
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setSelectedNativeMoleculePart(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      setFreeformNativeBond(undefined);
      setNativeDoubleBondSidePreview(undefined);
      setStatus(pathArtDrawStatusLabel(pathKind, 1));
      return;
    }

    const firstPoint = current.nodes[0]?.point;
    if (
      firstPoint &&
      current.nodes.length >= 3 &&
      clientPointDistance(firstPoint, point) <= pathCloseTolerance(viewportRef.current.scale)
    ) {
      current.closed = true;
      syncPathArtPreview(current);
      finishNativePathArtDraw({ closed: true });
      return;
    }

    const lastNode = current.nodes[current.nodes.length - 1];
    if (!lastNode || clientPointDistance(lastNode.point, point) >= 0.75) {
      current.nodes.push({ point });
    }
    current.latestPoint = point;
    if (pathKind === "bezier" && options.pointerId !== undefined) {
      bezierArtNodeDragRef.current = {
        pointerId: options.pointerId,
        commandId,
        nodeIndex: current.nodes.length - 1,
        startPoint: point,
        latestPoint: point,
        dragging: false
      };
      options.currentTarget?.setPointerCapture(options.pointerId);
    }
    syncPathArtPreview(current);
    setStatus(pathArtDrawStatusLabel(pathKind, current.nodes.length));
  }, [
    assignHoveredNativeDeleteTarget,
    finishNativePathArtDraw,
    syncPathArtPreview
  ]);

  const updateNativePathArtPreview = useCallback((point: ClientPoint) => {
    const draw = pathArtDrawRef.current;
    if (!draw) {
      return;
    }

    draw.latestPoint = point;
    syncPathArtPreview(draw);
  }, [syncPathArtPreview]);

  const updateBezierArtNodeDrag = useCallback((drag: BezierArtNodeDragState, point: ClientPoint) => {
    const draw = pathArtDrawRef.current;
    const node = draw?.nodes[drag.nodeIndex];
    if (!draw || draw.pathKind !== "bezier" || !node) {
      return;
    }

    drag.latestPoint = point;
    const dx = point.x - drag.startPoint.x;
    const dy = point.y - drag.startPoint.y;
    const dragging = drag.dragging || Math.hypot(dx, dy) >= penControlDragThreshold(viewportRef.current.scale);
    drag.dragging = dragging;
    if (dragging) {
      if (drag.nodeIndex > 0) {
        node.inControl = {
          x: drag.startPoint.x - dx,
          y: drag.startPoint.y - dy
        };
      }
      node.outControl = {
        x: drag.startPoint.x + dx,
        y: drag.startPoint.y + dy
      };
    }
    draw.latestPoint = undefined;
    syncPathArtPreview(draw);
  }, [syncPathArtPreview]);

  const clearBezierArtNodeDrag = useCallback((event?: { pointerId: number; currentTarget?: Element }) => {
    const drag = bezierArtNodeDragRef.current;
    if (!drag || (event && drag.pointerId !== event.pointerId)) {
      return;
    }

    bezierArtNodeDragRef.current = null;
    const page = pageRef.current;
    if (page?.hasPointerCapture(drag.pointerId)) {
      page.releasePointerCapture(drag.pointerId);
    }
    const currentTarget = event?.currentTarget;
    if (currentTarget?.hasPointerCapture(drag.pointerId)) {
      currentTarget.releasePointerCapture(drag.pointerId);
    }
  }, []);

  useEffect(() => {
    const draw = pathArtDrawRef.current;
    if (draw && activeToolState.activeCommandId !== draw.commandId) {
      clearNativePathArtDraw();
    }
  }, [activeToolState.activeCommandId, clearNativePathArtDraw]);

  const scheduleObjectTransformPreview = useCallback((nextPreview: ObjectTransformPreviewState | undefined) => {
    pendingObjectTransformPreviewRef.current = nextPreview;
    if (objectTransformPreviewRafRef.current !== undefined) {
      return;
    }

    objectTransformPreviewRafRef.current = window.requestAnimationFrame(() => {
      objectTransformPreviewRafRef.current = undefined;
      setObjectTransformPreview(pendingObjectTransformPreviewRef.current);
    });
  }, []);

  const clearObjectTransformPreview = useCallback((pointerId?: number) => {
    const pendingPreview = pendingObjectTransformPreviewRef.current;
    if (!pendingPreview || pointerId === undefined || pendingPreview.pointerId === pointerId) {
      pendingObjectTransformPreviewRef.current = undefined;
    }

    if (objectTransformPreviewRafRef.current !== undefined) {
      window.cancelAnimationFrame(objectTransformPreviewRafRef.current);
      objectTransformPreviewRafRef.current = undefined;
    }

    setObjectTransformPreview((current) => {
      if (!current || (pointerId !== undefined && current.pointerId !== pointerId)) {
        return current;
      }
      return undefined;
    });
  }, []);

  useEffect(() => () => {
    if (objectTransformPreviewRafRef.current !== undefined) {
      window.cancelAnimationFrame(objectTransformPreviewRafRef.current);
    }
  }, []);

  const clearProjectedPlaneTiltDrag = useCallback((event?: { pointerId: number; currentTarget?: Element }) => {
    const drag = projectedPlaneTiltDragRef.current;
    if (!drag || (event && drag.pointerId !== event.pointerId)) {
      return;
    }

    projectedPlaneTiltDragRef.current = null;
    const page = pageRef.current;
    if (page?.hasPointerCapture(drag.pointerId)) {
      page.releasePointerCapture(drag.pointerId);
    }
    const currentTarget = event?.currentTarget;
    if (currentTarget?.hasPointerCapture(drag.pointerId)) {
      currentTarget.releasePointerCapture(drag.pointerId);
    }
  }, []);

  /** Abandon an in-flight placement and restore the document it started from. Defined ahead of the
   *  keydown effect that calls it, so the effect's dependency list can name it. */
  const cancelNativePlacementDrag = useCallback((): void => {
    const drag = nativePlacementDragRef.current;
    if (!drag) {
      return;
    }
    nativePlacementDragRef.current = null;
    // The capture lives on the page element, which a key event cannot address. Dropping the ref is
    // what matters: pointerup then finds no drag and releases the capture without committing.
    replacePresentDocument(drag.startDocument);
  }, [replacePresentDocument]);

  const clearTapeMeasureDrag = useCallback((event?: { pointerId: number; currentTarget?: Element }) => {
    const drag = tapeMeasureDragRef.current;
    if (!drag || (event && drag.pointerId !== event.pointerId)) {
      return;
    }

    tapeMeasureDragRef.current = null;
    const page = pageRef.current;
    if (page?.hasPointerCapture(drag.pointerId)) {
      page.releasePointerCapture(drag.pointerId);
    }
    const currentTarget = event?.currentTarget;
    if (currentTarget?.hasPointerCapture(drag.pointerId)) {
      currentTarget.releasePointerCapture(drag.pointerId);
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcutTarget(event.target) || event.defaultPrevented) {
        return;
      }

      if (event.key === "Escape" && graphicCornerRadiusDragRef.current) {
        const graphicCornerRadiusDrag = graphicCornerRadiusDragRef.current;
        event.preventDefault();
        replacePresentDocument(graphicCornerRadiusDrag.startDocument);
        graphicCornerRadiusDragRef.current = null;
        setGraphicCornerRadiusReadout(undefined);
        const page = pageRef.current;
        if (page?.hasPointerCapture(graphicCornerRadiusDrag.pointerId)) {
          page.releasePointerCapture(graphicCornerRadiusDrag.pointerId);
        }
        setStatus("Corner radius canceled");
        return;
      }

      if (event.key === "Escape" && freehandArtDragRef.current) {
        const freehandArtDrag = freehandArtDragRef.current;
        event.preventDefault();
        replacePresentDocument(freehandArtDrag.startDocument);
        clearNativeFreehandArtDrag();
        setStatus(freehandArtStatusLabel(freehandArtDrag.commandId));
        return;
      }

      const pathArtDraw = pathArtDrawRef.current;
      if (pathArtDraw) {
        if (event.key === "Escape") {
          event.preventDefault();
          clearNativePathArtDraw();
          setStatus(pathArtDrawStatusLabel(pathArtDraw.pathKind));
          return;
        }

        if (event.key === "Enter") {
          event.preventDefault();
          finishNativePathArtDraw();
          return;
        }

        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          if (pathArtDraw.nodes.length <= 1) {
            clearNativePathArtDraw();
            setStatus(pathArtDrawStatusLabel(pathArtDraw.pathKind));
            return;
          }

          pathArtDraw.nodes.pop();
          pathArtDraw.latestPoint = pathArtDraw.nodes[pathArtDraw.nodes.length - 1]?.point;
          syncPathArtPreview(pathArtDraw);
          setStatus(pathArtDrawStatusLabel(pathArtDraw.pathKind, pathArtDraw.nodes.length));
          return;
        }
      }

      if (event.key === "Escape" && projectedPlaneTiltDragRef.current) {
        const projectedPlaneTiltDrag = projectedPlaneTiltDragRef.current;
        event.preventDefault();
        projectedPlaneTiltMachineRef.current = initialInteractionState();
        replacePresentDocument(projectedPlaneTiltDrag.startDocument);
        setSelectedNativeMoleculePart(projectedPlaneTiltDrag.target);
        clearProjectedPlaneTiltDrag();
        setProjectedPlaneTiltReadout(undefined);
        setStatus("3D rotate canceled");
        return;
      }

      if (event.key === "Escape" && activeToolCommandIdRef.current === "tool.art.measure") {
        event.preventDefault();
        clearTapeMeasureDrag();
        setTapeMeasure(undefined);
        switchToSelectTool();
        setStatus(selectToolStatusLabel());
        return;
      }

      if (event.key === "Escape" && activeToolCommandIdRef.current === "tool.art.eyedropper") {
        event.preventDefault();
        restoreToolAfterEyedropper();
        return;
      }

      if (event.key === "Escape" && activeToolCommandIdRef.current === "tool.art.scissors") {
        event.preventDefault();
        switchToSelectTool();
        setStatus(selectToolStatusLabel());
        return;
      }

      // A live placement (bond, template, arrow, chain) has to be abandoned before the generic
      // tool-escape below: switching to Select leaves the drag armed, and the eventual pointerup
      // still commits the object the user just tried to cancel.
      if (event.key === "Escape" && nativePlacementDragRef.current) {
        event.preventDefault();
        const label = nativePlacementStatusLabel(nativePlacementDragRef.current);
        cancelNativePlacementDrag();
        setStatus(`${capitalizeLabel(label)} canceled`);
        return;
      }

      if (
        event.key === "Escape" &&
        activeToolCommandIdRef.current !== "tool.select" &&
        isDrawingToolCommand(activeToolCommandIdRef.current)
      ) {
        event.preventDefault();
        switchToSelectTool();
        setStatus(selectToolStatusLabel());
        return;
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        const hoveredTargetCommandId = activeNativeTargetShortcutCommand(
          documentRef.current,
          selectedNativeMoleculePart,
          hoveredNativeDeleteTargetRef.current,
          event.key
        );
        if (hoveredTargetCommandId) {
          event.preventDefault();
          invokeCommandRef.current(hoveredTargetCommandId);
          return;
        }
      }

      const commandId = shortcutRegistry.resolve(event);
      if (!commandId) {
        return;
      }
      // Copy/cut/paste fall through to the native clipboard events (handleCopy/handleCut/handlePaste),
      // which read and write event.clipboardData synchronously. On desktop, handlePaste additionally
      // falls back to the native Tauri clipboard read when the WebView paste event has no data.
      if (shouldLetSystemClipboardHandleCommand(commandId)) {
        return;
      }

      event.preventDefault();
      invokeCommandRef.current(commandId);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    cancelNativePlacementDrag,
    clearNativeFreehandArtDrag,
    clearNativePathArtDraw,
    clearProjectedPlaneTiltDrag,
    clearTapeMeasureDrag,
    finishNativePathArtDraw,
    replacePresentDocument,
    restoreToolAfterEyedropper,
    selectedNativeMoleculePart,
    shortcutRegistry,
    switchToSelectTool,
    syncPathArtPreview
  ]);

  useEffect(() => {
    const setShiftPressed = (pressed: boolean) => {
      shiftKeyPressedRef.current = pressed;
      setTransformRotationHandlesVisible(pressed);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift" || event.shiftKey) {
        setShiftPressed(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift" || !event.shiftKey) {
        setShiftPressed(false);
      }
    };
    const handleVisibilityChange = () => {
      if (window.document.visibilityState !== "visible") {
        setShiftPressed(false);
      }
    };
    const handleBlur = () => setShiftPressed(false);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    window.document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      window.document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Esc cancels an active 3D spin (transient; never touched the document) — or,
  // before the overlay is up, abandons the in-flight conformer generation.
  useEffect(() => {
    const handleSpinEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
    if (spin3dStateRef.current) {
      event.preventDefault();
      event.stopPropagation();
      cancelSpin3dSession("Spin cancelled");
      return;
    }
    const pendingSpin = spin3dPendingRef.current;
    if (pendingSpin) {
      event.preventDefault();
      event.stopPropagation();
      cancelSpin3dSession("3D generation cancelled");
    }
  };
  window.addEventListener("keydown", handleSpinEscape, { capture: true });
  return () => window.removeEventListener("keydown", handleSpinEscape, { capture: true });
  }, [cancelSpin3dSession]);

  // Interactive 3D tug rides the Spin 3D overlay, so Esc is handled by the spin Esc handler
  // above (cancelSpin3dSession) and the detach effect tears the sidecar session down when the
  // overlay ends. No separate Esc listener is needed.

  // Native mode: JS is the sole initiator. On startup it opens the toolsets that should be
  // visible as floating NSPanels (reusing any the OS already restored), then tracks the real
  // window state. If none can be opened, fall back to in-window web palettes so the app is
  // never left with no toolbars.
  useEffect(() => {
    if (!effectiveNativePalette) {
      return;
    }

    let cancelled = false;
    void reconcileNativePaletteWindows({
      listToolsetWindowStates,
      openToolsetWindow: (toolsetId) => openToolsetWindow(toolsetId, toolsetWindowGeometry(toolsetId)),
      isKnownToolset: (toolsetId) => Boolean(toolsetRegistry.get(toolsetId)),
      desiredVisibleToolsetIds: () => [...visibleToolsetIdsRef.current],
      defaultVisibleToolsetIds: () => [...createDefaultVisibleToolsetIds(toolsetRegistry)],
      isCancelled: () => cancelled
    }).then((result) => {
      if (cancelled || result.outcome === "cancelled") {
        return;
      }
      if (result.outcome === "native") {
        // Do NOT narrow visibleToolsetIds to the set that actually opened. If one palette missed its
        // creating frame (is_visible() briefly false) while others opened, the reconciler returns a
        // partial openedToolsetIds; overwriting the desired set with it — and then persisting that —
        // would permanently drop that palette. The desired set stays authoritative; a later
        // reconcile pass reopens anything that missed.
        return;
      }
      // Retries exhausted — native windows are genuinely unavailable, so show in-window toolbars
      // rather than leaving the app with no toolbars at all. (A transient startup miss no longer
      // lands here; reconcileNativePaletteWindows retries first so it can't permanently trap the
      // palettes in the viewport.)
      setWebPaletteFallback(true);
      setVisibleToolsetIds(createDefaultVisibleToolsetIds(toolsetRegistry));
      setStatus("Native toolset windows unavailable; using in-window toolbars");
    });

    return () => {
      cancelled = true;
    };
  }, [effectiveNativePalette, toolsetRegistry, toolsetWindowGeometry]);

  // A pointer-down anywhere in the document window dismisses any open palette popover (the colour
  // picker floats in its own window; "click elsewhere closes it"). Native palettes only — in the
  // in-window fallback there is no separate popover window to dismiss.
  useEffect(() => {
    if (!effectiveNativePalette) {
      return;
    }
    const handlePointerDown = () => {
      void dismissToolsetPopovers().catch(() => undefined);
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => window.removeEventListener("pointerdown", handlePointerDown, true);
  }, [effectiveNativePalette]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    let unlistenState: (() => void) | undefined;
    let unlistenActiveToolRequest: (() => void) | undefined;
    let unlistenCommandSpecsRequest: (() => void) | undefined;
    let unlistenTextStyleRequest: (() => void) | undefined;
    let unlistenPreview: (() => void) | undefined;
    let unlistenCommit: (() => void) | undefined;
    let unlistenCancel: (() => void) | undefined;
    void listenForToolsetCommands((commandId) => {
      invokeCommandRef.current(commandId);
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      })
      .catch(() => {
        setStatus("Toolset command bridge unavailable");
      });
    void listenForToolsetWindowStates((state) => {
      setVisibleToolsetIds((current) => updateVisibleToolsets(current, state.toolsetId, state.open));
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlistenState = cleanup;
      })
      .catch(() => {
        setStatus("Toolset state bridge unavailable");
      });
    void listenForToolsetActiveToolRequests(() => {
      void broadcastToolsetActiveTool(activeToolCommandIdRef.current).catch(() => undefined);
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlistenActiveToolRequest = cleanup;
      })
      .catch(() => undefined);
    void listenForToolsetCommandSpecsRequests(() => {
      void broadcastToolsetCommandSpecs(shellCommandSpecsRef.current).catch(() => undefined);
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlistenCommandSpecsRequest = cleanup;
      })
      .catch(() => undefined);
    void listenForToolsetTextStyleRequests(() => {
      void broadcastToolsetTextStyle(currentToolbarTextStateRef.current).catch(() => undefined);
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlistenTextStyleRequest = cleanup;
      })
      .catch(() => undefined);
    void listenForPaletteCommandPreviews((commandId) => {
      palettePreviewHandlersRef.current.preview(commandId);
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlistenPreview = cleanup;
      })
      .catch(() => undefined);
    void listenForPaletteCommandCommits((commandId) => {
      palettePreviewHandlersRef.current.commit(commandId);
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlistenCommit = cleanup;
      })
      .catch(() => undefined);
    void listenForPaletteCommandCancels(() => {
      palettePreviewHandlersRef.current.cancel();
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlistenCancel = cleanup;
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisten?.();
      unlistenState?.();
      unlistenActiveToolRequest?.();
      unlistenCommandSpecsRequest?.();
      unlistenTextStyleRequest?.();
      unlistenPreview?.();
      unlistenCommit?.();
      unlistenCancel?.();
    };
  }, []);

  // A freshly created palette window asks for the current layout state (its disk copy can be stale
  // while the save chain is flushing); answer with the live state so it never renders an old layout.
  useEffect(() => {
    let active = true;
    let unlistenLayoutStateRequest: (() => void) | undefined;
    void listenForToolsetLayoutStateRequests(() => {
      const layoutState = layoutStateRef.current;
      if (layoutState !== undefined) {
        void broadcastToolsetLayoutState(layoutState).catch(() => undefined);
      }
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlistenLayoutStateRequest = cleanup;
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlistenLayoutStateRequest?.();
    };
  }, []);

  // Apply in-place customize edit ops from the Main palette against the authoritative layout state.
  // Ops (not full state) so a stale palette snapshot can't clobber; the resulting commit re-broadcasts
  // and the palette repaints. `exitCustomize` is a mode signal, not a layout edit.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenForToolsetLayoutEdits((payload) => {
      if (payload.toolsetId !== DEFAULT_TOOLSET_ID) {
        return;
      }
      if (payload.edit.kind === "exitCustomize") {
        setCustomizeMode(false);
        return;
      }
      const registry = toolsetRegistryRef.current;
      const currentGroups = getToolsetPaletteGroups(DEFAULT_TOOLSET_ID, registry);
      const presentItemIds = new Set(currentGroups.flatMap((group) => group.items.map((item) => item.id)));
      const orderedItemIdsByGroup = new Map(
        currentGroups.flatMap((group) =>
          group.id ? [[group.id, group.items.map((item) => item.id)] as const] : []
        )
      );
      const current = layoutStateRef.current ?? emptyLayoutState();
      const next = applyToolsetLayoutEdit(current, payload, {
        presentItemIds,
        orderedItemIdsByGroup,
        commandTitle: (commandId) => commandTitleByIdRef.current.get(commandId),
        commandIcon: (commandId) => commandByIdRef.current.get(commandId)?.icon,
        commandAssetName: (commandId) => commandByIdRef.current.get(commandId)?.assetName,
        widgetTitle: (widgetId) => TOOLBAR_WIDGET_TITLES[widgetId],
        widgetLayout: (widgetId) => TOOLBAR_WIDGET_GRID_SPANS[widgetId],
        gridRows: registry.get(DEFAULT_TOOLSET_ID)?.gridLayout?.rows
      });
      if (next !== current) {
        commitToolbarLayout(next, false);
      }
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [commitToolbarLayout, setCustomizeMode]);

  // Answer a late-joining palette's request for the current customize-mode state (mirrors the
  // layout-state responder above).
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenForToolsetCustomizeModeRequests(() => {
      void broadcastToolsetCustomizeMode({
        toolsetId: DEFAULT_TOOLSET_ID,
        active: customizeMainToolbarActiveRef.current
      }).catch(() => undefined);
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Exit customize mode if the Customize Toolbars dialog opens (they'd fight over the same state) or
  // the Main palette is closed out from under it.
  useEffect(() => {
    if (!customizeMainToolbarActive) {
      return;
    }
    if (customizeToolbarsOpen || !visibleToolsetIds.has(DEFAULT_TOOLSET_ID)) {
      setCustomizeMode(false);
    }
  }, [customizeMainToolbarActive, customizeToolbarsOpen, visibleToolsetIds, setCustomizeMode]);

  // Esc exits customize mode. The palette panels are non-focusable, so the key event lands on the
  // main window (the key window) — this is where Esc must be handled.
  useEffect(() => {
    if (!customizeMainToolbarActive) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCustomizeMode(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [customizeMainToolbarActive, setCustomizeMode]);

  // Label the web document by its worktree so browser tabs and accessibility state distinguish
  // nearby checkouts. On macOS, index.html's initial title can overwrite the Rust setup title without
  // following this later React update, so the Tauri page-load hook separately reasserts the same
  // baked label on the native NSWindow title bar. See AGENTS.md.
  useEffect(() => {
    window.document.title = __WORKTREE_LABEL__ ? `ChemDraft — ${__WORKTREE_LABEL__}` : "ChemDraft";
  }, []);

  const handleOpenFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    void file
      .text()
      .then((contents) => {
        openDocumentContents(contents, file.name);
      })
      .catch((error: unknown) => {
        setStatus(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const handleMoleculeTemplateFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    void file
      .arrayBuffer()
      .then((contents) => {
        applyMoleculeInspectorTemplateBytes(new Uint8Array(contents), file.name);
      })
      .catch((error: unknown) => {
        setStatus(`Template import failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const startWebPaletteDrag = useCallback((toolsetId: string, event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, select, input, textarea, [data-palette-control]")) {
      return;
    }

    const position = webPalettePositions[toolsetId] ?? defaultToolsetPosition(toolsetId, toolsetRegistry);
    webPaletteDragRef.current = {
      toolsetId,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startX: position.x,
      startY: position.y
    };
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [toolsetRegistry, webPalettePositions]);

  const moveWebPalette = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = webPaletteDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const maxX = Math.max(8, globalThis.innerWidth - 112);
    const maxY = Math.max(8, globalThis.innerHeight - 120);
    setWebPalettePositions((current) => ({
      ...current,
      [drag.toolsetId]: {
        x: clamp(drag.startX + event.clientX - drag.originX, 8, maxX),
        y: clamp(drag.startY + event.clientY - drag.originY, 44, maxY)
      }
    }));
  }, []);

  const stopWebPaletteDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    if (webPaletteDragRef.current?.pointerId === event.pointerId) {
      webPaletteDragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const pagePointFromClientPoint = useCallback((clientPoint: ClientPoint): ClientPoint | undefined => {
    const page = pageRef.current;
    if (!page) {
      return undefined;
    }

    const rect = page.getBoundingClientRect();
    return pagePointFromRenderedPageRect(rect, viewportRef.current.scale, clientPoint);
  }, []);

  const pagePointFromPointerEvent = useCallback((event: { clientX: number; clientY: number }): ClientPoint | undefined =>
    pagePointFromClientPoint({ x: event.clientX, y: event.clientY }), [pagePointFromClientPoint]);

  const applySingleBondDocumentAtPoint = useCallback((
    sourceDocument: ChemDraftDocument,
    point: ClientPoint,
    bondStyle?: NativeBondDisplayStyle
  ) => {
    const nextDocument = applySingleBondToolAtPoint(sourceDocument, point, { bondStyle });
    const selected = getSelectedMolecule(nextDocument);
    const atomCount = selected?.atoms.length ?? 0;
    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setStatus(atomCount > 2
      ? `Extended carbon chain to ${atomCount} atoms`
      : `Inserted ${nativeBondToolStatusLabel(bondStyle)} molecule`);
  }, [commitDocumentChange]);

  const applyNativeTemplateDocumentAtPoint = useCallback((
    point: ClientPoint,
    templateId: NonNullable<ReturnType<typeof nativeTemplateForToolCommand>>,
    target?: NativeMoleculeDeleteTarget
  ) => {
    const nextDocument = target
      ? applyNativeTemplateToolAtTarget(documentRef.current, target, point, templateId)
      : applyNativeTemplateToolAtPoint(documentRef.current, point, templateId);
    if (nextDocument !== documentRef.current) {
      commitDocumentChange(nextDocument);
    }
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setTemplatePreview(undefined);
    templatePreviewKeyRef.current = undefined;
    setStatus(nativeTemplateStatusForApplication(templateId, target, nextDocument !== documentRef.current));
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange]);

  const startNativePlacementDrag = useCallback((
    event: ObjectPointerEvent,
    point: ClientPoint,
    placement:
      | { kind: "single-bond"; bondStyle?: NativeBondDisplayStyle }
      | { kind: "template"; templateId: NativeMoleculeTemplateId }
      | { kind: "arrow"; arrowKind: ArrowObject["arrowKind"] }
      | { kind: "chain"; anchor?: NativeChainAnchor }
  ): boolean => {
    const startDocument = documentRef.current;
    const placementDocument = placement.kind === "template"
      ? applyNativeTemplateToolAtPoint(startDocument, point, placement.templateId)
      : placement.kind === "arrow"
        ? applyReactionArrowToolAtPoint(startDocument, point, placement.arrowKind)
        : placement.kind === "chain"
          ? applyNativeChainTool(startDocument, point, undefined, placement.anchor)
          : applySingleBondToolAtPoint(startDocument, point, { bondStyle: placement.bondStyle });
    const objectId = placementDocument.selection.objectIds[0];
    // Anchored chains grow an existing molecule, so the placed object legitimately pre-exists.
    const growsExistingObject = placement.kind === "chain" && placement.anchor !== undefined;
    if (placementDocument === startDocument || !objectId || (!growsExistingObject && findDocumentObject(startDocument, objectId))) {
      return false;
    }

    nativePlacementDragRef.current = {
      pointerId: event.pointerId,
      kind: placement.kind,
      startDocument,
      placementDocument,
      objectId,
      startPoint: point,
      latestPoint: point,
      bondStyle: placement.kind === "single-bond" ? placement.bondStyle : undefined,
      templateId: placement.kind === "template" ? placement.templateId : undefined,
      arrowKind: placement.kind === "arrow" ? placement.arrowKind : undefined,
      chainAnchor: placement.kind === "chain" ? placement.anchor : undefined,
      dragging: false
    };
    placementMachineRef.current = interactionReducer(initialInteractionState(), { type: "pointerDown", pointerId: event.pointerId, world: point, target: { kind: "empty" }, dragKind: "placement" });
    replacePresentDocument(placementDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setSelectedNativeMoleculePart(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    // The drag commits a live preview document, so the hover ghost would double up — drop it.
    setTemplatePreview(undefined);
    templatePreviewKeyRef.current = undefined;
    event.currentTarget.setPointerCapture(event.pointerId);
    return true;
  }, [assignHoveredNativeDeleteTarget, replacePresentDocument]);

  const applyNativeBondDisplayStyleDocumentTarget = useCallback((
    target: NativeBondOrderTarget,
    bondStyle: NativeBondDisplayStyle
  ) => {
    const nextDocument = applyNativeBondDisplayStyleTarget(documentRef.current, target, bondStyle);
    if (nextDocument !== documentRef.current) {
      commitDocumentChange(nextDocument);
    }
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setStatus(nextDocument === documentRef.current
      ? `${nativeBondToolStatusLabel(bondStyle)} already applied`
      : `Applied ${nativeBondToolStatusLabel(bondStyle)} style`);
  }, [commitDocumentChange]);

  const applyChargeDocumentAtPoint = useCallback((charge: NativeChargeValue, point: ClientPoint) => {
    const nextDocument = applyChargeToolAtPoint(documentRef.current, charge, point);
    if (nextDocument !== documentRef.current) {
      commitDocumentChange(nextDocument);
    }
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setStatus(charge > 0 ? "Placed positive charge" : "Placed negative charge");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange]);

  const applyFreeformBondDocumentAtPoint = useCallback((
    sourceDocument: ChemDraftDocument,
    objectId: string,
    atomId: string,
    point: ClientPoint,
    forceCustomLength: boolean,
    bondStyle?: NativeBondDisplayStyle
  ) => {
    const previousMolecule = findDocumentObject(sourceDocument, objectId);
    const nextDocument = applyFreeformSingleBondToolAtPoint(sourceDocument, objectId, atomId, point, {
      forceCustomLength,
      bondStyle
    });
    const selected = getSelectedMolecule(nextDocument);
    const atomCount = selected?.atoms.length ?? 0;
    const connectedExistingAtoms =
      previousMolecule?.type === "molecule" &&
      selected !== undefined &&
      selected.atoms.length === previousMolecule.atoms.length &&
      selected.bonds.length > previousMolecule.bonds.length;
    if (nextDocument !== sourceDocument) {
      commitDocumentChange(nextDocument);
    }
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setStatus(
      nextDocument === sourceDocument
        ? "Freeform bond not placed"
        : connectedExistingAtoms
          ? `Connected carbon atoms; molecule has ${atomCount} atoms`
          : `Placed freeform carbon bond; molecule has ${atomCount} atoms`
    );
  }, [commitDocumentChange]);

  const updateBondGrowthPreview = useCallback((sourceDocument: ChemDraftDocument, point: ClientPoint | undefined) => {
    if (!bondToolActive || !point) {
      setHoveredNativeAtom(undefined);
      return;
    }

    const page = sourceDocument.pages[0];
    const previews = page.objects
      .filter((object): object is MoleculeObject => object.type === "molecule")
      .map((object) => ({
        object,
        preview: previewNativeMoleculeBondGrowth(object, point, page.width, page.height)
      }))
      .filter((entry): entry is { object: MoleculeObject; preview: NonNullable<ReturnType<typeof previewNativeMoleculeBondGrowth>> } =>
        entry.preview !== undefined
      )
      .sort((left, right) =>
        left.preview.distanceToPointer - right.preview.distanceToPointer || left.object.id.localeCompare(right.object.id)
      );
    const target = previews[0];

    setHoveredNativeAtom(target ? {
      objectId: target.object.id,
      atomId: target.preview.atomId,
      direction: target.preview.direction,
      candidateDirections: target.preview.candidateDirections,
      newAtomPoint: target.preview.newAtomPoint
    } : undefined);
  }, [bondToolActive]);

  const updateNativeCanvasHover = useCallback((
    sourceDocument: ChemDraftDocument,
    point: ClientPoint | undefined,
    eventTarget?: EventTarget | null
  ) => {
    if (!point) {
      setHoveredNativeAtom(undefined);
      setNativeDoubleBondSidePreview(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      setTemplatePreview(undefined);
      templatePreviewKeyRef.current = undefined;
      return;
    }

    // Ring/template tools resolve the hover with the bond-preferring template resolver (purely
    // geometric) so the highlight matches what a click will fuse/attach. Every other tool keeps
    // the generic atom-first hover (with its DOM tiebreak) unchanged.
    const target = activeNativeTemplateId
      ? nativeMoleculeTemplateHoverTarget(
          sourceDocument,
          point,
          hitToleranceForScale(viewportRef.current.scale)
        )
      : nativeMoleculeCanvasHoverTarget(
          sourceDocument,
          point,
          eventTarget,
          hitToleranceForScale(viewportRef.current.scale)
        );
    assignHoveredNativeDeleteTarget(target);
    hoveredNativeAtomPointRef.current = target?.kind === "atom"
      ? { objectId: target.objectId, point }
      : undefined;
    // Capture the hover for a template click to reuse verbatim, so the committed placement
    // matches the painted highlight (no per-object recompute that can flip bond->atom).
    templateHoverTargetRef.current = activeNativeTemplateId && target
      ? {
          pagePoint: point,
          toolCommandId: activeToolState.activeCommandId,
          templateId: activeNativeTemplateId,
          target
        }
      : undefined;

    // Ghost preview: the exact ring a click would place. A fuse/spiro plan is determined by its
    // target (the shared edge/atom), so we key on that and skip recomputing the Kekulé pass while
    // the pointer wanders the same bond — only a standalone ring follows the cursor cell-by-cell.
    if (activeNativeTemplateId) {
      const previewKey = target
        ? [activeNativeTemplateId, target.objectId, target.kind, target.kind === "bond" ? target.bondId : target.atomId].join("|")
        : ["standalone", activeNativeTemplateId, Math.round(point.x / 4), Math.round(point.y / 4)].join("|");
      if (previewKey !== templatePreviewKeyRef.current) {
        templatePreviewKeyRef.current = previewKey;
        setTemplatePreview(planNativeTemplatePlacement(sourceDocument, { point, target: target ?? undefined }, activeNativeTemplateId));
      }
    } else if (templatePreviewKeyRef.current !== undefined) {
      templatePreviewKeyRef.current = undefined;
      setTemplatePreview(undefined);
    }

    if (activeToolState.activeCommandId === "tool.bond" && target) {
      const object = findDocumentObject(sourceDocument, target.objectId);
      setNativeDoubleBondSidePreview(object?.type === "molecule"
        ? nativeDoubleBondSidePreviewFromHit(target.objectId, object, target, point)
        : undefined);
    } else {
      setNativeDoubleBondSidePreview(undefined);
    }

    if (bondToolActive) {
      updateBondGrowthPreview(sourceDocument, point);
      return;
    }

    setHoveredNativeAtom(undefined);
  }, [
    activeNativeTemplateId,
    activeToolState.activeCommandId,
    assignHoveredNativeDeleteTarget,
    bondToolActive,
    updateBondGrowthPreview
  ]);

  useEffect(() => {
    const handleWindowPointerMove = (event: globalThis.MouseEvent) => {
      const clientPoint = { x: event.clientX, y: event.clientY };
      const canvas = canvasRegionRef.current;
      if (canvas && clientPointIsInsideRect(clientPoint, canvas.getBoundingClientRect())) {
        lastCanvasPointerClientPointRef.current = clientPoint;
      }
    };

    window.addEventListener("pointermove", handleWindowPointerMove, { capture: true });
    window.addEventListener("mousemove", handleWindowPointerMove, { capture: true });
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove, { capture: true });
      window.removeEventListener("mousemove", handleWindowPointerMove, { capture: true });
    };
  }, []);

  const updateFreeformBondPreview = useCallback((
    sourceDocument: ChemDraftDocument,
    drag: NativeBondDragState,
    point: ClientPoint | undefined
  ) => {
    if (!point) {
      return;
    }

    drag.latestPoint = point;
    const molecule = findDocumentObject(sourceDocument, drag.objectId);
    if (molecule?.type !== "molecule") {
      setFreeformNativeBond(undefined);
      return;
    }

    const page = sourceDocument.pages[0];
    const preview = previewNativeMoleculeFreeformBondGrowth(
      molecule,
      drag.atomId,
      point,
      page.width,
      page.height,
      { forceCustomLength: drag.freeformUnlocked }
    );
    if (preview?.customLength) {
      drag.freeformUnlocked = true;
    }
    setFreeformNativeBond(preview ? {
      objectId: molecule.id,
      atomId: preview.atomId,
      targetAtomId: preview.targetAtomId,
      newAtomPoint: preview.newAtomPoint,
      customLength: preview.customLength,
      lengthAngstrom: preview.lengthAngstrom
    } : undefined);
  }, []);

  const clearNativeBondDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = nativeBondDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      nativeBondDragRef.current = null;
      setFreeformNativeBond(undefined);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearNativeBondEditDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = nativeBondEditDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      nativeBondEditDragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearNativePlacementDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = nativePlacementDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      nativePlacementDragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const nativePlacementDocumentFromDrag = useCallback((
    drag: NativePlacementDragState,
    point: ClientPoint
  ): ChemDraftDocument => {
    if (drag.kind === "arrow") {
      // Arrows stretch: the press point stays the tail and the pointer sets length and angle.
      return stretchNativeReactionArrowTo(drag.placementDocument, drag.objectId, drag.startPoint, point);
    }
    if (drag.kind === "chain") {
      // Chains regenerate from the start document each move: the drag vector sets axis and
      // segment count, so the whole zig-zag is recomputed rather than transformed.
      // `preview`: the frames the user drags through are drawn from atoms and bonds, so the
      // whole-molecule SMILES derivation is pure cost until the gesture commits.
      return applyNativeChainTool(drag.startDocument, drag.startPoint, point, drag.chainAnchor, { preview: true });
    }
    return rotateNativeMoleculeObjectAroundPoint(
      drag.placementDocument,
      drag.objectId,
      drag.startPoint,
      nativePlacementRotationDegrees(drag.startPoint, point)
    );
  }, []);

  const previewNativePlacementDrag = useCallback((drag: NativePlacementDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    replacePresentDocument(nativePlacementDocumentFromDrag(drag, point));
  }, [nativePlacementDocumentFromDrag, replacePresentDocument]);

  const commitNativePlacementDrag = useCallback((drag: NativePlacementDragState, point: ClientPoint): boolean => {
    const placed = drag.dragging
      ? nativePlacementDocumentFromDrag(drag, point)
      : drag.placementDocument;
    if (placed === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    commitDocumentHistoryFrom(drag.startDocument, placed);
    return true;
  }, [commitDocumentHistoryFrom, nativePlacementDocumentFromDrag, replacePresentDocument]);

  const startNativeFreehandArtDrag = useCallback((
    event: ObjectPointerEvent,
    point: ClientPoint,
    commandId: string
  ) => {
    const startDocument = documentRef.current;
    clearFreehandArtPreview();
    freehandArtDragRef.current = {
      pointerId: event.pointerId,
      commandId,
      startDocument,
      points: [freehandPointFromPointerEvent(point, event)],
      startPoint: point,
      latestPoint: point,
      dragging: false
    };
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    event.currentTarget.setPointerCapture(event.pointerId);
    setStatus(freehandArtStatusLabel(commandId));
  }, [assignHoveredNativeDeleteTarget, clearFreehandArtPreview]);

  const previewNativeFreehandArtDrag = useCallback((
    drag: FreehandArtDragState,
    point: ClientPoint,
    event: ObjectPointerEvent
  ) => {
    drag.latestPoint = point;
    appendFreehandDragPoint(drag, freehandPointFromPointerEvent(point, event));
    if (!drag.dragging && clientPointDistance(drag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD) {
      drag.dragging = true;
    }
    if (!drag.dragging) {
      return;
    }

    scheduleFreehandArtPreview(drag);
  }, [scheduleFreehandArtPreview]);

  const commitNativeFreehandArtDrag = useCallback((
    drag: FreehandArtDragState,
    point: ClientPoint,
    event: ObjectPointerEvent
  ): boolean => {
    appendFreehandDragPoint(drag, freehandPointFromPointerEvent(point, event));
    if (!drag.dragging || drag.points.length < 2) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    const nextDocument = nativeFreehandStrokeDocument(drag.startDocument, drag.points, drag.commandId);
    if (nextDocument === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    commitDocumentHistoryFrom(drag.startDocument, nextDocument);
    const selectToolState = createActiveToolState("tool.select");
    activeToolCommandIdRef.current = selectToolState.activeCommandId;
    setActiveToolState(selectToolState);
    void broadcastToolsetActiveTool(selectToolState.activeCommandId).catch(() => undefined);
    return true;
  }, [commitDocumentHistoryFrom, replacePresentDocument]);

  const objectDragDocument = useCallback((drag: ObjectDragState, point: ClientPoint): ChemDraftDocument => {
    const dx = point.x - drag.startPoint.x;
    const dy = point.y - drag.startPoint.y;
    return drag.groupObjectIds && drag.groupObjectIds.length > 1
      ? moveDocumentObjects(drag.startDocument, drag.groupObjectIds, dx, dy)
      : moveDocumentObject(drag.startDocument, drag.objectId, {
          x: drag.startObjectX + dx,
          y: drag.startObjectY + dy
        });
  }, []);

  const previewObjectDrag = useCallback((drag: ObjectDragState, point: ClientPoint) => {
    markFrame("previewObjectDrag", () => {
      const previewObjectIds = graphicObjectIdsForCssDragPreview(drag);
      if (previewObjectIds) {
        scheduleObjectTransformPreview({
          pointerId: drag.pointerId,
          objectIds: previewObjectIds,
          mode: "move",
          origin: drag.startPoint,
          translateX: point.x - drag.startPoint.x,
          translateY: point.y - drag.startPoint.y,
          rotationDegrees: 0,
          scaleX: 1,
          scaleY: 1,
          artPreviewProxies: drag.artPreviewProxies
        });
        return;
      }

      clearObjectTransformPreview(drag.pointerId);
      replacePresentDocument(objectDragDocument(drag, point));
    });
  }, [clearObjectTransformPreview, objectDragDocument, replacePresentDocument, scheduleObjectTransformPreview]);

  const graphicCornerRadiusDocumentFromDrag = useCallback((drag: GraphicCornerRadiusDragState, point: ClientPoint): ChemDraftDocument =>
    updateNativeGraphicCornerRadius(
      drag.startDocument,
      drag.objectId,
      nativeGraphicCornerRadiusPointFromProjectedDrag(drag.startDocument, drag.objectId, point)
    ), []);

  const previewGraphicCornerRadius = useCallback((drag: GraphicCornerRadiusDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    const nextDocument = graphicCornerRadiusDocumentFromDrag(drag, point);
    const object = findDocumentObject(nextDocument, drag.objectId);
    if (object?.type === "graphic") {
      setGraphicCornerRadiusReadout({
        objectId: drag.objectId,
        radius: graphicCornerRadiusReadoutValue(object)
      });
    }
    replacePresentDocument(nextDocument);
  }, [graphicCornerRadiusDocumentFromDrag, replacePresentDocument]);

  const graphicPathEditDocumentFromDrag = useCallback((drag: GraphicPathEditDragState, point: ClientPoint): ChemDraftDocument => {
    const preparedDocument = prepareGraphicPathForDirectEdit(drag.workingDocument, drag.objectId);
    const editPoint = nativeGraphicPathEditPointFromProjectedDrag(preparedDocument, drag.objectId, point);
    return updateNativeGraphicPathHandle(preparedDocument, drag.objectId, drag.handle, editPoint);
  }, []);

  const previewGraphicPathEdit = useCallback((drag: GraphicPathEditDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    const nextDocument = graphicPathEditDocumentFromDrag(drag, point);
    drag.workingDocument = nextDocument;
    replacePresentDocument(nextDocument);
  }, [graphicPathEditDocumentFromDrag, replacePresentDocument]);

  const graphicMarkerDocumentFromDrag = useCallback((drag: GraphicMarkerDragState, point: ClientPoint): ChemDraftDocument => {
    const editPoint = nativeGraphicPathEditPointFromProjectedDrag(drag.startDocument, drag.objectId, point);
    return updateNativeGraphicMarkerHandle(drag.startDocument, drag.objectId, drag.markerId, editPoint);
  }, []);

  const previewGraphicMarkerDrag = useCallback((drag: GraphicMarkerDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    replacePresentDocument(graphicMarkerDocumentFromDrag(drag, point));
  }, [graphicMarkerDocumentFromDrag, replacePresentDocument]);

  const graphicGradientDocumentFromDrag = useCallback((drag: GraphicGradientDragState, point: ClientPoint): ChemDraftDocument => {
    const editPoint = nativeGraphicLocalPointFromProjectedDrag(drag.startDocument, drag.objectId, point);
    return isLinearGradientHandleId(drag.handle)
      ? updateNativeGraphicLinearGradientHandle(drag.startDocument, drag.objectId, drag.target, drag.handle, editPoint)
      : updateNativeGraphicRadialGradientHandle(drag.startDocument, drag.objectId, drag.target, drag.handle, editPoint);
  }, []);

  const previewGraphicGradientDrag = useCallback((drag: GraphicGradientDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    replacePresentDocument(graphicGradientDocumentFromDrag(drag, point));
  }, [graphicGradientDocumentFromDrag, replacePresentDocument]);

  const commitGraphicMarkerDrag = useCallback((drag: GraphicMarkerDragState, point: ClientPoint): boolean => {
    const edited = graphicMarkerDocumentFromDrag(drag, point);
    if (edited === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    commitDocumentHistoryFrom(drag.startDocument, edited);
    return true;
  }, [commitDocumentHistoryFrom, graphicMarkerDocumentFromDrag, replacePresentDocument]);

  const commitGraphicGradientDrag = useCallback((drag: GraphicGradientDragState, point: ClientPoint): boolean => {
    const edited = graphicGradientDocumentFromDrag(drag, point);
    if (edited === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    commitDocumentHistoryFrom(drag.startDocument, edited);
    return true;
  }, [commitDocumentHistoryFrom, graphicGradientDocumentFromDrag, replacePresentDocument]);

  const objectRotateDocumentFromDrag = useCallback((drag: ObjectRotateDragState, point: ClientPoint): ChemDraftDocument => {
    const degrees = rotationDeltaDegrees(drag.centerPoint, drag.startPoint, point);
    return drag.target
      ? rotateNativeMoleculeParts(drag.startDocument, drag.target, degrees)
      : rotateDocumentObject(drag.startDocument, drag.objectId, degrees);
  }, []);

  // Snapshot the molecule's persisted Spin 3D model for a whole-molecule rotate drag.
  // Returns undefined unless a valid (graph-matching) model is present and its conformer
  // maps cleanly onto the current atoms — callers then fall back to the legacy 2.5D tilt.
  const spin3dRotateSnapshotFor = useCallback((molecule: MoleculeObject): Spin3dRotateSnapshot | undefined => {
    const model = validSpin3dModelFor(molecule);
    if (!model) return undefined;
    const coords3d = spin3dModelCoordsForMolecule(model, molecule);
    if (!coords3d) return undefined;
    const { placement } = spinPlacementFor(molecule, coords3d, model.orientation);
    return {
      startOrientation: model.orientation,
      coords3d,
      placement,
      atomIds: molecule.atoms.map((atom) => atom.id),
      engine: model.engine
    };
  }, [spinPlacementFor]);

  const projectedPlaneTiltFromDrag = useCallback((
    drag: ProjectedPlaneTiltDragState,
    point: ClientPoint
  ): ProjectedPlaneTiltDocumentResult => {
    const object = findDocumentObject(drag.startDocument, drag.objectId);
    if (object && object.type !== "molecule") {
      const tiltDelta = documentObjectProjectedPlaneTiltVectorFromDrag(drag.startPoint, point);
      const rawTiltXRad = drag.startTiltXRad + tiltDelta.xRad;
      const rawTiltYRad = drag.startTiltYRad + tiltDelta.yRad;
      const wrappedTilt = wrapProjectedPlaneTiltVectorRadians(rawTiltXRad, rawTiltYRad);
      const tiltXRad = wrappedTilt.tiltXRad;
      const tiltYRad = wrappedTilt.tiltYRad;
      const document = applyDocumentObjectProjectedPlaneTilt(
        drag.startDocument,
        drag.objectId,
        radiansToDegrees(tiltXRad),
        radiansToDegrees(tiltYRad)
      );
      return {
        document,
        tiltRad: tiltXRad,
        tiltXRad,
        tiltYRad,
        rotationDegrees: 0,
        clamped: wrappedTilt.clamped,
        changed: document !== drag.startDocument
      };
    }

    // 3D-backed whole-molecule rotation: re-project the stored conformer through the
    // SAME flattenSpunMolecule pipeline Spin 3D commits, so atom positions, wedges,
    // crossings AND bond depth cues all move together for the current orientation.
    if (drag.spin3dModel && !drag.target) {
      const model = drag.spin3dModel;
      const delta = projectedPlaneTiltVectorFromDrag(drag.startPoint, point);
      // Delta is always measured from drag start and composed onto the start orientation,
      // so repeated moves never accumulate drift. Vertical drag → X axis, horizontal → Y.
      const deltaQuat = quatMultiply(
        quatFromAxisAngle(SPIN_AXIS_Y, delta.yRad),
        quatFromAxisAngle(SPIN_AXIS_X, delta.xRad)
      );
      const nextQuat = quatNormalize(quatMultiply(deltaQuat, model.startOrientation));
      let document = drag.lastValidPreviewDocument ?? drag.startDocument;
      let changed = document !== drag.startDocument;
      try {
        const outcome = flattenSpunMolecule(drag.startDocument, drag.objectId, model.coords3d, quatToViewMatrix(nextQuat), {
          placement: model.placement
        });
        if (outcome.status === "committed" && outcome.document !== drag.startDocument) {
          drag.lastValidPreviewDocument = outcome.document;
          drag.lastValidOrientation = nextQuat;
          document = outcome.document;
          changed = true;
        }
        // status !== "committed": a stereo-refused view — keep the last valid preview.
      } catch {
        // A flatten guard threw (e.g. a stale atom reference) — hold the last valid preview.
      }
      return {
        document,
        tiltRad: delta.xRad,
        tiltXRad: delta.xRad,
        tiltYRad: delta.yRad,
        rotationDegrees: 0,
        clamped: false,
        changed
      };
    }
    const tiltDelta = projectedPlaneTiltVectorFromDrag(drag.startPoint, point);
    const tiltXRad = drag.startTiltXRad + tiltDelta.xRad;
    const tiltYRad = drag.startTiltYRad + tiltDelta.yRad;
    return drag.target
      ? tiltNativeMoleculePartsProjectedPlane(
        drag.startDocument,
        drag.target,
        drag.centerPoint,
        drag.axisAngleRad,
        tiltXRad,
        {
          fromTiltRad: drag.startTiltXRad,
          fromTiltYRad: drag.startTiltYRad,
          tiltYRad,
          fromRotationDegrees: drag.startRotationDegrees,
          rotationDegrees: drag.startRotationDegrees
        }
      )
      : tiltNativeMoleculeProjectedPlane(
        drag.startDocument,
        drag.objectId,
        drag.centerPoint,
        drag.axisAngleRad,
        tiltXRad,
        {
          fromTiltRad: drag.startTiltXRad,
          fromTiltYRad: drag.startTiltYRad,
          tiltYRad,
          fromRotationDegrees: drag.startRotationDegrees,
          rotationDegrees: drag.startRotationDegrees,
          persistTransform: true
        }
      );
  }, []);

  const previewObjectRotateDrag = useCallback((drag: ObjectRotateDragState, point: ClientPoint) => {
    markFrame("previewObjectRotateDrag", () => {
      drag.latestPoint = point;
      const degrees = rotationDeltaDegrees(drag.centerPoint, drag.startPoint, point);
      if (objectRotateReadoutTimeoutRef.current !== undefined) {
        window.clearTimeout(objectRotateReadoutTimeoutRef.current);
      }
      setObjectRotateReadout({
        objectId: drag.objectId,
        degrees: cumulativeRotationReadoutDegrees(drag.startRotationDegrees, degrees)
      });
      objectRotateReadoutTimeoutRef.current = window.setTimeout(() => {
        objectRotateReadoutTimeoutRef.current = undefined;
        setObjectRotateReadout(undefined);
      }, 1200);
      if (!drag.target && findDocumentObject(drag.startDocument, drag.objectId)?.type === "graphic") {
        scheduleObjectTransformPreview({
          pointerId: drag.pointerId,
          objectIds: [drag.objectId],
          mode: "rotate",
          origin: drag.centerPoint,
          translateX: 0,
          translateY: 0,
          rotationDegrees: degrees,
          scaleX: 1,
          scaleY: 1,
          artPreviewProxies: drag.artPreviewProxies
        });
        return;
      }

      clearObjectTransformPreview(drag.pointerId);
      replacePresentDocument(objectRotateDocumentFromDrag(drag, point));
    });
  }, [clearObjectTransformPreview, objectRotateDocumentFromDrag, replacePresentDocument, scheduleObjectTransformPreview]);

  const showProjectedPlaneTiltReadout = useCallback((
    objectId: string,
    tiltXRad: number,
    tiltYRad: number,
    limited: boolean,
    hold = false
  ) => {
    if (projectedPlaneTiltReadoutTimeoutRef.current !== undefined) {
      window.clearTimeout(projectedPlaneTiltReadoutTimeoutRef.current);
      projectedPlaneTiltReadoutTimeoutRef.current = undefined;
    }

    setProjectedPlaneTiltReadout({
      objectId,
      label: projectedPlaneTiltReadoutLabel(tiltXRad, tiltYRad),
      limited
    });

    if (hold) {
      projectedPlaneTiltReadoutTimeoutRef.current = window.setTimeout(() => {
        projectedPlaneTiltReadoutTimeoutRef.current = undefined;
        setProjectedPlaneTiltReadout(undefined);
      }, 1200);
    }
  }, []);

  const previewProjectedPlaneTilt = useCallback((drag: ProjectedPlaneTiltDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    const result = projectedPlaneTiltFromDrag(drag, point);
    drag.latestTiltXRad = result.tiltXRad;
    drag.latestTiltYRad = result.tiltYRad;
    drag.clamped = result.clamped;
    showProjectedPlaneTiltReadout(
      drag.objectId,
      result.tiltXRad,
      result.tiltYRad,
      result.clamped
    );
    replacePresentDocument(result.document);
    setStatus(`3D rotate: ${projectedPlaneTiltReadoutLabel(result.tiltXRad, result.tiltYRad)}`);
  }, [projectedPlaneTiltFromDrag, replacePresentDocument, showProjectedPlaneTiltReadout]);

  const previewNativeDoubleBondSideDrag = useCallback((drag: NativeBondEditDragState, point: ClientPoint) => {
    const selectedStartDocument = selectDocumentObject(drag.startDocument, drag.target.objectId);
    const nextDocument = applyNativeDoubleBondSideTarget(selectedStartDocument, drag.target, point);
    replacePresentDocument(nextDocument);
  }, [replacePresentDocument]);

  const commitNativeDoubleBondSideDrag = useCallback((drag: NativeBondEditDragState, point: ClientPoint): boolean => {
    const selectedStartDocument = selectDocumentObject(drag.startDocument, drag.target.objectId);
    const moved = applyNativeDoubleBondSideTarget(selectedStartDocument, drag.target, point);
    if (moved === selectedStartDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    commitDocumentHistoryFrom(drag.startDocument, moved);
    return true;
  }, [commitDocumentHistoryFrom, replacePresentDocument]);

  const commitObjectDrag = useCallback((drag: ObjectDragState, point: ClientPoint): boolean => {
    const moved = objectDragDocument(drag, point);
    clearObjectTransformPreview(drag.pointerId);
    if (moved === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    commitDocumentHistoryFrom(drag.startDocument, moved);
    return true;
  }, [clearObjectTransformPreview, commitDocumentHistoryFrom, objectDragDocument, replacePresentDocument]);

  const commitGraphicCornerRadius = useCallback((drag: GraphicCornerRadiusDragState, point: ClientPoint): boolean => {
    const edited = graphicCornerRadiusDocumentFromDrag(drag, point);
    if (edited === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    commitDocumentHistoryFrom(drag.startDocument, edited);
    return true;
  }, [commitDocumentHistoryFrom, graphicCornerRadiusDocumentFromDrag, replacePresentDocument]);

  const commitGraphicPathEdit = useCallback((drag: GraphicPathEditDragState, point: ClientPoint): boolean => {
    const edited = drag.workingDocument === drag.startDocument
      ? graphicPathEditDocumentFromDrag(drag, point)
      : drag.workingDocument;
    if (edited === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    commitDocumentHistoryFrom(drag.startDocument, edited);
    return true;
  }, [commitDocumentHistoryFrom, graphicPathEditDocumentFromDrag, replacePresentDocument]);

  const commitObjectRotateDrag = useCallback((drag: ObjectRotateDragState, point: ClientPoint): boolean => {
    const rotated = objectRotateDocumentFromDrag(drag, point);
    clearObjectTransformPreview(drag.pointerId);
    if (rotated === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    // 3D-backed whole-molecule Z rotate: a pure in-plane (screen-Z) rotation is identical
    // to the existing 2D atom rotation — depth ordering, wedges and bond depthWeight are
    // unchanged, so we keep that cheap path (no re-flatten, no new stereo-refusal risk) and
    // only fold a screen-Z quaternion into the stored orientation so the next X/Y drag
    // re-projects from a consistent source instead of jumping.
    let committed = rotated;
    if (drag.spin3dModel && !drag.target) {
      const degrees = rotationDeltaDegrees(drag.centerPoint, drag.startPoint, point);
      // NOTE the negated angle: flattenSpunMolecule flips Y on output (math y-up → document
      // y-down), so a +θ screen rotation (rotateDocumentObject, which is what the user sees)
      // corresponds to a −θ rotation about the math-frame +Z axis. Folding +θ here would store
      // an orientation that twists opposite to the drawing, making the next reopen/X-Y tilt jump.
      const nextQuat = quatNormalize(quatMultiply(
        quatFromAxisAngle(SPIN_AXIS_Z, -degrees * Math.PI / 180),
        drag.spin3dModel.startOrientation
      ));
      committed = attachSpin3dModelFromConformer(rotated, drag.objectId, {
        coords3d: drag.spin3dModel.coords3d,
        orientation: nextQuat,
        engine: drag.spin3dModel.engine
      });
    }

    commitDocumentHistoryFrom(drag.startDocument, committed);
    return true;
  }, [clearObjectTransformPreview, commitDocumentHistoryFrom, objectRotateDocumentFromDrag, replacePresentDocument]);

  const commitProjectedPlaneTilt = useCallback((drag: ProjectedPlaneTiltDragState, point: ClientPoint): boolean => {
    const result = projectedPlaneTiltFromDrag(drag, point);
    drag.latestTiltXRad = result.tiltXRad;
    drag.latestTiltYRad = result.tiltYRad;
    drag.clamped = result.clamped;
    showProjectedPlaneTiltReadout(
      drag.objectId,
      result.tiltXRad,
      result.tiltYRad,
      result.clamped,
      true
    );

    // 3D-backed commit: attach the updated 3D model AND keep its orientation in lock-step
    // with the depth-cued geometry actually committed. If the final frame was refused, we
    // commit the last valid preview and attach lastValidOrientation (NOT the refused quat),
    // so the stored model never drifts away from the displayed depth/wedge/crossing state.
    if (drag.spin3dModel) {
      const finalOrientation = drag.lastValidOrientation;
      if (
        !result.changed ||
        !finalOrientation ||
        !drag.lastValidPreviewDocument ||
        drag.lastValidPreviewDocument === drag.startDocument
      ) {
        replacePresentDocument(drag.startDocument);
        return false;
      }
      // Preview frames flatten geometry-only for speed; the PERSISTED commit must re-flatten the
      // final orientation through the stereo read-back guard so a rotation can't silently commit a
      // different stereoisomer (the same protection the Spin 3D overlay commit applies).
      const guarded = flattenSpunMolecule(
        drag.startDocument,
        drag.objectId,
        drag.spin3dModel.coords3d,
        quatToViewMatrix(finalOrientation),
        { placement: drag.spin3dModel.placement, ...spin3dFlattenStereoOptions(drag.startDocument, drag.objectId) }
      );
      if (guarded.status !== "committed") {
        replacePresentDocument(drag.startDocument);
        setStatus(`3D rotation not applied: ${guarded.refusalReasons[0] ?? "stereochemistry would change"}`);
        return false;
      }
      const modeled = attachSpin3dModelFromConformer(guarded.document, drag.objectId, {
        coords3d: drag.spin3dModel.coords3d,
        orientation: finalOrientation,
        engine: drag.spin3dModel.engine
      });
      commitDocumentHistoryFrom(drag.startDocument, modeled);
      setStatus("3D rotation applied");
      return true;
    }

    if (!result.changed || result.document === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    commitDocumentHistoryFrom(drag.startDocument, result.document);
    return true;
  }, [commitDocumentHistoryFrom, projectedPlaneTiltFromDrag, replacePresentDocument, showProjectedPlaneTiltReadout, spin3dFlattenStereoOptions]);

  const rotationInputDocumentFromDraft = useCallback((input: RotationInputState): RotationInputDraftDocumentResult | undefined => {
    const object = findDocumentObject(input.startDocument, input.objectId);
    if (!object) {
      return undefined;
    }

    if (input.kind === "z") {
      const zDegrees = parseRotationInputDegrees(input.draftZDegrees);
      if (zDegrees === undefined) {
        return undefined;
      }

      let nextDocument = object.type === "molecule" && isNativeMoleculeGraph(object)
        ? input.target
          ? rotateNativeMoleculeParts(input.startDocument, input.target, zDegrees)
          : rotateDocumentObject(
              input.startDocument,
              input.objectId,
              manualRotationDeltaDegrees(nativeMoleculeTransformState(object).rotationDegrees, zDegrees)
            )
        : rotateDocumentObject(input.startDocument, input.objectId, manualRotationDeltaDegrees(object.rotation, zDegrees));
      if (!input.target && object.type === "molecule" && isNativeMoleculeGraph(object)) {
        const model = validSpin3dModelFor(object);
        const coords3d = model ? spin3dModelCoordsForMolecule(model, object) : undefined;
        if (model && coords3d) {
          const deltaDegrees = manualRotationDeltaDegrees(nativeMoleculeTransformState(object).rotationDegrees, zDegrees);
          const nextQuat = quatNormalize(quatMultiply(
            quatFromAxisAngle(SPIN_AXIS_Z, -deltaDegrees * Math.PI / 180),
            model.orientation
          ));
          nextDocument = attachSpin3dModelFromConformer(nextDocument, input.objectId, {
            coords3d,
            orientation: nextQuat,
            engine: model.engine
          });
        }
      }
      return { kind: "z", document: nextDocument, zDegrees };
    }

    const xDegrees = parseRotationInputDegrees(input.draftXDegrees);
    const yDegrees = parseRotationInputDegrees(input.draftYDegrees);
    if (xDegrees === undefined || yDegrees === undefined) {
      return undefined;
    }

    if (object.type !== "molecule") {
      const wrappedTilt = wrapProjectedPlaneTiltVectorRadians(
        degreesToRadians(xDegrees),
        degreesToRadians(yDegrees)
      );
      const tiltXDegrees = radiansToDegrees(wrappedTilt.tiltXRad);
      const tiltYDegrees = radiansToDegrees(wrappedTilt.tiltYRad);
      return {
        kind: "xy",
        document: applyDocumentObjectProjectedPlaneTilt(
          input.startDocument,
          input.objectId,
          tiltXDegrees,
          tiltYDegrees
        ),
        tiltXRad: degreesToRadians(tiltXDegrees),
        tiltYRad: degreesToRadians(tiltYDegrees),
        clamped: wrappedTilt.clamped
      };
    }

    if (!isNativeMoleculeGraph(object)) {
      return undefined;
    }

    if (!input.target) {
      const model = validSpin3dModelFor(object);
      const coords3d = model ? spin3dModelCoordsForMolecule(model, object) : undefined;
      if (model && coords3d) {
        const xRad = degreesToRadians(xDegrees);
        const yRad = degreesToRadians(yDegrees);
        const { placement } = spinPlacementFor(object, coords3d, model.orientation);
        const deltaQuat = quatMultiply(
          quatFromAxisAngle(SPIN_AXIS_Y, yRad),
          quatFromAxisAngle(SPIN_AXIS_X, xRad)
        );
        const nextQuat = quatNormalize(quatMultiply(deltaQuat, model.orientation));
        let document = input.startDocument;
        try {
          // Numeric X/Y rotation persists a flattened projection, so it runs the same stereo
          // read-back guard as the overlay/handle commits; a refused view leaves the document
          // unchanged (input.startDocument) rather than committing altered stereochemistry.
          const outcome = flattenSpunMolecule(input.startDocument, input.objectId, coords3d, quatToViewMatrix(nextQuat), {
            placement,
            ...spin3dFlattenStereoOptions(input.startDocument, input.objectId)
          });
          if (outcome.status === "committed") {
            document = attachSpin3dModelFromConformer(outcome.document, input.objectId, {
              coords3d,
              orientation: nextQuat,
              engine: model.engine
            });
          }
        } catch {
          document = input.startDocument;
        }
        return {
          kind: "xy",
          document,
          tiltXRad: xRad,
          tiltYRad: yRad,
          clamped: false
        };
      }
    }

    const fragmentBounds = input.target ? nativeMoleculePartBounds(object, input.target) : undefined;
    const center = fragmentBounds ? documentObjectCenter(fragmentBounds) : nativeMoleculeCenter(object);
    const transform = nativeMoleculeTransformState(object);
    const result = input.target
      ? tiltNativeMoleculePartsProjectedPlane(
          input.startDocument,
          input.target,
          center,
          0,
          degreesToRadians(xDegrees),
          {
            fromTiltRad: 0,
            fromTiltYRad: 0,
            tiltYRad: degreesToRadians(yDegrees),
            fromRotationDegrees: 0,
            rotationDegrees: 0
          }
        )
      : tiltNativeMoleculeProjectedPlane(
          input.startDocument,
          input.objectId,
          center,
          0,
          degreesToRadians(xDegrees),
          {
            fromTiltRad: degreesToRadians(transform.tiltXDegrees ?? 0),
            fromTiltYRad: degreesToRadians(transform.tiltYDegrees ?? 0),
            tiltYRad: degreesToRadians(yDegrees),
            fromRotationDegrees: transform.rotationDegrees,
            rotationDegrees: transform.rotationDegrees,
            persistTransform: true
          }
        );

    return {
      kind: "xy",
      document: result.document,
      tiltXRad: result.tiltXRad,
      tiltYRad: result.tiltYRad,
      clamped: result.clamped
    };
  }, [spinPlacementFor, spin3dFlattenStereoOptions]);

  const handleRotationInputChange = useCallback((nextInput: RotationInputState) => {
    updateRotationInput(nextInput);
    const result = rotationInputDocumentFromDraft(nextInput);
    if (!result) {
      setStatus(nextInput.kind === "z" ? "Enter a valid Z rotation" : "Enter valid X and Y rotations");
      return;
    }

    replacePresentDocument(result.document);
    if (result.kind === "xy") {
      showProjectedPlaneTiltReadout(nextInput.objectId, result.tiltXRad, result.tiltYRad, result.clamped, false);
    } else {
      setObjectRotateReadout({ objectId: nextInput.objectId, degrees: result.zDegrees });
    }
  }, [replacePresentDocument, rotationInputDocumentFromDraft, showProjectedPlaneTiltReadout, updateRotationInput]);

  const handleRotationInputHome = useCallback((input: RotationInputState) => {
    const nextInput: RotationInputState = input.kind === "z"
      ? { ...input, ...rotationInputHomeDraftDegrees("z") }
      : { ...input, ...rotationInputHomeDraftDegrees("xy") };
    handleRotationInputChange(nextInput);
    setStatus(nextInput.kind === "z" ? "Z rotation set to 0" : "X/Y rotation set to 0");
  }, [handleRotationInputChange]);

  const handleRotationInputCancel = useCallback((input?: RotationInputState) => {
    const session = input ?? rotationInputRef.current;
    if (session) {
      replacePresentDocument(session.startDocument);
    }
    updateRotationInput(undefined);
    setObjectRotateReadout(undefined);
    setProjectedPlaneTiltReadout(undefined);
    setStatus("Rotation entry canceled");
  }, [replacePresentDocument, updateRotationInput]);

  const handleRotationInputKeep = useCallback((input?: RotationInputState) => {
    const session = input ?? rotationInputRef.current;
    if (!session) {
      return false;
    }

    const changed = commitLiveInputPreview(session.startDocument);
    updateRotationInput(undefined);
    setObjectRotateReadout(undefined);
    setProjectedPlaneTiltReadout(undefined);
    setStatus(changed ? "Rotation applied" : "Rotation unchanged");
    return changed;
  }, [commitLiveInputPreview, updateRotationInput]);

  const showObjectResizeReadout = useCallback((objectId: string, scale: ObjectResizeScale, hold = false) => {
    if (objectResizeReadoutTimeoutRef.current !== undefined) {
      window.clearTimeout(objectResizeReadoutTimeoutRef.current);
      objectResizeReadoutTimeoutRef.current = undefined;
    }

    setObjectResizeReadout({
      objectId,
      scaleXPercent: objectResizeReadoutPercent(scale.x),
      scaleYPercent: objectResizeReadoutPercent(scale.y)
    });

    if (hold) {
      objectResizeReadoutTimeoutRef.current = window.setTimeout(() => {
        objectResizeReadoutTimeoutRef.current = undefined;
        setObjectResizeReadout(undefined);
      }, 1200);
    }
  }, []);

  const objectResizeInputDocumentFromDraft = useCallback((input: ObjectResizeInputState) => {
    const object = findDocumentObject(input.startDocument, input.objectId);
    if (!object) {
      return undefined;
    }

    const xPercent = parseObjectResizeInputPercent(input.draftXPercent);
    const yPercent = parseObjectResizeInputPercent(input.draftYPercent);
    if (xPercent === undefined || yPercent === undefined) {
      return undefined;
    }

    const targetScale = {
      x: xPercent / 100,
      y: yPercent / 100
    };
    if (object.type !== "molecule") {
      return {
        document: scaleDocumentObjectsAroundPoint(
          input.startDocument,
          [input.objectId],
          documentObjectCenter(object),
          targetScale.x,
          targetScale.y
        ),
        targetScale
      };
    }

    if (!isNativeMoleculeGraph(object)) {
      return undefined;
    }

    const transform = nativeMoleculeTransformState(object);
    const resizeScale = input.target
      ? targetScale
      : {
          x: targetScale.x / transform.scaleX,
          y: targetScale.y / transform.scaleY
    };
    const nextDocument = input.target
      ? resizeNativeMoleculeParts(input.startDocument, input.target, resizeScale)
      : resizeNativeMoleculeObject(input.startDocument, input.objectId, resizeScale);
    return { document: nextDocument, targetScale };
  }, []);

  const handleObjectResizeInputChange = useCallback((nextInput: ObjectResizeInputState) => {
    updateObjectResizeInput(nextInput);
    const result = objectResizeInputDocumentFromDraft(nextInput);
    if (!result) {
      setStatus("Enter valid X and Y stretch percentages");
      return;
    }

    replacePresentDocument(result.document);
    showObjectResizeReadout(nextInput.objectId, result.targetScale, false);
  }, [objectResizeInputDocumentFromDraft, replacePresentDocument, showObjectResizeReadout, updateObjectResizeInput]);

  const handleObjectResizeInputHome = useCallback((input: ObjectResizeInputState) => {
    replacePresentDocument(input.startDocument);
    updateObjectResizeInput({
      ...input,
      draftXPercent: input.homeXPercent,
      draftYPercent: input.homeYPercent
    });
    setObjectResizeReadout(undefined);
    setStatus("Stretch restored home");
  }, [replacePresentDocument, updateObjectResizeInput]);

  const handleObjectResizeInputCancel = useCallback((input?: ObjectResizeInputState) => {
    const session = input ?? objectResizeInputRef.current;
    if (session) {
      replacePresentDocument(session.startDocument);
    }
    updateObjectResizeInput(undefined);
    setObjectResizeReadout(undefined);
    setStatus("Stretch entry canceled");
  }, [replacePresentDocument, updateObjectResizeInput]);

  const handleObjectResizeInputKeep = useCallback((input?: ObjectResizeInputState) => {
    const session = input ?? objectResizeInputRef.current;
    if (!session) {
      return false;
    }

    const changed = commitLiveInputPreview(session.startDocument);
    updateObjectResizeInput(undefined);
    setObjectResizeReadout(undefined);
    setStatus(changed ? "Stretch applied" : "Stretch unchanged");
    return changed;
  }, [commitLiveInputPreview, updateObjectResizeInput]);

  // Clears the transient interaction "chrome" — open editors, hover highlights, and in-flight
  // previews — without touching the selection. Numeric transform sessions are first kept as
  // one undoable change so clicking elsewhere on the viewport preserves the live-preview values.
  const clearTransientInteractionChrome = useCallback(() => {
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveGraphicTransformObjectId(undefined);
    setSelectedGraphicPathNode(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    clearObjectTransformPreview();
    assignHoveredNativeDeleteTarget(undefined);
  }, [
    assignHoveredNativeDeleteTarget,
    clearObjectTransformPreview,
    handleObjectResizeInputKeep,
    handleRotationInputKeep
  ]);

  const objectResizeDocumentFromDrag = useCallback((
    drag: ObjectResizeDragState,
    point: ClientPoint,
    stretching: boolean
  ): ChemDraftDocument => {
    const scale = objectResizeScaleFromDrag(drag.centerPoint, drag.startPoint, point, stretching);
    const object = findDocumentObject(drag.startDocument, drag.objectId);
    if (!drag.target && object?.type !== "molecule") {
      return scaleDocumentObjectsAroundPoint(drag.startDocument, [drag.objectId], drag.centerPoint, scale.x, scale.y);
    }

    return drag.target
      ? resizeNativeMoleculeParts(drag.startDocument, drag.target, scale)
      : resizeNativeMoleculeObject(drag.startDocument, drag.objectId, scale);
  }, []);

  const previewObjectResize = useCallback((drag: ObjectResizeDragState, point: ClientPoint, stretching: boolean) => {
    markFrame("previewObjectResize", () => {
      drag.latestPoint = point;
      drag.stretching = stretching;
      drag.latestScale = objectResizeScaleFromDrag(drag.centerPoint, drag.startPoint, point, stretching);
      drag.latestCumulativeScale = cumulativeObjectResizeScale(drag.startCumulativeScale, drag.latestScale);
      showObjectResizeReadout(drag.objectId, drag.latestCumulativeScale);
      clearObjectTransformPreview(drag.pointerId);
      replacePresentDocument(objectResizeDocumentFromDrag(drag, point, stretching));
    });
  }, [clearObjectTransformPreview, objectResizeDocumentFromDrag, replacePresentDocument, showObjectResizeReadout]);

  const commitObjectResize = useCallback((drag: ObjectResizeDragState, point: ClientPoint): boolean => {
    drag.latestScale = objectResizeScaleFromDrag(drag.centerPoint, drag.startPoint, point, drag.stretching);
    drag.latestCumulativeScale = cumulativeObjectResizeScale(drag.startCumulativeScale, drag.latestScale);
    const resized = objectResizeDocumentFromDrag(drag, point, drag.stretching);
    showObjectResizeReadout(drag.objectId, drag.latestCumulativeScale, true);
    clearObjectTransformPreview(drag.pointerId);
    if (resized === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    commitDocumentHistoryFrom(drag.startDocument, resized);
    return true;
  }, [clearObjectTransformPreview, commitDocumentHistoryFrom, objectResizeDocumentFromDrag, replacePresentDocument, showObjectResizeReadout]);

  const nativePartDocumentFromDrag = useCallback((drag: NativePartDragState, point: ClientPoint): ChemDraftDocument =>
    moveNativeMoleculeParts(drag.startDocument, drag.target, {
      x: point.x - drag.startPoint.x,
      y: point.y - drag.startPoint.y
    }), []);

  const previewNativePartDrag = useCallback((drag: NativePartDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    replacePresentDocument(nativePartDocumentFromDrag(drag, point));
  }, [nativePartDocumentFromDrag, replacePresentDocument]);

  const commitNativePartDrag = useCallback((drag: NativePartDragState, point: ClientPoint): boolean => {
    const moved = nativePartDocumentFromDrag(drag, point);
    if (moved === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    commitDocumentHistoryFrom(drag.startDocument, moved);
    return true;
  }, [commitDocumentHistoryFrom, nativePartDocumentFromDrag, replacePresentDocument]);

  const resizeTextDocumentFromDrag = useCallback((drag: TextResizeState, point: ClientPoint): ChemDraftDocument => {
    const dx = point.x - drag.startPoint.x;
    const dy = point.y - drag.startPoint.y;
    const frame = drag.edge === "right"
      ? {
          x: drag.startObjectX,
          width: drag.startObjectWidth + dx
        }
      : drag.edge === "left" ? {
          x: drag.startObjectX + dx,
          width: drag.startObjectWidth - dx
        }
      : drag.edge === "bottom" ? {
          y: drag.startObjectY,
          height: drag.startObjectHeight + dy
        }
      : {
          y: drag.startObjectY + dy,
          height: drag.startObjectHeight - dy
        };

    return resizeNativeTextObjectBox(drag.startDocument, drag.objectId, frame);
  }, []);

  const previewTextResize = useCallback((drag: TextResizeState, point: ClientPoint) => {
    drag.latestPoint = point;
    replacePresentDocument(resizeTextDocumentFromDrag(drag, point));
  }, [replacePresentDocument, resizeTextDocumentFromDrag]);

  const commitTextResize = useCallback((drag: TextResizeState, point: ClientPoint): boolean => {
    const resized = resizeTextDocumentFromDrag(drag, point);
    if (resized === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    commitDocumentHistoryFrom(drag.startDocument, resized);
    return true;
  }, [commitDocumentHistoryFrom, replacePresentDocument, resizeTextDocumentFromDrag]);

  const clearObjectDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = objectDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      objectDragRef.current = null;
      clearObjectTransformPreview(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, [clearObjectTransformPreview]);

  const clearGraphicCornerRadiusDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = graphicCornerRadiusDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      graphicCornerRadiusDragRef.current = null;
      setGraphicCornerRadiusReadout(undefined);
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearGraphicPathEditDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = graphicPathEditDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      graphicPathEditDragRef.current = null;
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearGraphicMarkerDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = graphicMarkerDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      graphicMarkerDragRef.current = null;
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearGraphicGradientDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = graphicGradientDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      graphicGradientDragRef.current = null;
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearObjectRotateDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = objectRotateDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      objectRotateDragRef.current = null;
      clearObjectTransformPreview(event.pointerId);
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, [clearObjectTransformPreview]);

  const clearObjectResizeDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = objectResizeDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      objectResizeDragRef.current = null;
      clearObjectTransformPreview(event.pointerId);
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, [clearObjectTransformPreview]);

  const clearNativePartDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = nativePartDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      nativePartDragRef.current = null;
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearTextResize = useCallback((event: ObjectPointerEvent) => {
    const drag = textResizeRef.current;
    if (drag?.pointerId === event.pointerId) {
      textResizeRef.current = null;
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const startTextResize = useCallback((
    objectId: string,
    edge: TextResizeEdge,
    event: PointerEvent<HTMLButtonElement>
  ) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    const point = pagePointFromPointerEvent(event);
    const object = findDocumentObject(documentRef.current, objectId);
    if (!point || object?.type !== "text") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    textResizeRef.current = {
      pointerId: event.pointerId,
      objectId,
      edge,
      startDocument: documentRef.current,
      startPoint: point,
      latestPoint: point,
      startObjectX: object.x,
      startObjectY: object.y,
      startObjectWidth: object.width,
      startObjectHeight: object.height
    };
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId((current) => current === objectId ? current : undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    pageRef.current?.setPointerCapture(event.pointerId);
  }, [assignHoveredNativeDeleteTarget, pagePointFromPointerEvent]);

  const groupProjectedPlaneTiltFromDrag = useCallback((
    drag: GroupTransformDragState,
    point: ClientPoint
  ) => {
    const tiltDelta = projectedPlaneTiltVectorFromDrag(drag.startPoint, point);
    return tiltNativeMoleculeObjectsProjectedPlane(
      drag.startDocument,
      drag.objectIds,
      drag.center,
      0,
      tiltDelta.xRad,
      {
        fromTiltRad: 0,
        fromTiltYRad: 0,
        tiltYRad: tiltDelta.yRad,
        fromRotationDegrees: 0,
        rotationDegrees: 0
      }
    );
  }, []);

  // Transform the whole selected group about its shared visual selection-box center.
  const groupTransformDocument = useCallback((
    drag: GroupTransformDragState,
    point: ClientPoint,
    stretch = false
  ): ChemDraftDocument => {
    if (drag.mode === "rotate") {
      const degrees = rotationDeltaDegrees(drag.center, drag.startPoint, point);
      return rotateDocumentObjectsAroundPoint(drag.startDocument, drag.objectIds, drag.center, degrees);
    }
    if (drag.mode === "projected-plane-tilt") {
      return groupProjectedPlaneTiltFromDrag(drag, point).document;
    }
    const scale = objectResizeScaleFromDrag(drag.center, drag.startPoint, point, stretch);
    return scaleDocumentObjectsAroundPoint(drag.startDocument, drag.objectIds, drag.center, scale.x, scale.y);
  }, [groupProjectedPlaneTiltFromDrag]);

  const handleGroupTransformPointerDown = useCallback((
    mode: GroupTransformDragState["mode"],
    event: PointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }
    const resolvedSelectionObjectIds = resolveGroupedDocumentObjectIds(
      document.pages[0].objects,
      document.selection.objectIds
    );
    const ids = mode === "projected-plane-tilt"
      ? nativeMoleculeObjectIdsForGroupProjectedPlaneTilt(document.pages[0].objects, resolvedSelectionObjectIds)
      : resolvedSelectionObjectIds;
    const point = pagePointFromPointerEvent(event);
    const bounds = ids.length > 1 ? visualSelectionBounds(document.pages[0].objects, ids) : undefined;
    if (!point || !bounds) {
      if (mode === "projected-plane-tilt") {
        setStatus("Select multiple native molecules for 3D rotate");
      }
      return;
    }

    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    groupTransformDragRef.current = {
      pointerId: event.pointerId,
      mode,
      objectIds: [...ids],
      startDocument: document,
      center: { x: bounds.centerX, y: bounds.centerY },
      startPoint: point,
      latestPoint: point,
      dragging: false
    };
    groupTransformMachineRef.current = interactionReducer(initialInteractionState(), {
      type: "pointerDown",
      pointerId: event.pointerId,
      world: point,
      target: { kind: "empty" },
      dragKind: mode === "rotate"
        ? "group-rotate"
        : mode === "projected-plane-tilt" ? "group-projected-plane-tilt" : "group-resize"
    });
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(
      mode === "rotate"
        ? "Rotate selected group"
        : mode === "projected-plane-tilt" ? "3D rotate: drag to tilt/twist selected molecules" : "Resize selected group"
    );
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    document,
    pagePointFromPointerEvent
  ]);

  const handleGroupRotatePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) =>
    handleGroupTransformPointerDown("rotate", event), [handleGroupTransformPointerDown]);
  const handleGroupProjectedPlaneTiltPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) =>
    handleGroupTransformPointerDown("projected-plane-tilt", event), [handleGroupTransformPointerDown]);
  const handleGroupResizePointerDown = useCallback((_corner: ObjectResizeCorner) =>
    (event: PointerEvent<HTMLButtonElement>) => handleGroupTransformPointerDown("resize", event),
  [handleGroupTransformPointerDown]);

  const startTapeMeasureDrag = useCallback((event: ObjectPointerEvent, point: ClientPoint) => {
    event.preventDefault();
    event.stopPropagation();
    const drag: TapeMeasureDragState = {
      pointerId: event.pointerId,
      startPoint: point,
      latestPoint: constrainTapeMeasurePoint(point, point, event.shiftKey),
      constrained: event.shiftKey,
      dragging: false
    };
    tapeMeasureDragRef.current = drag;
    setTapeMeasure(drag);
    setSelectedNativeMoleculePart(undefined);
    setActiveGraphicTransformObjectId(undefined);
    clearTransientInteractionChrome();
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus("Measure: drag endpoint");
  }, [clearTransientInteractionChrome]);

  const startSelectionLasso = useCallback((event: ObjectPointerEvent, point: ClientPoint) => {
    event.preventDefault();
    event.stopPropagation();
    selectionLassoRef.current = {
      pointerId: event.pointerId,
      startPoint: point,
      points: [point],
      latestPoint: point,
      subtracting: event.altKey,
      dragging: false
    };
    lassoMachineRef.current = interactionReducer(
      initialInteractionState(),
      { type: "pointerDown", pointerId: event.pointerId, world: point, target: { kind: "empty" }, dragKind: "marquee" }
    );
    setSelectedNativeMoleculePart(undefined);
    setActiveGraphicTransformObjectId(undefined);
    clearTransientInteractionChrome();
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus("Lasso selection");
  }, [clearTransientInteractionChrome]);

  const startSelectionMarquee = useCallback((event: ObjectPointerEvent, point: ClientPoint) => {
    event.preventDefault();
    selectionMarqueeRef.current = {
      pointerId: event.pointerId,
      startPoint: point,
      latestPoint: point,
      dragging: false
    };
    marqueeMachineRef.current = interactionReducer(
      initialInteractionState(),
      { type: "pointerDown", pointerId: event.pointerId, world: point, target: { kind: "empty" }, dragKind: "marquee" }
    );
    setSelectedNativeMoleculePart(undefined);
    setActiveGraphicTransformObjectId(undefined);
    clearTransientInteractionChrome();
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [clearTransientInteractionChrome]);

  const handlePagePointerDown = useCallback((event: ObjectPointerEvent) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    setObjectContextMenu(undefined);
    const point = pagePointFromPointerEvent(event);
    if (!point) {
      return;
    }

    if (activeToolState.activeCommandId === "tool.art.measure") {
      startTapeMeasureDrag(event, point);
      return;
    }

    if (activeToolState.activeCommandId === "tool.art.eyedropper") {
      event.preventDefault();
      event.stopPropagation();
      setStatus(eyedropperStatusLabel(effectiveArtPaintTarget));
      return;
    }

    if (activeToolState.activeCommandId === "tool.art.scissors") {
      event.preventDefault();
      event.stopPropagation();
      setStatus(scissorsStatusLabel());
      return;
    }

    if (activeToolState.activeKind === "selection") {
      if (activeToolState.activeCommandId === "tool.lasso") {
        if (selectionChromeConsumesPointerTarget(event.target)) {
          return;
        }
        startSelectionLasso(event, point);
        return;
      }

      if (activeToolState.activeCommandId === "tool.eraser") {
        startSelectionMarquee(event, point);
        setStatus("Drag eraser over objects");
        return;
      }

      const pressObject = nativeMoleculeObjectAtPoint(document.pages[0].objects, point);
      const press = { time: Date.now(), x: event.clientX, y: event.clientY, objectId: pressObject?.id };
      const doublePress = event.detail >= 2 || isSelectionDoublePress(lastSelectionPressRef.current, press);
      lastSelectionPressRef.current = press;
      if (doublePress) {
        const object = pressObject;
        if (object) {
          event.preventDefault();
          event.stopPropagation();
          replacePresentDocument((current) => selectDocumentObject(current, object.id));
          setSelectedNativeMoleculePart(undefined);
          setActiveGraphicTransformObjectId(undefined);
          clearTransientInteractionChrome();
          setStatus("Selected molecule");
          return;
        }
      }

      startSelectionMarquee(event, point);
      return;
    }

    if (activeChargeToolValue) {
      applyChargeDocumentAtPoint(activeChargeToolValue, point);
      return;
    }

    if (activeNativeTemplateId) {
      event.preventDefault();
      event.stopPropagation();
      // Ask the same question the object path asks: is there a current template target? If so,
      // fuse/attach to it instead of dropping a standalone ring in the gap. Only true empty
      // space (no resolved target) starts standalone placement.
      const templateTarget = currentTemplateTargetFromHoverOrHit(
        document,
        { pagePoint: point, toolCommandId: activeToolState.activeCommandId, templateId: activeNativeTemplateId },
        templateHoverTargetRef.current,
        viewportRef.current.scale
      );
      if (templateTarget) {
        applyNativeTemplateDocumentAtPoint(point, activeNativeTemplateId, templateTarget);
      } else if (!startNativePlacementDrag(event, point, { kind: "template", templateId: activeNativeTemplateId })) {
        applyNativeTemplateDocumentAtPoint(point, activeNativeTemplateId);
      }
      return;
    }

    if (activeNativeArtTool) {
      event.preventDefault();
      event.stopPropagation();
      if (activeNativeArtTool.commandId === "tool.art.polyline") {
        startOrAppendNativePathArtPoint(point, activeNativeArtTool.commandId, "polyline", { finish: event.detail >= 2 });
        return;
      }
      if (activeNativeArtTool.commandId === "tool.art.pen") {
        startOrAppendNativePathArtPoint(point, activeNativeArtTool.commandId, "bezier", {
          currentTarget: event.currentTarget,
          finish: event.detail >= 2,
          pointerId: event.pointerId
        });
        return;
      }
      if (nativeArtToolIsFreehand(activeNativeArtTool.commandId)) {
        startNativeFreehandArtDrag(event, point, activeNativeArtTool.commandId);
        return;
      }
      applyNativeArtDocumentAtPoint(point, activeNativeArtTool.commandId);
      return;
    }

    {
      const arrowKind = reactionArrowKindForToolCommand(activeToolState.activeCommandId);
      if (arrowKind) {
        event.preventDefault();
        event.stopPropagation();
        if (!startNativePlacementDrag(event, point, { kind: "arrow", arrowKind })) {
          const nextDocument = applyReactionArrowToolAtPoint(documentRef.current, point, arrowKind);
          if (nextDocument !== documentRef.current) {
            commitDocumentChange(nextDocument);
            setStatus(`Inserted ${nativeReactionArrowStatusLabel(arrowKind)} arrow`);
          }
        }
        return;
      }
    }

    if (activeToolState.activeCommandId === "tool.chain") {
      event.preventDefault();
      event.stopPropagation();
      if (!startNativePlacementDrag(event, point, { kind: "chain" })) {
        const nextDocument = applyNativeChainTool(documentRef.current, point);
        if (nextDocument !== documentRef.current) {
          commitDocumentChange(nextDocument);
          setStatus("Inserted carbon chain");
        }
      }
      return;
    }

    {
      const bracketKind = bracketKindForToolCommand(activeToolState.activeCommandId);
      if (bracketKind) {
        event.preventDefault();
        event.stopPropagation();
        applyBracketAtPoint(point, bracketKind);
        return;
      }
    }

    {
      const symbolGlyph = symbolGlyphForToolCommand(activeToolState.activeCommandId);
      if (symbolGlyph) {
        event.preventDefault();
        event.stopPropagation();
        applySymbolGlyphAtPoint(point, symbolGlyph);
        return;
      }
    }

    if (activeToolState.activeCommandId === "tool.atom") {
      event.preventDefault();
      event.stopPropagation();
      setStatus("Atom Label Tool: click an atom to edit its label");
      return;
    }

    if (activeToolState.activeCommandId === "tool.text") {
      event.preventDefault();
      event.stopPropagation();
      applyTextDocumentAtPoint(point);
      return;
    }

    if (activeNativeBondToolStyle) {
      event.preventDefault();
      event.stopPropagation();
      if (!startNativePlacementDrag(event, point, { kind: "single-bond", bondStyle: activeNativeBondDisplayStyle })) {
        applySingleBondDocumentAtPoint(document, point, activeNativeBondDisplayStyle);
      }
    }
  }, [
    activeChargeToolValue,
    activeNativeBondDisplayStyle,
    activeNativeBondToolStyle,
    activeNativeTemplateId,
    activeNativeArtTool,
    activeToolState.activeCommandId,
    activeToolState.activeKind,
    applyChargeDocumentAtPoint,
    applyNativeArtDocumentAtPoint,
    applyNativeTemplateDocumentAtPoint,
    applySingleBondDocumentAtPoint,
    applySymbolGlyphAtPoint,
    applyTextDocumentAtPoint,
    commitDocumentChange,
    document,
    pagePointFromPointerEvent,
    startTapeMeasureDrag,
    startSelectionMarquee,
    startSelectionLasso,
    startOrAppendNativePathArtPoint,
    startNativeFreehandArtDrag,
    startNativePlacementDrag
  ]);

  const handlePageContextMenu = useCallback((event: ObjectMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setObjectContextMenu(undefined);
  }, []);

  const handlePagePointerMove = useCallback((event: ObjectPointerEvent) => {
    const groupTransform = groupTransformDragRef.current;
    if (groupTransform?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }
      groupTransform.latestPoint = point;
      groupTransformMachineRef.current = interactionReducer(groupTransformMachineRef.current, { type: "pointerMove", pointerId: event.pointerId, world: point, target: { kind: "empty" } });
      const nowDragging = groupTransformMachineRef.current.phase === "dragging";
      if (!groupTransform.dragging && nowDragging) {
        groupTransform.dragging = true;
      }
      if (groupTransform.dragging) {
        if (groupTransform.mode === "projected-plane-tilt") {
          const result = groupProjectedPlaneTiltFromDrag(groupTransform, point);
          groupTransform.latestTiltXRad = result.tiltXRad;
          groupTransform.latestTiltYRad = result.tiltYRad;
          groupTransform.clamped = result.clamped;
          replacePresentDocument(result.document);
          setStatus(`3D rotate: ${projectedPlaneTiltReadoutLabel(result.tiltXRad, result.tiltYRad)}`);
        } else {
          replacePresentDocument(groupTransformDocument(groupTransform, point, event.shiftKey));
        }
      }
      return;
    }

    const tapeMeasureDrag = tapeMeasureDragRef.current;
    if (tapeMeasureDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      const latestPoint = constrainTapeMeasurePoint(tapeMeasureDrag.startPoint, point, event.shiftKey);
      tapeMeasureDrag.latestPoint = latestPoint;
      tapeMeasureDrag.constrained = event.shiftKey;
      tapeMeasureDrag.dragging = true;
      setTapeMeasure({ ...tapeMeasureDrag });
      setStatus(`Measure: ${formatTapeMeasureDistance(tapeMeasureDrag.startPoint, latestPoint, pageRulerUnit)}`);
      return;
    }

    const textResize = textResizeRef.current;
    if (textResize?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (point) {
        previewTextResize(textResize, point);
      }
      return;
    }

    const projectedPlaneTiltDrag = projectedPlaneTiltDragRef.current;
    if (projectedPlaneTiltDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      projectedPlaneTiltDrag.latestPoint = point;
      projectedPlaneTiltMachineRef.current = interactionReducer(projectedPlaneTiltMachineRef.current, {
        type: "pointerMove",
        pointerId: event.pointerId,
        world: point,
        target: { kind: "empty" }
      });
      const nowDragging = projectedPlaneTiltMachineRef.current.phase === "dragging";
      if (!projectedPlaneTiltDrag.dragging && nowDragging) {
        projectedPlaneTiltDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(projectedPlaneTiltDrag.target);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (projectedPlaneTiltDrag.dragging) {
        previewProjectedPlaneTilt(projectedPlaneTiltDrag, point);
      }
      return;
    }

    const objectRotateDrag = objectRotateDragRef.current;
    if (objectRotateDrag?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      objectRotateDrag.latestPoint = point;
      objectRotateMachineRef.current = interactionReducer(objectRotateMachineRef.current, { type: "pointerMove", pointerId: event.pointerId, world: point, target: { kind: "empty" } });
      const nowDragging = objectRotateMachineRef.current.phase === "dragging";
      if (!objectRotateDrag.dragging && nowDragging) {
        objectRotateDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        if (!objectRotateDrag.target) {
          setSelectedNativeMoleculePart(undefined);
        }
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (objectRotateDrag.dragging) {
        previewObjectRotateDrag(objectRotateDrag, point);
      }
      return;
    }

    const objectResizeDrag = objectResizeDragRef.current;
    if (objectResizeDrag?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      objectResizeDrag.latestPoint = point;
      if (!objectResizeDrag.dragging && clientPointDistance(objectResizeDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        objectResizeDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        if (!objectResizeDrag.target) {
          setSelectedNativeMoleculePart(undefined);
        }
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (objectResizeDrag.dragging) {
        previewObjectResize(objectResizeDrag, point, event.shiftKey);
      }
      return;
    }

    const graphicCornerRadiusDrag = graphicCornerRadiusDragRef.current;
    if (graphicCornerRadiusDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicCornerRadiusDrag.latestPoint = point;
      if (!graphicCornerRadiusDrag.dragging && clientPointDistance(graphicCornerRadiusDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD) {
        graphicCornerRadiusDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicCornerRadiusDrag.dragging) {
        previewGraphicCornerRadius(graphicCornerRadiusDrag, point);
      }
      return;
    }

    const graphicPathEditDrag = graphicPathEditDragRef.current;
    if (graphicPathEditDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicPathEditDrag.latestPoint = point;
      if (
        !graphicPathEditDrag.dragging &&
        (
          graphicPathEditDrag.handle === "middle" ||
          clientPointDistance(graphicPathEditDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD
        )
      ) {
        graphicPathEditDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicPathEditDrag.dragging) {
        previewGraphicPathEdit(graphicPathEditDrag, point);
      }
      return;
    }

    const graphicMarkerDrag = graphicMarkerDragRef.current;
    if (graphicMarkerDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicMarkerDrag.latestPoint = point;
      if (!graphicMarkerDrag.dragging && clientPointDistance(graphicMarkerDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD) {
        graphicMarkerDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicMarkerDrag.dragging) {
        previewGraphicMarkerDrag(graphicMarkerDrag, point);
      }
      return;
    }

    const graphicGradientDrag = graphicGradientDragRef.current;
    if (graphicGradientDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicGradientDrag.latestPoint = point;
      if (!graphicGradientDrag.dragging && clientPointDistance(graphicGradientDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD) {
        graphicGradientDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicGradientDrag.dragging) {
        previewGraphicGradientDrag(graphicGradientDrag, point);
      }
      return;
    }

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      objectDrag.latestPoint = point;
      objectDragMachineRef.current = interactionReducer(objectDragMachineRef.current, { type: "pointerMove", pointerId: event.pointerId, world: point, target: { kind: "empty" } });
      const nowDragging = objectDragMachineRef.current.phase === "dragging";
      if (!objectDrag.dragging && nowDragging) {
        objectDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }
      if (objectDrag.dragging) {
        previewObjectDrag(objectDrag, point);
      }
      return;
    }

    const nativePartDrag = nativePartDragRef.current;
    if (nativePartDrag?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      nativePartDrag.latestPoint = point;
      if (!nativePartDrag.dragging && clientPointDistance(nativePartDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        nativePartDrag.dragging = true;
        clearTransientInteractionChrome();
      }

      if (nativePartDrag.dragging) {
        previewNativePartDrag(nativePartDrag, point);
      }
      return;
    }

    const nativePlacementDrag = nativePlacementDragRef.current;
    if (nativePlacementDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      nativePlacementDrag.latestPoint = point;
      placementMachineRef.current = interactionReducer(placementMachineRef.current, { type: "pointerMove", pointerId: event.pointerId, world: point, target: { kind: "empty" } });
      const nowDragging = placementMachineRef.current.phase === "dragging";
      if (!nativePlacementDrag.dragging && nowDragging) {
        nativePlacementDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setSelectedNativeMoleculePart(undefined);
        setHoveredNativeAtom(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (nativePlacementDrag.dragging) {
        previewNativePlacementDrag(nativePlacementDrag, point);
      }
      return;
    }

    const freehandArtDrag = freehandArtDragRef.current;
    if (freehandArtDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }
      previewNativeFreehandArtDrag(freehandArtDrag, point, event);
      return;
    }

    const bezierArtNodeDrag = bezierArtNodeDragRef.current;
    if (bezierArtNodeDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (point) {
        updateBezierArtNodeDrag(bezierArtNodeDrag, point);
      }
      return;
    }

    if (pathArtDrawRef.current) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (point) {
        updateNativePathArtPreview(point);
      }
      return;
    }

    const lasso = selectionLassoRef.current;
    if (lasso?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      lasso.latestPoint = point;
      lasso.subtracting = lasso.subtracting || event.altKey;
      lassoMachineRef.current = interactionReducer(lassoMachineRef.current, { type: "pointerMove", pointerId: event.pointerId, world: point, target: { kind: "empty" } });
      lasso.dragging = lassoMachineRef.current.phase === "dragging";
      if (lasso.dragging) {
        const lastPoint = lasso.points[lasso.points.length - 1] ?? lasso.latestPoint;
        if (clientPointDistance(lastPoint, point) >= LASSO_POINT_SPACING_PX) {
          lasso.points = [...lasso.points, point];
        }
      }
      setSelectionLasso(lasso.dragging ? { ...lasso, points: [...lasso.points] } : undefined);
      return;
    }

    const marquee = selectionMarqueeRef.current;
    if (marquee?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      marquee.latestPoint = point;
      marqueeMachineRef.current = interactionReducer(marqueeMachineRef.current, { type: "pointerMove", pointerId: event.pointerId, world: point, target: { kind: "empty" } });
      marquee.dragging = marqueeMachineRef.current.phase === "dragging";
      setSelectionMarquee(marquee.dragging ? { ...marquee } : undefined);
      return;
    }

    updateNativeCanvasHover(document, pagePointFromPointerEvent(event), event.target);
  }, [
    assignHoveredNativeDeleteTarget,
    document,
    groupProjectedPlaneTiltFromDrag,
    groupTransformDocument,
    pageRulerUnit,
    pagePointFromPointerEvent,
    previewObjectDrag,
    previewObjectRotateDrag,
    previewProjectedPlaneTilt,
    previewObjectResize,
    previewGraphicCornerRadius,
    previewGraphicPathEdit,
    previewGraphicGradientDrag,
    previewGraphicMarkerDrag,
    previewNativeFreehandArtDrag,
    updateBezierArtNodeDrag,
    updateNativePathArtPreview,
    previewNativePartDrag,
    previewNativePlacementDrag,
    previewTextResize,
    replacePresentDocument,
    updateNativeCanvasHover
  ]);

  const handlePagePointerUp = useCallback((event: ObjectPointerEvent) => {
    const groupTransform = groupTransformDragRef.current;
    if (groupTransform?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? groupTransform.latestPoint;
      groupTransformMachineRef.current = initialInteractionState();
      if (groupTransform.dragging) {
        const result = groupTransform.mode === "projected-plane-tilt"
          ? groupProjectedPlaneTiltFromDrag(groupTransform, point)
          : undefined;
        const next = result?.document ?? groupTransformDocument(groupTransform, point, event.shiftKey);
        if (next !== groupTransform.startDocument) {
          commitDocumentHistoryFrom(groupTransform.startDocument, next);
        }
        setStatus(
          groupTransform.mode === "rotate"
            ? "Rotated selection"
            : groupTransform.mode === "projected-plane-tilt"
              ? "3D rotate applied"
              : "Resized selection"
        );
      }
      groupTransformDragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }

    const tapeMeasureDrag = tapeMeasureDragRef.current;
    if (tapeMeasureDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? tapeMeasureDrag.latestPoint;
      const latestPoint = constrainTapeMeasurePoint(tapeMeasureDrag.startPoint, point, event.shiftKey);
      const finalMeasure = {
        startPoint: tapeMeasureDrag.startPoint,
        latestPoint,
        constrained: event.shiftKey,
        dragging: false
      };
      setTapeMeasure(finalMeasure);
      setStatus(`Measure: ${formatTapeMeasureDistance(finalMeasure.startPoint, finalMeasure.latestPoint, pageRulerUnit)}`);
      clearTapeMeasureDrag(event);
      return;
    }

    const textResize = textResizeRef.current;
    if (textResize?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? textResize.latestPoint;
      const changed = commitTextResize(textResize, point);
      clearTextResize(event);
      setStatus(changed ? "Resized text box" : "Text box size unchanged");
      return;
    }

    const projectedPlaneTiltDrag = projectedPlaneTiltDragRef.current;
    if (projectedPlaneTiltDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? projectedPlaneTiltDrag.latestPoint;
      projectedPlaneTiltMachineRef.current = initialInteractionState();
      if (projectedPlaneTiltDrag.dragging) {
        const changed = commitProjectedPlaneTilt(projectedPlaneTiltDrag, point);
        setStatus(changed
          ? "3D rotate applied"
          : "3D rotate canceled");
      } else {
        replacePresentDocument(projectedPlaneTiltDrag.startDocument);
        setProjectedPlaneTiltReadout(undefined);
        setStatus("3D rotate canceled");
      }
      setSelectedNativeMoleculePart(projectedPlaneTiltDrag.target);
      clearProjectedPlaneTiltDrag(event);
      return;
    }

    const objectRotateDrag = objectRotateDragRef.current;
    if (objectRotateDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? objectRotateDrag.latestPoint;
      if (objectRotateDrag.dragging) {
        const changed = commitObjectRotateDrag(objectRotateDrag, point);
        const object = findDocumentObject(documentRef.current, objectRotateDrag.objectId);
        const label = objectRotateDrag.target ? "selected molecule fragment" : documentObjectTransformLabel(object);
        setStatus(changed ? `Rotated ${label}` : `${capitalizeLabel(label)} rotation unchanged`);
      }
      clearObjectRotateDrag(event);
      return;
    }

    const objectResizeDrag = objectResizeDragRef.current;
    if (objectResizeDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? objectResizeDrag.latestPoint;
      if (objectResizeDrag.dragging) {
        objectResizeDrag.latestScale = objectResizeScaleFromDrag(
          objectResizeDrag.centerPoint,
          objectResizeDrag.startPoint,
          point,
          objectResizeDrag.stretching
        );
        const changed = commitObjectResize(objectResizeDrag, point);
        const object = findDocumentObject(documentRef.current, objectResizeDrag.objectId);
        const targetLabel = objectResizeDrag.target ? "selected molecule fragment" : documentObjectTransformLabel(object);
        setStatus(changed
          ? objectResizeDrag.stretching ? `Stretched ${targetLabel}` : `Resized ${targetLabel}`
          : `${capitalizeLabel(targetLabel)} size unchanged`);
      }
      clearObjectResizeDrag(event);
      return;
    }

    const graphicCornerRadiusDrag = graphicCornerRadiusDragRef.current;
    if (graphicCornerRadiusDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicCornerRadiusDrag.latestPoint;
      if (graphicCornerRadiusDrag.dragging) {
        const changed = commitGraphicCornerRadius(graphicCornerRadiusDrag, point);
        setStatus(changed ? "Adjusted corner radius" : "Corner radius unchanged");
      } else {
        setStatus("Selected rounded rectangle");
      }
      clearGraphicCornerRadiusDrag(event);
      return;
    }

    const graphicPathEditDrag = graphicPathEditDragRef.current;
    if (graphicPathEditDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicPathEditDrag.latestPoint;
      if (graphicPathEditDrag.dragging) {
        const changed = commitGraphicPathEdit(graphicPathEditDrag, point);
        setStatus(graphicPathEditStatus(graphicPathEditDrag, changed));
      } else {
        setStatus("Selected art path");
      }
      clearGraphicPathEditDrag(event);
      return;
    }

    const graphicMarkerDrag = graphicMarkerDragRef.current;
    if (graphicMarkerDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicMarkerDrag.latestPoint;
      if (graphicMarkerDrag.dragging) {
        const changed = commitGraphicMarkerDrag(graphicMarkerDrag, point);
        setStatus(changed ? "Adjusted arrowhead size" : "Arrowhead size unchanged");
      } else {
        setStatus("Selected arrowhead");
      }
      clearGraphicMarkerDrag(event);
      return;
    }

    const graphicGradientDrag = graphicGradientDragRef.current;
    if (graphicGradientDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicGradientDrag.latestPoint;
      if (graphicGradientDrag.dragging) {
        const changed = commitGraphicGradientDrag(graphicGradientDrag, point);
        const handleName = graphicGradientHandleStatusName(graphicGradientDrag.target, graphicGradientDrag.handle);
        setStatus(changed ? `Moved ${handleName}` : "Gradient handle unchanged");
      } else {
        setStatus("Selected gradient handle");
      }
      clearGraphicGradientDrag(event);
      return;
    }

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? objectDrag.latestPoint;
      objectDragMachineRef.current = initialInteractionState();
      if (objectDrag.dragging) {
        const changed = commitObjectDrag(objectDrag, point);
        setStatus(changed ? "Moved selected object" : "Object did not move");
      } else if (objectDrag.bondTarget) {
        cycleNativeBondOrder(objectDrag.bondTarget);
      } else {
        const object = findDocumentObject(documentRef.current, objectDrag.objectId);
        if (shouldOpenMoleculeEditorFromObjectClick(object, activeToolState.activeKind, event.detail)) {
          setActiveEditorObjectId(object.id);
        }
      }
      clearObjectDrag(event);
      return;
    }

    const nativePartDrag = nativePartDragRef.current;
    if (nativePartDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? nativePartDrag.latestPoint;
      if (nativePartDrag.dragging) {
        const changed = commitNativePartDrag(nativePartDrag, point);
        setStatus(changed ? "Moved selected molecule part" : "Molecule part did not move");
      }
      clearNativePartDrag(event);
      return;
    }

    const nativePlacementDrag = nativePlacementDragRef.current;
    if (nativePlacementDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? nativePlacementDrag.latestPoint;
      const changed = commitNativePlacementDrag(nativePlacementDrag, point);
      const label = nativePlacementStatusLabel(nativePlacementDrag);
      const draggedVerb = nativePlacementDrag.kind === "arrow"
        ? "Inserted angled"
        : nativePlacementDrag.kind === "chain"
          ? "Inserted"
          : "Inserted rotated";
      setStatus(changed
        ? nativePlacementDrag.dragging ? `${draggedVerb} ${label}` : `Inserted ${label}`
        : `${capitalizeLabel(label)} not placed`);
      clearNativePlacementDrag(event);
      return;
    }

    const freehandArtDrag = freehandArtDragRef.current;
    if (freehandArtDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? freehandArtDrag.latestPoint;
      commitNativeFreehandArtDrag(freehandArtDrag, point, event);
      setStatus(freehandArtStatusLabel(freehandArtDrag.commandId));
      clearNativeFreehandArtDrag(event);
      return;
    }

    const bezierArtNodeDrag = bezierArtNodeDragRef.current;
    if (bezierArtNodeDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? bezierArtNodeDrag.latestPoint;
      updateBezierArtNodeDrag(bezierArtNodeDrag, point);
      clearBezierArtNodeDrag(event);
      return;
    }

    const lasso = selectionLassoRef.current;
    if (lasso?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? lasso.latestPoint;
      const wasDragging = lassoMachineRef.current.phase === "dragging";
      const lassoPoints = lassoPointsForSelection(lasso, point);
      const region = wasDragging
        ? selectionInSelectionLasso(document.pages[0].objects, lassoPoints)
        : { objectIds: [], nativeSelection: undefined };
      // Alt held at any point during the drag subtracts; otherwise the shared policy decides
      // add (Shift) vs replace. Regions stay object/atom/bond-only (no ring interiors, D3).
      const mode = lasso.subtracting
        ? "subtract"
        : selectionModeFromEvent(event, { gesture: "region", shiftFallback: shiftKeyPressedRef.current });
      const next = fromSelectionItems(
        applySelection(
          toSelectionItemsMulti(documentRef.current.selection.objectIds, selectedNativeMoleculePartsRef.current),
          toSelectionItems(region.objectIds, region.nativeSelection),
          mode
        ),
        { includeNativePartHost: false, scope: "multi" }
      );
      replacePresentDocument((current) =>
        selectDocumentObjects(current, current.pages[0].id, next.objectIds)
      );
      setSelectedNativeMoleculeParts(next.nativeMoleculeParts);
      setActiveGraphicTransformObjectId(undefined);
      clearTransientInteractionChrome();
      if (next.objectIds.length === 0 && !next.nativeMoleculePart) {
        toolbarStyleTargetRef.current = undefined;
      }
      setSelectionLasso(undefined);
      selectionLassoRef.current = null;
      lassoMachineRef.current = initialInteractionState();
      setStatus(mode === "subtract"
        ? selectionSubtractStatusLabel(region)
        : selectionStatusLabel({ objectIds: next.objectIds, nativeSelection: next.nativeMoleculePart, nativeSelections: next.nativeMoleculeParts }));
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }

    const marquee = selectionMarqueeRef.current;
    if (!marquee || marquee.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    const point = pagePointFromPointerEvent(event) ?? marquee.latestPoint;
    marquee.latestPoint = point;
    const wasDragging = marqueeMachineRef.current.phase === "dragging";
    if (activeToolState.activeCommandId === "tool.eraser") {
      const objectIds = wasDragging
        ? eraserObjectIdsInSelectionRect(document.pages[0].objects, marquee.startPoint, point)
        : [];
      if (objectIds.length > 0) {
        const nextDocument = applyPatches(
          document,
          objectIds.map((objectId) => ({ op: "removeObject", objectId }))
        );
        commitDocumentChange(nextDocument);
        toolbarStyleTargetRef.current = undefined;
        setSelectedNativeMoleculePart(undefined);
        setActiveGraphicTransformObjectId(undefined);
        clearTransientInteractionChrome();
      }
      setSelectionMarquee(undefined);
      selectionMarqueeRef.current = null;
      marqueeMachineRef.current = initialInteractionState();
      setStatus(objectIds.length === 0 ? "Nothing erased" : objectIds.length === 1 ? "Deleted object" : `Deleted ${objectIds.length} objects`);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }

    const region = wasDragging
      ? selectionInSelectionRect(document.pages[0].objects, marquee.startPoint, point)
      : { objectIds: [], nativeSelection: undefined };
    // Shift adds to the existing selection, Alt subtracts, otherwise replace — the same policy
    // as clicks. Regions stay object/atom/bond-only (no ring interiors, D3).
    const mode = selectionModeFromEvent(event, { gesture: "region", shiftFallback: shiftKeyPressedRef.current });
    const next = fromSelectionItems(
      applySelection(
        toSelectionItemsMulti(documentRef.current.selection.objectIds, selectedNativeMoleculePartsRef.current),
        toSelectionItems(region.objectIds, region.nativeSelection),
        mode
      ),
      { includeNativePartHost: false, scope: "multi" }
    );
    replacePresentDocument((current) => selectDocumentObjects(current, current.pages[0].id, next.objectIds));
    setSelectedNativeMoleculeParts(next.nativeMoleculeParts);
    setActiveGraphicTransformObjectId(undefined);
    clearTransientInteractionChrome();
    if (next.objectIds.length === 0 && !next.nativeMoleculePart) {
      toolbarStyleTargetRef.current = undefined;
    }
    setSelectionMarquee(undefined);
    selectionMarqueeRef.current = null;
    setStatus(mode === "subtract"
      ? selectionSubtractStatusLabel(region)
      : selectionStatusLabel({ objectIds: next.objectIds, nativeSelection: next.nativeMoleculePart, nativeSelections: next.nativeMoleculeParts }));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, [
    activeToolState.activeCommandId,
    activeToolState.activeKind,
    clearNativePartDrag,
    clearObjectDrag,
    clearObjectRotateDrag,
    clearObjectResizeDrag,
    clearGraphicCornerRadiusDrag,
    clearGraphicGradientDrag,
    clearGraphicPathEditDrag,
    clearGraphicMarkerDrag,
    clearNativeFreehandArtDrag,
    clearBezierArtNodeDrag,
    clearProjectedPlaneTiltDrag,
    clearTransientInteractionChrome,
    clearNativePlacementDrag,
    clearTapeMeasureDrag,
    clearTextResize,
    commitGraphicCornerRadius,
    commitGraphicGradientDrag,
    commitGraphicPathEdit,
    commitGraphicMarkerDrag,
    commitNativeFreehandArtDrag,
    commitNativePlacementDrag,
    commitNativePartDrag,
    commitDocumentChange,
    commitTextResize,
    commitObjectDrag,
    commitObjectRotateDrag,
    commitObjectResize,
    commitProjectedPlaneTilt,
    cycleNativeBondOrder,
    updateBezierArtNodeDrag,
    document.pages,
    groupProjectedPlaneTiltFromDrag,
    groupTransformDocument,
    commitDocumentHistoryFrom,
    pageRulerUnit,
    pagePointFromPointerEvent,
    replacePresentDocument
  ]);

  const handlePagePointerCancel = useCallback((event: ObjectPointerEvent) => {
    const tapeMeasureDrag = tapeMeasureDragRef.current;
    if (tapeMeasureDrag?.pointerId === event.pointerId) {
      setTapeMeasure(undefined);
      clearTapeMeasureDrag(event);
      setStatus("Measurement canceled");
      return;
    }

    const groupTransform = groupTransformDragRef.current;
    if (groupTransform?.pointerId === event.pointerId) {
      if (groupTransform.dragging) {
        replacePresentDocument(groupTransform.startDocument);
      }
      if (groupTransform.mode === "projected-plane-tilt") {
        setStatus("3D rotate canceled");
      }
      groupTransformDragRef.current = null;
      groupTransformMachineRef.current = initialInteractionState();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }

    const textResize = textResizeRef.current;
    if (textResize?.pointerId === event.pointerId) {
      replacePresentDocument(textResize.startDocument);
      clearTextResize(event);
    }

    const projectedPlaneTiltDrag = projectedPlaneTiltDragRef.current;
    if (projectedPlaneTiltDrag?.pointerId === event.pointerId) {
      projectedPlaneTiltMachineRef.current = initialInteractionState();
      if (projectedPlaneTiltDrag.dragging) {
        replacePresentDocument(projectedPlaneTiltDrag.startDocument);
      }
      setSelectedNativeMoleculePart(projectedPlaneTiltDrag.target);
      clearProjectedPlaneTiltDrag(event);
      setProjectedPlaneTiltReadout(undefined);
      setStatus("3D rotate canceled");
    }

    const objectRotateDrag = objectRotateDragRef.current;
    if (objectRotateDrag?.pointerId === event.pointerId) {
      objectRotateMachineRef.current = initialInteractionState();
      if (objectRotateDrag.dragging) {
        replacePresentDocument(objectRotateDrag.startDocument);
      }
      clearObjectRotateDrag(event);
    }

    const graphicPathEditDrag = graphicPathEditDragRef.current;
    if (graphicPathEditDrag?.pointerId === event.pointerId) {
      if (graphicPathEditDrag.dragging) {
        replacePresentDocument(graphicPathEditDrag.startDocument);
      }
      clearGraphicPathEditDrag(event);
    }

    const graphicMarkerDrag = graphicMarkerDragRef.current;
    if (graphicMarkerDrag?.pointerId === event.pointerId) {
      if (graphicMarkerDrag.dragging) {
        replacePresentDocument(graphicMarkerDrag.startDocument);
      }
      clearGraphicMarkerDrag(event);
    }

    const graphicGradientDrag = graphicGradientDragRef.current;
    if (graphicGradientDrag?.pointerId === event.pointerId) {
      if (graphicGradientDrag.dragging) {
        replacePresentDocument(graphicGradientDrag.startDocument);
      }
      clearGraphicGradientDrag(event);
    }

    const nativePartDrag = nativePartDragRef.current;
    if (nativePartDrag?.pointerId === event.pointerId && nativePartDrag.dragging) {
      replacePresentDocument(nativePartDrag.startDocument);
      clearNativePartDrag(event);
    }

    const nativePlacementDrag = nativePlacementDragRef.current;
    if (nativePlacementDrag?.pointerId === event.pointerId) {
      placementMachineRef.current = initialInteractionState();
      replacePresentDocument(nativePlacementDrag.startDocument);
      clearNativePlacementDrag(event);
    }

    const freehandArtDrag = freehandArtDragRef.current;
    if (freehandArtDrag?.pointerId === event.pointerId) {
      replacePresentDocument(freehandArtDrag.startDocument);
      clearNativeFreehandArtDrag(event);
      setStatus(freehandArtStatusLabel(freehandArtDrag.commandId));
    }

    const lasso = selectionLassoRef.current;
    if (lasso?.pointerId === event.pointerId) {
      lassoMachineRef.current = initialInteractionState();
      selectionLassoRef.current = null;
      setSelectionLasso(undefined);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }

    const marquee = selectionMarqueeRef.current;
    if (marquee?.pointerId === event.pointerId) {
      marqueeMachineRef.current = initialInteractionState();
      selectionMarqueeRef.current = null;
      setSelectionMarquee(undefined);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, [clearGraphicGradientDrag, clearGraphicPathEditDrag, clearGraphicMarkerDrag, clearNativeFreehandArtDrag, clearNativePartDrag, clearNativePlacementDrag, clearObjectRotateDrag, clearProjectedPlaneTiltDrag, clearTapeMeasureDrag, clearTextResize, replacePresentDocument]);

  const handlePagePointerLeave = useCallback(() => {
    if (nativeBondDragRef.current) {
      return;
    }

    if (nativePlacementDragRef.current) {
      return;
    }

    if (selectionMarqueeRef.current) {
      return;
    }

    if (selectionLassoRef.current) {
      return;
    }

    if (tapeMeasureDragRef.current) {
      return;
    }

    setHoveredNativeAtom(undefined);
    assignHoveredNativeDeleteTarget(undefined);
  }, []);

  const handleObjectPointerDown = useCallback((objectId: string, event: ObjectPointerEvent) => {
    if (event.button !== 0) {
      return;
    }

    const point = pagePointFromPointerEvent(event);
    // Slice 1b: resolve the press by geometry, not by whichever overlapping wrapper the
    // browser happened to deliver the event to. A molecule's rectangular wrapper otherwise
    // swallows a press meant for a molecule beneath it (the rotaxane-overlap bug: hover
    // highlights the lower atom in red but the press selects nothing). This mirrors the hover
    // hit path so click and hover can never disagree. We only re-target among molecules — a
    // press the DOM delivered to a non-molecule object (text, charge mark) is never hijacked —
    // and we move pointer capture to the resolved molecule's wrapper so every drag/up handler
    // (all keyed by objectId) stays consistent with the re-targeted object.
    let captureElement: Element = event.currentTarget;
    if (point && findDocumentObject(document, objectId)?.type === "molecule") {
      const resolved = nativeMoleculeCanvasHoverTarget(
        document,
        point,
        event.target,
        hitToleranceForScale(viewportRef.current.scale)
      );
      if (resolved && resolved.objectId !== objectId) {
        objectId = resolved.objectId;
        const resolvedWrapper = pageRef.current?.querySelector(`[data-object-id="${CSS.escape(objectId)}"]`);
        if (resolvedWrapper) {
          captureElement = resolvedWrapper;
        }
      }
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const selectableObjectId = activeToolState.activeKind === "selection"
      ? selectableDocumentObjectIdForPointer(currentDocument, objectId)
      : objectId;
    const groupedPointerObjectIds = activeToolState.activeKind === "selection"
      ? groupedDragObjectIdsForPointer(currentDocument, objectId)
      : undefined;
    const chargeMarkActive = object?.type === "electron-mark" && object.markKind === "charge";
    const nativeMoleculeHit = object?.type === "molecule" && point
      ? nativeMoleculeHitFromPointerTarget(
          object,
          point,
          event.target,
          hitToleranceForScale(viewportRef.current.scale)
        )
      : undefined;
    const nativeMoleculeRingHit = ringInspectorOpen && object?.type === "molecule" && point && !nativeMoleculeHit
      ? nativeMoleculeRingSelectionFromPointerTarget(object, event.target, point)
      : undefined;
    const selectionShiftActive = event.shiftKey || event.getModifierState("Shift") || shiftKeyPressedRef.current;

    if (activeToolState.activeCommandId === "tool.art.measure" && point) {
      startTapeMeasureDrag(event, point);
      return;
    }

    if (activeToolState.activeCommandId === "tool.art.scissors" && point) {
      event.preventDefault();
      event.stopPropagation();
      if (object?.type !== "graphic") {
        setStatus(scissorsStatusLabel());
        return;
      }

      const splitPoint = nativeGraphicPathEditPointFromProjectedDrag(currentDocument, objectId, point);
      const split = splitNativeGraphicPathSegmentAtPoint(currentDocument, objectId, splitPoint, {
        maxDistancePx: Math.max(2, 10 / viewportRef.current.scale)
      });
      if (!split) {
        setStatus(scissorsStatusLabel("click closer to path"));
        return;
      }

      const splitObject = findDocumentObject(split.document, objectId);
      const splitNodeIndex = splitObject?.type === "graphic" && Array.isArray(splitObject.data.pathNodes)
        ? splitObject.data.pathNodes.findIndex((node) =>
            Math.hypot(node.point.x - split.point.x, node.point.y - split.point.y) < 0.1
          )
        : -1;

      commitDocumentChange(split.document);
      clearTransientInteractionChrome();
      setSelectedGraphicPathNode(splitNodeIndex >= 0 ? { objectId, nodeIndex: splitNodeIndex } : undefined);
      setSelectedNativeMoleculePart(undefined);
      setActiveEditorObjectId(undefined);
      setActiveTextEditObjectId(undefined);
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setFreeformNativeBond(undefined);
      setNativeDoubleBondSidePreview(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      setStatus(scissorsStatusLabel("node added"));
      return;
    }

    if (activeNativeArtTool?.commandId === "tool.art.polyline" && point) {
      event.preventDefault();
      event.stopPropagation();
      startOrAppendNativePathArtPoint(point, activeNativeArtTool.commandId, "polyline", { finish: event.detail >= 2 });
      return;
    }

    if (activeNativeArtTool?.commandId === "tool.art.pen" && point) {
      event.preventDefault();
      event.stopPropagation();
      startOrAppendNativePathArtPoint(point, activeNativeArtTool.commandId, "bezier", {
        currentTarget: event.currentTarget,
        finish: event.detail >= 2,
        pointerId: event.pointerId
      });
      return;
    }

    if (activeNativeArtTool && nativeArtToolIsFreehand(activeNativeArtTool.commandId) && point) {
      event.preventDefault();
      event.stopPropagation();
      startNativeFreehandArtDrag(event, point, activeNativeArtTool.commandId);
      return;
    }

    // Plain art shapes — including the orbital tools — must place over existing objects too.
    // Drawing a lobe onto a structure is the whole point of the orbital toolbar, and without this
    // the object handler stops the event and the press does nothing.
    if (activeNativeArtTool && point) {
      event.preventDefault();
      event.stopPropagation();
      applyNativeArtDocumentAtPoint(point, activeNativeArtTool.commandId);
      return;
    }

    if (activeToolState.activeCommandId === "tool.eraser") {
      event.preventDefault();
      event.stopPropagation();
      const nativeTarget = object?.type === "molecule" && nativeMoleculeHit
        ? { objectId, ...nativeMoleculeHit }
        : undefined;
      if (object?.type === "molecule" && !nativeTarget) {
        setStatus("No atom or bond to erase");
        return;
      }
      eraseDocumentObjectTarget(object, nativeTarget);
      return;
    }

    if (activeChargeToolValue && point && !chargeMarkActive) {
      event.stopPropagation();
      if (nativeMoleculeHit?.kind === "atom") {
        addChargeToHoveredNativeAtom(activeChargeToolValue, { objectId, ...nativeMoleculeHit });
        return;
      }

      applyChargeDocumentAtPoint(activeChargeToolValue, point);
      return;
    }

    // Reaction arrows commonly start on top of a reagent, so they need the same branch the page
    // handler has; the object handler stops propagation before the page ever sees the press.
    {
      const arrowKind = reactionArrowKindForToolCommand(activeToolState.activeCommandId);
      if (arrowKind && point) {
        event.preventDefault();
        event.stopPropagation();
        if (!startNativePlacementDrag(event, point, { kind: "arrow", arrowKind })) {
          const nextDocument = applyReactionArrowToolAtPoint(documentRef.current, point, arrowKind);
          if (nextDocument !== documentRef.current) {
            commitDocumentChange(nextDocument);
            setStatus(`Inserted ${nativeReactionArrowStatusLabel(arrowKind)} arrow`);
          }
        }
        return;
      }
    }

    if (
      activeToolState.activeCommandId === "tool.chain" &&
      object?.type === "molecule" &&
      point &&
      nativeMoleculeHit?.kind === "atom"
    ) {
      event.preventDefault();
      event.stopPropagation();
      const started = startNativePlacementDrag(event, point, {
        kind: "chain",
        anchor: { objectId, atomId: nativeMoleculeHit.atomId }
      });
      if (!started) {
        // The press was consumed — stopPropagation above means no other handler will answer for it.
        // Without this the tool looks broken: the user presses an atom, nothing happens, and nothing
        // says why. Usually full valence; also a molecule whose graph this build cannot edit, which
        // is why the wording does not commit to a single cause.
        setStatus("Can't grow a chain from that atom");
      }
      return;
    }

    {
      const bracketKind = bracketKindForToolCommand(activeToolState.activeCommandId);
      if (bracketKind && point) {
        event.preventDefault();
        event.stopPropagation();
        applyBracketAtPoint(point, bracketKind);
        return;
      }
    }

    {
      const symbolGlyph = symbolGlyphForToolCommand(activeToolState.activeCommandId);
      if (symbolGlyph && point) {
        event.preventDefault();
        event.stopPropagation();
        applySymbolGlyphAtPoint(point, symbolGlyph);
        return;
      }
    }

    if (activeToolState.activeCommandId === "tool.atom" && object?.type === "molecule" && point) {
      if (nativeMoleculeHit?.kind === "atom") {
        event.stopPropagation();
        startAtomLabelEdit({ objectId, ...nativeMoleculeHit }, { clearDraft: true });
        return;
      }
      event.stopPropagation();
      setStatus("Atom Label Tool: click an atom to edit its label");
      return;
    }

    if (activeToolState.activeCommandId === "tool.text" && object?.type === "text") {
      event.stopPropagation();
      replacePresentDocument((current) => selectDocumentObject(current, objectId));
      restoreToolAfterTextPlacement();
      setActiveEditorObjectId(undefined);
      setActiveTextEditObjectId(objectId);
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setSelectedNativeMoleculePart(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      setFreeformNativeBond(undefined);
      return;
    }

    if (activeToolState.activeCommandId === "tool.text" && object?.type === "molecule" && point) {
      if (nativeMoleculeHit?.kind === "atom") {
        event.stopPropagation();
        startAtomLabelEdit({ objectId, ...nativeMoleculeHit }, { clearDraft: true });
        return;
      }
    }

    if (activeNativeTemplateId && point) {
      event.preventDefault();
      event.stopPropagation();
      // Commit the highlighted target (parity), not a fresh per-object recompute whose DOM
      // tiebreak can flip a bond-hover into an atom and silently spiro instead of fusing.
      const templateTarget = currentTemplateTargetFromHoverOrHit(
        document,
        { pagePoint: point, toolCommandId: activeToolState.activeCommandId, templateId: activeNativeTemplateId },
        templateHoverTargetRef.current,
        viewportRef.current.scale
      );
      applyNativeTemplateDocumentAtPoint(point, activeNativeTemplateId, templateTarget);
      return;
    }

    if (activeNativeBondDisplayStyle && object?.type === "molecule" && point && nativeMoleculeHit?.kind === "bond") {
      event.preventDefault();
      event.stopPropagation();
      applyNativeBondDisplayStyleDocumentTarget({ objectId, ...nativeMoleculeHit }, activeNativeBondDisplayStyle);
      return;
    }

    if (activeToolState.activeCommandId === "tool.art.eyedropper") {
      event.preventDefault();
      event.stopPropagation();
      if (object?.type !== "graphic") {
        setStatus(currentEyedropperStatus);
        return;
      }

      const selectedGraphicIds = selectedGraphicObjectIds(currentDocument);
      if (selectedGraphicIds.length === 0) {
        replacePresentDocument((current) => selectDocumentObject(current, objectId));
        clearTransientInteractionChrome();
        setSelectedNativeMoleculePart(undefined);
        setSelectedGraphicPathNode(undefined);
        setActiveGraphicTransformObjectId(undefined);
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
        flashArtPaintTargetControls();
        setStatus(eyedropperStatusLabel(effectiveArtPaintTarget));
        return;
      }

      const targetIds = selectedGraphicIds.filter((selectedObjectId) => selectedObjectId !== objectId);
      if (targetIds.length === 0) {
        flashArtPaintTargetControls();
        setStatus(eyedropperSameTargetStatusLabel(effectiveArtPaintTarget));
        return;
      }

      const copied = applyGraphicObjectEyedropperToSelection(
        document,
        objectId,
        effectiveArtPaintTarget,
        { fullAppearance: event.altKey },
        targetIds
      );
      if (copied === document) {
        setStatus("Art appearance unchanged");
        return;
      }

      commitDocumentChange(copied);
      clearTransientInteractionChrome();
      setSelectedNativeMoleculePart(undefined);
      setActiveEditorObjectId(undefined);
      setActiveTextEditObjectId(undefined);
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setFreeformNativeBond(undefined);
      setNativeDoubleBondSidePreview(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      setStatus(event.altKey
        ? "Copied full art appearance"
        : effectiveArtPaintTarget === "fill" ? "Copied art fill" : "Copied art stroke");
      return;
    }

    if (activeToolState.activeCommandId === "tool.eraser" && object) {
      event.preventDefault();
      event.stopPropagation();
      let nextDocument = document;
      let status = "Deleted object";
      if (object.type === "molecule") {
        if (!nativeMoleculeHit) {
          setStatus("No atom or bond under eraser");
          return;
        }
        nextDocument = applyNativeMoleculeDeleteTarget(document, { objectId, ...nativeMoleculeHit });
        status = nativeMoleculeHit.kind === "atom"
          ? "Deleted carbon atom"
          : nativeMoleculeHit.terminalAtomId ? "Deleted terminal carbon" : "Deleted carbon bond";
      } else {
        nextDocument = applyPatches(
          document,
          [{ op: "removeObject", objectId }]
        );
        status = object.type === "graphic"
          ? "Deleted art object"
          : object.type === "text" ? "Deleted text object" : "Deleted object";
      }

      if (nextDocument === document) {
        setStatus("Nothing to erase");
        return;
      }

      commitDocumentChange(nextDocument);
      toolbarStyleTargetRef.current = undefined;
      clearTransientInteractionChrome();
      setSelectedNativeMoleculePart(undefined);
      setStatus(status);
      return;
    }

    if (
      activeToolState.activeKind === "selection" &&
      object &&
      object.type !== "molecule" &&
      selectableObjectId !== objectId &&
      !currentDocument.selection.objectIds.includes(objectId)
    ) {
      const press = { time: Date.now(), x: event.clientX, y: event.clientY, objectId };
      const doublePress = event.detail >= 2 || isSelectionDoublePress(lastSelectionPressRef.current, press);
      if (doublePress) {
        lastSelectionPressRef.current = press;
        event.preventDefault();
        event.stopPropagation();
        replacePresentDocument((current) => selectDocumentObjectWithinGroup(current, objectId));
        clearTransientInteractionChrome();
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveGraphicTransformObjectId(undefined);
        setSelectedGraphicPathNode(undefined);
        setActiveAtomLabelEdit(undefined);
        hoveredNativeAtomPointRef.current = undefined;
        setHoveredNativeAtom(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
        setSelectedNativeMoleculePart(undefined);
        setStatus("Selected grouped object");
        return;
      }
    }

    if (activeToolState.activeKind === "selection" && object?.type === "molecule" && point) {
      event.preventDefault();
      const pressPartKey = nativeMoleculeHit
        ? `${nativeMoleculeHit.kind}:${nativeMoleculeHit.kind === "atom" ? nativeMoleculeHit.atomId : nativeMoleculeHit.bondId}`
        : nativeMoleculeRingHit
          ? `ring:${nativeMoleculeRingHit.ringKey}`
          : undefined;
      const press = { time: Date.now(), x: event.clientX, y: event.clientY, objectId, partKey: pressPartKey };
      const selectionMode = selectionModeFromEvent(event, {
        gesture: "click",
        shiftFallback: shiftKeyPressedRef.current
      });
      // A double-press selects the WHOLE molecule (or drills into a grouped child). Two presses on
      // the same part count even when a tiny low-zoom molecule spans more than the screen-distance
      // fallback. A spatially tight pair also counts when selection-layer redraw or pointer jitter
      // makes the two presses resolve to adjacent parts of the same dense molecule. A press on a
      // genuinely different, farther-away ring remains an ordinary replacement selection.
      const previousPress = lastSelectionPressRef.current;
      const sameObjectAsPreviousPress = previousPress?.objectId === objectId;
      const samePartAsPreviousPress = sameObjectAsPreviousPress
        && previousPress?.partKey === pressPartKey;
      const rawDoublePress = event.detail >= 2 || isSelectionDoublePress(previousPress, press);
      const tightDoublePress = sameObjectAsPreviousPress && previousPress !== undefined
        && Math.hypot(press.x - previousPress.x, press.y - previousPress.y) <= DOUBLE_PRESS_SCREEN_PX;
      const doublePress = rawDoublePress && selectionMode !== "subtract"
        && (samePartAsPreviousPress || tightDoublePress);
      lastSelectionPressRef.current = press;
      if (object.type === "molecule" && doublePress) {
        event.stopPropagation();
        const drillIntoGroupedChild = selectableObjectId !== objectId;
        // Shift keeps the existing selection and unions this molecule in; a plain double-press
        // replaces. The union runs inside the updater so it survives the re-render between the two
        // presses (reading current committed state, not a possibly-stale ref).
        const joinSelection = selectionMode === "toggle";
        replacePresentDocument((current) => {
          if (drillIntoGroupedChild) {
            return selectDocumentObjectWithinGroup(current, objectId);
          }
          if (joinSelection) {
            return selectDocumentObjects(current, current.pages[0].id, [
              ...new Set([...current.selection.objectIds, selectableObjectId])
            ]);
          }
          return selectDocumentObject(current, selectableObjectId);
        });
        clearTransientInteractionChrome();
        setActiveGraphicTransformObjectId(undefined);
        hoveredNativeAtomPointRef.current = undefined;
        // The double-clicked molecule is now selected whole, so drop any native part(s) it held
        // (e.g. the bond the first press toggled on) while leaving other molecules' parts intact.
        setSelectedNativeMoleculeParts((current) =>
          current.filter((part) => part.objectId !== selectableObjectId && part.objectId !== objectId)
        );
        setStatus(drillIntoGroupedChild
          ? "Selected grouped molecule"
          : joinSelection
            ? "Added molecule to selection"
            : selectableObjectId === objectId ? "Selected molecule" : "Selected group");
        return;
      }

      if (selectionMode !== "replace") {
        // One additive path for every molecule pick. The press is reduced to a single selection
        // item — a grouped child resolves to its group object, otherwise the atom/bond/ring hit,
        // otherwise the whole molecule — and the shared policy decides toggle/add/subtract. Ring
        // interiors only resolve when the Rings toolbar is open (see nativeMoleculeRingHit).
        event.stopPropagation();
        // Phase 7: native parts are stored per molecule, so a part on a *different* molecule is
        // added as a part (not downgraded to a whole object). A grouped child still resolves to its
        // group object; otherwise the atom/bond/ring hit; otherwise the whole molecule. The shared
        // policy decides toggle/add/subtract over the full cross-molecule item set.
        const additiveItem: SelectionItem =
          selectableObjectId !== objectId
            ? { kind: "object", objectId: selectableObjectId }
            : nativeMoleculeHit?.kind === "atom"
              ? { kind: "atom", objectId, atomId: nativeMoleculeHit.atomId }
              : nativeMoleculeHit?.kind === "bond"
                ? { kind: "bond", objectId, bondId: nativeMoleculeHit.bondId }
                : nativeMoleculeRingHit
                  ? {
                      kind: "ring",
                      objectId,
                      ringKey: nativeMoleculeRingHit.ringKey,
                      atomIds: nativeMoleculeRingHit.atomIds,
                      bondIds: nativeMoleculeRingHit.bondIds
                    }
                  : { kind: "object", objectId: selectableObjectId };
        const nextSelection = fromSelectionItems(
          applySelection(
            toSelectionItemsMulti(documentRef.current.selection.objectIds, selectedNativeMoleculePartsRef.current),
            additiveItem,
            selectionMode
          ),
          { scope: "multi" }
        );
        replacePresentDocument((current) =>
          selectDocumentObjects(current, current.pages[0].id, nextSelection.objectIds)
        );
        clearTransientInteractionChrome();
        if (nativeMoleculeHit && additiveItem.kind !== "object") {
          assignHoveredNativeDeleteTarget({ objectId, ...nativeMoleculeHit });
          hoveredNativeAtomPointRef.current = nativeMoleculeHit.kind === "atom" ? { objectId, point } : undefined;
        } else {
          hoveredNativeAtomPointRef.current = undefined;
        }
        setSelectedNativeMoleculeParts(nextSelection.nativeMoleculeParts);
        setStatus(selectionStatusLabel({
          objectIds: nextSelection.objectIds,
          nativeSelection: nextSelection.nativeMoleculePart,
          nativeSelections: nextSelection.nativeMoleculeParts
        }));
        return;
      }

      const dragIntent = nativeMoleculeSelectionDragIntent(document, objectId, selectedNativeMoleculePart, nativeMoleculeHit);
      if (dragIntent.kind === "whole-object") {
        event.stopPropagation();
        const groupObjectIds = groupedPointerObjectIds;
        const selectedDocument = groupObjectIds && document.selection.objectIds.includes(selectableObjectId)
          ? document
          : groupObjectIds ? selectDocumentObject(document, selectableObjectId) : document;
        if (selectedDocument !== document) {
          replacePresentDocument(selectedDocument);
        }
        objectDragRef.current = {
          pointerId: event.pointerId,
          objectId,
          startDocument: selectedDocument,
          startPoint: point,
          latestPoint: point,
          startObjectX: object.x,
          startObjectY: object.y,
          groupObjectIds,
          artPreviewProxies: createArtTransformDragPreviewProxies(selectedDocument, groupObjectIds ?? [objectId], viewportRef.current.scale),
          dragging: false
        };
        captureElement.setPointerCapture(event.pointerId);
        return;
      }

      if (dragIntent.kind === "native-part") {
        event.stopPropagation();
        const selectedDocument = document.selection.objectIds.includes(objectId)
          ? document
          : selectDocumentObject(document, objectId);
        replacePresentDocument(selectedDocument);
        clearTransientInteractionChrome();
        setActiveGraphicTransformObjectId(undefined);
        hoveredNativeAtomPointRef.current = undefined;
        setSelectedNativeMoleculePart(dragIntent.target);
        nativePartDragRef.current = {
          pointerId: event.pointerId,
          objectId,
          target: dragIntent.target,
          startDocument: selectedDocument,
          startPoint: point,
          latestPoint: point,
          dragging: false
        };
        objectDragMachineRef.current = interactionReducer(initialInteractionState(), { type: "pointerDown", pointerId: event.pointerId, world: point, target: { kind: "object", objectId }, dragKind: "object-move" });
        (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
        setStatus(dragIntent.target.kind === "atom"
          ? "Selected atom"
          : dragIntent.target.kind === "bond" ? "Selected bond" : "Selected molecule parts");
        return;
      }

      if (nativeMoleculeHit) {
        event.stopPropagation();
        replacePresentDocument((current) => selectDocumentObject(current, objectId));
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveGraphicTransformObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget({ objectId, ...nativeMoleculeHit });
        hoveredNativeAtomPointRef.current = nativeMoleculeHit.kind === "atom" ? { objectId, point } : undefined;
        setSelectedNativeMoleculePart(nativeSelectionFromHit(objectId, nativeMoleculeHit));
        setStatus(nativeMoleculeHit.kind === "atom" ? "Selected atom" : "Selected bond");
        return;
      }

      if (nativeMoleculeRingHit) {
        event.stopPropagation();
        replacePresentDocument((current) => selectDocumentObject(current, objectId));
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveGraphicTransformObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
        hoveredNativeAtomPointRef.current = undefined;
        setSelectedNativeMoleculePart(nativeMoleculeRingHit);
        setStatus("Selected ring");
        return;
      }

      return;
    }

    if (object?.type === "molecule" && point && !nativeMoleculeHit) {
      return;
    }

    if (
      activeToolState.activeKind === "selection" &&
      selectionShiftActive &&
      object &&
      shouldActivateDocumentObject(object, "selection")
    ) {
      event.preventDefault();
      event.stopPropagation();
      const nextDocument = toggleDocumentObjectSelection(document, document.pages[0].id, selectableObjectId);
      replacePresentDocument(nextDocument);
      clearTransientInteractionChrome();
      setSelectedNativeMoleculePart(undefined);
      setActiveEditorObjectId(undefined);
      setActiveTextEditObjectId(undefined);
      setActiveGraphicTransformObjectId(undefined);
      setSelectedGraphicPathNode(undefined);
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setFreeformNativeBond(undefined);
      setNativeDoubleBondSidePreview(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      setStatus(selectionStatusLabel({ objectIds: nextDocument.selection.objectIds }));
      return;
    }

    if (
      activeToolState.activeKind === "selection" &&
      object?.type === "graphic" &&
      graphicObjectHasDirectEditChrome(object, effectiveArtPaintTarget)
    ) {
      const press = { time: Date.now(), x: event.clientX, y: event.clientY, objectId };
      const doublePress = event.detail >= 2 || isSelectionDoublePress(lastSelectionPressRef.current, press);
      lastSelectionPressRef.current = press;
      if (doublePress) {
        event.preventDefault();
        event.stopPropagation();
        const selectedDocument = document.selection.objectIds.includes(objectId)
          ? document
          : selectDocumentObject(document, objectId);
        replacePresentDocument(selectedDocument);
        clearTransientInteractionChrome();
        setSelectedNativeMoleculePart(undefined);
        setActiveGraphicTransformObjectId(objectId);
        setStatus("Selected art object");
        return;
      }
    }

    if (shouldDragDocumentObject(object, activeToolState.activeKind)) {
      event.preventDefault();
      event.stopPropagation();
      if (!shouldActivateDocumentObject(object, "selection")) {
        return;
      }

      const groupObjectIds = groupedPointerObjectIds;
      const selectedDocument = groupObjectIds
        ? document.selection.objectIds.includes(selectableObjectId)
          ? document
          : selectDocumentObject(document, selectableObjectId)
        : document.selection.objectIds.includes(objectId)
          ? document
          : selectDocumentObject(document, selectableObjectId);
      replacePresentDocument(selectedDocument);
      setActiveEditorObjectId(undefined);
      setActiveTextEditObjectId(undefined);
      setActiveGraphicTransformObjectId((current) =>
        current === objectId && object?.type === "graphic" && graphicObjectHasDirectEditChrome(object, effectiveArtPaintTarget)
          ? current
          : undefined
      );
      setSelectedGraphicPathNode(undefined);
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setFreeformNativeBond(undefined);
      setNativeDoubleBondSidePreview(undefined);
      setSelectedNativeMoleculePart(undefined);
      assignHoveredNativeDeleteTarget(undefined);

      if (object && point) {
        objectDragRef.current = {
          pointerId: event.pointerId,
          objectId,
          startDocument: selectedDocument,
          startPoint: point,
          latestPoint: point,
          startObjectX: object.x,
          startObjectY: object.y,
          bondTarget: nativeMoleculeHit?.kind === "bond" ? { objectId, ...nativeMoleculeHit } : undefined,
          groupObjectIds,
          artPreviewProxies: createArtTransformDragPreviewProxies(selectedDocument, groupObjectIds ?? [objectId], viewportRef.current.scale),
          dragging: false
        };
        objectDragMachineRef.current = interactionReducer(initialInteractionState(), {
          type: "pointerDown",
          pointerId: event.pointerId,
          world: point,
          target: { kind: "object", objectId },
          dragKind: "object-move"
        });
        captureElement.setPointerCapture(event.pointerId);
      }
      return;
    }

    if (activeToolState.activeCommandId === "tool.bond" && object?.type === "molecule" && point) {
      if (nativeMoleculeHit?.kind === "bond") {
        event.stopPropagation();
        nativeBondEditDragRef.current = {
          pointerId: event.pointerId,
          objectId,
          target: { objectId, ...nativeMoleculeHit },
          startDocument: document,
          startPoint: point,
          latestPoint: point,
          dragging: false
        };
        captureElement.setPointerCapture(event.pointerId);
        return;
      }
    }

    if (activeNativeBondToolStyle && object?.type === "molecule") {
      event.stopPropagation();
      if (!point) {
        return;
      }

      const page = document.pages[0];
      const preview = previewNativeMoleculeBondGrowth(object, point, page.width, page.height);
      if (!preview) {
        applySingleBondDocumentAtPoint(selectDocumentObject(document, objectId), point, activeNativeBondDisplayStyle);
        return;
      }

      nativeBondDragRef.current = {
        pointerId: event.pointerId,
        objectId,
        atomId: preview.atomId,
        bondStyle: activeNativeBondDisplayStyle,
        startPoint: point,
        latestPoint: point,
        dragging: false,
        freeformUnlocked: false
      };
      captureElement.setPointerCapture(event.pointerId);
      setHoveredNativeAtom({
        objectId,
        atomId: preview.atomId,
        direction: preview.direction,
        candidateDirections: preview.candidateDirections,
        newAtomPoint: preview.newAtomPoint
      });
      setFreeformNativeBond(undefined);
      return;
    }

    event.stopPropagation();
    if (!shouldActivateDocumentObject(object, activeToolState.activeKind)) {
      return;
    }

    const activationObjectId =
      activeToolState.activeKind === "selection" && !document.selection.objectIds.includes(objectId)
        ? selectableObjectId
        : objectId;
    replacePresentDocument((current) => selectDocumentObject(current, activationObjectId));
    setActiveEditorObjectId(object?.type === "molecule" && activationObjectId === object.id ? object.id : undefined);
    setActiveTextEditObjectId(undefined);
    setActiveGraphicTransformObjectId(undefined);
    setSelectedGraphicPathNode(undefined);
    setActiveAtomLabelEdit(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
  }, [
    activeToolState.activeCommandId,
    activeToolState.activeKind,
    activeChargeToolValue,
    activeNativeArtTool,
    activeNativeBondDisplayStyle,
    activeNativeBondToolStyle,
    activeNativeTemplateId,
    addChargeToHoveredNativeAtom,
    assignHoveredNativeDeleteTarget,
    applyChargeDocumentAtPoint,
    applyBracketAtPoint,
    applyNativeArtDocumentAtPoint,
    applyNativeBondDisplayStyleDocumentTarget,
    applyNativeTemplateDocumentAtPoint,
    applySingleBondDocumentAtPoint,
    applySymbolGlyphAtPoint,
    clearTransientInteractionChrome,
    commitDocumentChange,
    currentEyedropperStatus,
    cycleNativeBondOrder,
    document,
    effectiveArtPaintTarget,
    flashArtPaintTargetControls,
    eraseDocumentObjectTarget,
    ringInspectorOpen,
    pagePointFromPointerEvent,
    replacePresentDocument,
    restoreToolAfterTextPlacement,
    selectedNativeMoleculePart,
    startAtomLabelEdit,
    startOrAppendNativePathArtPoint,
    startNativeFreehandArtDrag,
    startSelectionLasso,
    startTapeMeasureDrag,
    toggleDocumentObjectSelection
  ]);

  function isTransformHandleSecondPress(
    objectId: string,
    handleKind: TransformHandlePressKind,
    event: PointerEvent<HTMLButtonElement>
  ): boolean {
    const current = {
      time: Date.now(),
      x: event.clientX,
      y: event.clientY,
      objectId,
      handleKind
    };
    const isDouble = (event.detail ?? 0) >= 2 ||
      isTransformHandleDoublePress(lastTransformHandlePressRef.current, current);
    lastTransformHandlePressRef.current = current;
    return isDouble;
  }

  const openObjectRotateInput = useCallback((objectId: string): boolean => {
    if (activeToolState.activeKind !== "selection") {
      return false;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const selectedFragmentTarget = object?.type === "molecule" && selectedNativeMoleculePart?.objectId === objectId
      ? nativeTransformableSelectionPart(selectedNativeMoleculePart)
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    const canOpenRotationEntry = object && (
      object.type !== "molecule"
        ? documentObjectSupportsArtTransform(object) && currentDocument.selection.objectIds.includes(objectId)
        : isNativeMoleculeGraph(object) && (
            isWholeNativeMoleculeSelected(currentDocument, objectId, selectedNativeMoleculePart) ||
            selectedFragmentBounds !== undefined
          )
    );
    if (!canOpenRotationEntry) {
      setStatus("Select an object for rotation entry");
      return false;
    }
    if (selectedFragmentTarget) {
      setStatus("Double-click entry is available for whole molecules only");
      return false;
    }

    const targetLabel = selectedFragmentTarget
      ? "selected molecule fragment"
      : object.type === "molecule" ? "selected molecule" : "selected art object";
    const homeZDegrees = rotationInputDraftDegrees(
      object.type === "molecule" ? nativeMoleculeTransformState(object).rotationDegrees : object.rotation
    );
    setObjectRotateReadout(undefined);
    setProjectedPlaneTiltReadout(undefined);
    updateObjectResizeInput(undefined);
    updateRotationInput({
      kind: "z",
      objectId,
      target: selectedFragmentTarget,
      targetLabel,
      startDocument: currentDocument,
      draftZDegrees: homeZDegrees,
      homeZDegrees
    });
    setStatus("Z rotation entry");
    return true;
  }, [activeToolState.activeKind, selectedNativeMoleculePart, updateObjectResizeInput, updateRotationInput]);

  const handleObjectRotatePointerDown = useCallback((objectId: string, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    if (object && isTransformHandleSecondPress(objectId, "rotate-z", event)) {
      openObjectRotateInput(objectId);
      return;
    }
    const point = pagePointFromPointerEvent(event);
    const selectedFragmentTarget = object?.type === "molecule" && selectedNativeMoleculePart?.objectId === objectId
      ? nativeTransformableSelectionPart(selectedNativeMoleculePart)
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    const canRotateObject =
      object?.type === "text" ||
      (object !== undefined && documentObjectSupportsArtTransform(object) && currentDocument.selection.objectIds.includes(objectId)) ||
      (object?.type === "molecule" && (
        isWholeNativeMoleculeSelected(currentDocument, objectId, selectedNativeMoleculePart) ||
        selectedFragmentBounds !== undefined
      ));
    if (!object || !point || !canRotateObject) {
      return;
    }

    const selectedDocument = selectedFragmentTarget
      ? currentDocument
      : currentDocument.selection.objectIds.includes(objectId)
        ? currentDocument
        : selectDocumentObject(currentDocument, objectId);
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    replacePresentDocument(selectedDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(selectedFragmentTarget);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    objectRotateDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      target: selectedFragmentTarget,
      startDocument: selectedDocument,
      centerPoint: selectedFragmentBounds
        ? documentObjectCenter(selectedFragmentBounds)
        : object.type === "molecule" ? nativeMoleculeCenter(object) : documentObjectCenter(object),
      startPoint: point,
      startRotationDegrees: object.type === "molecule"
        ? selectedFragmentTarget ? 0 : nativeMoleculeTransformState(object).rotationDegrees
        : object.rotation,
      latestPoint: point,
      artPreviewProxies: createArtTransformDragPreviewProxies(selectedDocument, [objectId], viewportRef.current.scale),
      dragging: false,
      // Keep the stored conformer's orientation in sync when Z-rotating a modeled
      // whole molecule (whole-molecule only; fragments/text stay on the legacy path).
      spin3dModel: !selectedFragmentTarget && object.type === "molecule"
        ? spin3dRotateSnapshotFor(object)
        : undefined
    };
    objectRotateMachineRef.current = interactionReducer(initialInteractionState(), { type: "pointerDown", pointerId: event.pointerId, world: point, target: { kind: "object", objectId }, dragKind: "object-rotate" });
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(
      object.type === "text"
        ? "Rotate selected text box"
        : object.type === "molecule"
          ? selectedFragmentTarget ? "Rotate selected molecule fragment" : "Rotate selected molecule"
          : "Rotate selected art object"
    );
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    handleObjectResizeInputKeep,
    handleRotationInputKeep,
    pagePointFromPointerEvent,
    replacePresentDocument,
    openObjectRotateInput,
    selectedNativeMoleculePart,
    spin3dRotateSnapshotFor,
  ]);

  const handleObjectRotateDoubleClick = useCallback((objectId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openObjectRotateInput(objectId);
  }, [openObjectRotateInput]);

  const openProjectedPlaneTiltInput = useCallback((objectId: string): boolean => {
    if (activeToolState.activeKind !== "selection") {
      return false;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const selectedFragmentTarget = selectedNativeMoleculePart?.objectId === objectId
      ? nativeTransformableSelectionPart(selectedNativeMoleculePart)
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    const canOpenTiltEntry = object && (
      object.type !== "molecule"
        ? documentObjectSupportsArtTransform(object) && currentDocument.selection.objectIds.includes(objectId)
        : isNativeMoleculeGraph(object) && (
            isWholeNativeMoleculeSelected(currentDocument, objectId, selectedNativeMoleculePart) ||
            selectedFragmentBounds !== undefined
          )
    );
    if (!canOpenTiltEntry) {
      setStatus("Select an object for X/Y rotation entry");
      return false;
    }
    if (selectedFragmentTarget) {
      setStatus("Double-click entry is available for whole molecules only");
      return false;
    }

    const transform = object.type === "molecule"
      ? nativeMoleculeTransformState(object)
      : {
          ...documentObjectProjectedPlaneTilt(object),
          rotationDegrees: object.rotation
        };
    const targetLabel = selectedFragmentTarget
      ? "selected molecule fragment"
      : object.type === "molecule" ? "selected molecule" : "selected art object";
    const modeledRotationEntry = !selectedFragmentTarget && object.type === "molecule"
      ? (() => {
          const model = validSpin3dModelFor(object);
          return model !== undefined && spin3dModelCoordsForMolecule(model, object) !== undefined;
        })()
      : false;
    const homeXDegrees = rotationInputDraftDegrees(modeledRotationEntry ? 0 : selectedFragmentTarget ? 0 : transform.tiltXDegrees ?? 0);
    const homeYDegrees = rotationInputDraftDegrees(modeledRotationEntry ? 0 : selectedFragmentTarget ? 0 : transform.tiltYDegrees ?? 0);
    setObjectRotateReadout(undefined);
    setProjectedPlaneTiltReadout(undefined);
    updateObjectResizeInput(undefined);
    updateRotationInput({
      kind: "xy",
      objectId,
      target: selectedFragmentTarget,
      targetLabel,
      startDocument: currentDocument,
      draftXDegrees: homeXDegrees,
      draftYDegrees: homeYDegrees,
      homeXDegrees,
      homeYDegrees
    });
    setStatus("3D rotation entry");
    return true;
  }, [activeToolState.activeKind, selectedNativeMoleculePart, updateObjectResizeInput, updateRotationInput]);

  const handleProjectedPlaneTiltPointerDown = useCallback((objectId: string, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    if (object?.type === "graphic" && graphicObjectIsFreehandPath(object)) {
      setStatus("X/Y rotate is disabled for freehand art while transform previews are optimized");
      return;
    }
    if (object && isTransformHandleSecondPress(objectId, "rotate-xy", event)) {
      openProjectedPlaneTiltInput(objectId);
      return;
    }
    const point = pagePointFromPointerEvent(event);
    const selectedFragmentTarget = selectedNativeMoleculePart?.objectId === objectId
      ? nativeTransformableSelectionPart(selectedNativeMoleculePart)
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    const canTiltObject = object && point && (
      object.type !== "molecule"
        ? documentObjectSupportsArtTransform(object) && currentDocument.selection.objectIds.includes(objectId)
        : isNativeMoleculeGraph(object) &&
          object.atoms.length > 0 &&
          (
            isWholeNativeMoleculeSelected(currentDocument, objectId, selectedNativeMoleculePart) ||
            selectedFragmentBounds !== undefined
          )
    );
    if (!canTiltObject || !object || !point) {
      setStatus("Select an object for X/Y rotate");
      return;
    }

    const selectedDocument = selectedFragmentTarget
      ? currentDocument
      : currentDocument.selection.objectIds.includes(objectId)
        ? currentDocument
        : selectDocumentObject(currentDocument, objectId);
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    replacePresentDocument(selectedDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(selectedFragmentTarget);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setProjectedPlaneTiltReadout(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    const transform = object.type === "molecule"
      ? nativeMoleculeTransformState(object)
      : {
          ...documentObjectProjectedPlaneTilt(object),
          rotationDegrees: object.rotation
        };
    const startTiltXRad = selectedFragmentTarget
      ? 0
      : (transform.tiltXDegrees ?? 0) * Math.PI / 180;
    const startTiltYRad = selectedFragmentTarget
      ? 0
      : (transform.tiltYDegrees ?? 0) * Math.PI / 180;
    const startRotationDegrees = selectedFragmentTarget ? 0 : transform.rotationDegrees;
    // Whole molecule with a stored Spin 3D model → rotate the real conformer (v1 is
    // whole-molecule only; fragments stay on the legacy projected-plane tilt).
    const spin3dModel = !selectedFragmentTarget && object.type === "molecule"
      ? spin3dRotateSnapshotFor(object)
      : undefined;
    projectedPlaneTiltDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      target: selectedFragmentTarget,
      startDocument: selectedDocument,
      centerPoint: selectedFragmentBounds
        ? documentObjectCenter(selectedFragmentBounds)
        : object.type === "molecule" ? nativeMoleculeCenter(object) : documentObjectCenter(object),
      axisAngleRad: 0,
      startPoint: point,
      startTiltXRad,
      startTiltYRad,
      startRotationDegrees,
      latestPoint: point,
      latestTiltXRad: startTiltXRad,
      latestTiltYRad: startTiltYRad,
      clamped: false,
      dragging: false,
      spin3dModel,
      lastValidPreviewDocument: selectedDocument,
      lastValidOrientation: spin3dModel?.startOrientation
    };
    projectedPlaneTiltMachineRef.current = interactionReducer(initialInteractionState(), {
      type: "pointerDown",
      pointerId: event.pointerId,
      world: point,
      target: { kind: "object", objectId },
      dragKind: "projected-plane-tilt"
    });
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(selectedFragmentTarget
      ? "3D rotate: drag to tilt/twist selected fragment"
      : object.type === "molecule" ? "3D rotate: drag to tilt/twist" : "X/Y rotate selected art object");
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    handleObjectResizeInputKeep,
    handleRotationInputKeep,
    pagePointFromPointerEvent,
    openProjectedPlaneTiltInput,
    replacePresentDocument,
    selectedNativeMoleculePart,
    spin3dRotateSnapshotFor,
  ]);

  const handleProjectedPlaneTiltDoubleClick = useCallback((objectId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openProjectedPlaneTiltInput(objectId);
  }, [openProjectedPlaneTiltInput]);

  const openObjectResizeInput = useCallback((objectId: string, corner: ObjectResizeCorner): boolean => {
    if (activeToolState.activeKind !== "selection") {
      return false;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const selectedFragmentTarget = selectedNativeMoleculePart?.objectId === objectId
      ? nativeTransformableSelectionPart(selectedNativeMoleculePart)
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    const canOpenResizeEntry = object && (
      object.type !== "molecule"
        ? documentObjectSupportsArtTransform(object) && currentDocument.selection.objectIds.includes(objectId)
        : isNativeMoleculeGraph(object) && (
            isWholeNativeMoleculeSelected(currentDocument, objectId, selectedNativeMoleculePart) ||
            selectedFragmentBounds !== undefined
          )
    );
    if (!canOpenResizeEntry) {
      setStatus("Select an object for stretch entry");
      return false;
    }
    if (selectedFragmentTarget) {
      setStatus("Double-click entry is available for whole molecules only");
      return false;
    }

    const transform = object.type === "molecule" ? nativeMoleculeTransformState(object) : undefined;
    const targetLabel = selectedFragmentTarget
      ? "selected molecule fragment"
      : object.type === "molecule" ? "selected molecule" : "selected art object";
    const homeXPercent = objectResizeInputDraftPercent(selectedFragmentTarget ? 1 : transform?.scaleX ?? 1);
    const homeYPercent = objectResizeInputDraftPercent(selectedFragmentTarget ? 1 : transform?.scaleY ?? 1);
    updateRotationInput(undefined);
    setObjectResizeReadout(undefined);
    updateObjectResizeInput({
      objectId,
      target: selectedFragmentTarget,
      targetLabel,
      corner,
      startDocument: currentDocument,
      draftXPercent: homeXPercent,
      draftYPercent: homeYPercent,
      homeXPercent,
      homeYPercent
    });
    setStatus("Stretch entry");
    return true;
  }, [activeToolState.activeKind, selectedNativeMoleculePart, updateObjectResizeInput, updateRotationInput]);

  const handleGraphicCornerRadiusPointerDown = useCallback((objectId: string, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can be unavailable if the browser has already canceled the press.
    }

    const point = pagePointFromPointerEvent(event);
    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const editPoint = object?.type === "graphic" ? nativeGraphicCornerRadiusEditPoint(object) : undefined;
    if (!point || object?.type !== "graphic" || !editPoint) {
      return;
    }

    const selectedDocument = currentDocument.selection.objectIds.includes(objectId)
      ? currentDocument
      : selectDocumentObject(currentDocument, objectId);
    replacePresentDocument(selectedDocument);
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setGraphicCornerRadiusReadout({
      objectId,
      radius: graphicCornerRadiusReadoutValue(object)
    });
    graphicCornerRadiusDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      startDocument: selectedDocument,
      startPoint: point,
      latestPoint: point,
      dragging: false
    };
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus("Adjust selected rectangle corner radius");
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    handleObjectResizeInputKeep,
    handleRotationInputKeep,
    pagePointFromPointerEvent,
    replacePresentDocument
  ]);

  const handleGraphicCornerRadiusDoubleClick = useCallback((objectId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (activeToolState.activeKind !== "selection") {
      return;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    if (object?.type !== "graphic" || !nativeGraphicCornerRadiusEditPoint(object)) {
      return;
    }

    const selectedDocument = currentDocument.selection.objectIds.includes(objectId)
      ? currentDocument
      : selectDocumentObject(currentDocument, objectId);
    const currentRadius = graphicCornerRadiusReadoutValue(object);
    const nextRadius = currentRadius <= 0.001 ? maxGraphicCornerRadius(object) : 0;
    const edited = updateNativeGraphicCornerRadius(selectedDocument, objectId, { x: nextRadius, y: 0 });
    if (edited === selectedDocument) {
      replacePresentDocument(selectedDocument);
      setStatus("Corner radius unchanged");
      return;
    }

    commitDocumentHistoryFrom(selectedDocument, edited);
    setGraphicCornerRadiusReadout({
      objectId,
      radius: nextRadius
    });
    setStatus(nextRadius <= 0.001 ? "Reset corner radius" : "Maxed corner radius");
  }, [activeToolState.activeKind, commitDocumentHistoryFrom, replacePresentDocument]);

  const handleGraphicPathEditPointerDown = useCallback((
    objectId: string,
    handle: NativeGraphicPathEditHandle,
    event: PointerEvent<Element>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can be unavailable if the browser has already canceled the press.
    }

    const point = pagePointFromPointerEvent(event);
    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const editPoints = object?.type === "graphic" ? nativeGraphicPathEditPoints(object) : undefined;
    const nodeEditPoints = object?.type === "graphic" ? nativeGraphicPathNodeEditPoints(object) : undefined;
    if (!point || object?.type !== "graphic" || (!editPoints && !nodeEditPoints)) {
      return;
    }

    if (activeToolState.activeCommandId === "tool.eraser") {
      const nodeMatch = /^node:(\d+)$/.exec(handle);
      const segmentMatch = /^segment:(\d+)$/.exec(handle);
      if ((!nodeMatch && !segmentMatch) || !nodeEditPoints) {
        setStatus("Eraser: click path node or segment; drag clears touched objects; Esc exits");
        return;
      }

      const nextDocument = nodeMatch
        ? deleteNativeGraphicPathNode(currentDocument, objectId, Number.parseInt(nodeMatch[1], 10))
        : deleteNativeGraphicPathSegment(currentDocument, objectId, Number.parseInt(segmentMatch?.[1] ?? "-1", 10));
      if (nextDocument === currentDocument) {
        setStatus(nodeMatch
          ? "Eraser: no path node hit; click node or segment; Esc exits"
          : "Eraser: use end segment on open path; click node or segment; Esc exits");
        return;
      }

      commitDocumentChange(nextDocument);
      toolbarStyleTargetRef.current = undefined;
      clearTransientInteractionChrome();
      setSelectedNativeMoleculePart(undefined);
      setStatus(findDocumentObject(nextDocument, objectId)
        ? nodeMatch
          ? "Eraser: node deleted; click node or segment; Esc exits"
          : "Eraser: segment deleted; click node or segment; Esc exits"
        : "Eraser: path deleted; click or drag to erase; Esc exits");
      return;
    }

    const selectedDocument = currentDocument.selection.objectIds.includes(objectId)
      ? currentDocument
      : selectDocumentObject(currentDocument, objectId);
    replacePresentDocument(selectedDocument);
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    const selectedNodeIndex = nodeEditPoints ? graphicPathNodeIndexFromEditHandle(handle) : undefined;
    setSelectedGraphicPathNode(selectedNodeIndex === undefined
      ? undefined
      : { objectId, nodeIndex: selectedNodeIndex });
    graphicPathEditDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      handle,
      startDocument: selectedDocument,
      workingDocument: selectedDocument,
      startPoint: point,
      latestPoint: point,
      dragging: false
    };
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(
      nodeEditPoints
        ? "Move selected path node"
        : editPoints && isSemanticCircularGraphicArc(object, editPoints)
          ? handle === "middle" ? "Adjust selected arc radius" : "Adjust selected arc sweep"
          : handle === "middle" ? "Bend selected line into a curve" : "Adjust selected line endpoint"
    );
  }, [
    activeToolState.activeKind,
    activeToolState.activeCommandId,
    assignHoveredNativeDeleteTarget,
    clearTransientInteractionChrome,
    commitDocumentChange,
    handleObjectResizeInputKeep,
    handleRotationInputKeep,
    pagePointFromPointerEvent,
    replacePresentDocument
  ]);

  const handleGraphicMarkerPointerDown = useCallback((
    objectId: string,
    markerId: NativeGraphicMarkerHandleId,
    event: PointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can be unavailable if the browser has already canceled the press.
    }

    const point = pagePointFromPointerEvent(event);
    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const plan = object?.type === "graphic" ? planNativeArtVisual(object, { coordinateSpace: "local" }) : undefined;
    if (!point || object?.type !== "graphic" || !plan?.markerHandles.some((handle) => handle.id === markerId)) {
      return;
    }

    const selectedDocument = currentDocument.selection.objectIds.includes(objectId)
      ? currentDocument
      : selectDocumentObject(currentDocument, objectId);
    replacePresentDocument(selectedDocument);
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setSelectedGraphicPathNode(undefined);
    graphicMarkerDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      markerId,
      startDocument: selectedDocument,
      startPoint: point,
      latestPoint: point,
      dragging: false
    };
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(markerId === "markerStart" ? "Adjust start arrowhead size" : "Adjust end arrowhead size");
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    handleObjectResizeInputKeep,
    handleRotationInputKeep,
    pagePointFromPointerEvent,
    replacePresentDocument
  ]);

  const handleGraphicGradientPointerDown = useCallback((
    objectId: string,
    target: GraphicStylePaintTarget,
    handle: NativeGraphicGradientHandleId,
    event: PointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can be unavailable if the browser has already canceled the press.
    }

    const point = pagePointFromPointerEvent(event);
    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const hasHandle = object && (object.type === "graphic" || object.type === "molecule")
      ? isLinearGradientHandleId(handle)
        ? nativeGraphicLinearGradientHandlePoints(object, target) !== undefined
        : nativeGraphicRadialGradientHandlePoints(object, target) !== undefined
      : false;
    if (
      !point ||
      !object ||
      (object.type !== "graphic" && object.type !== "molecule") ||
      !hasHandle
    ) {
      return;
    }

    const selectedDocument = currentDocument.selection.objectIds.includes(objectId)
      ? currentDocument
      : selectDocumentObject(currentDocument, objectId);
    replacePresentDocument(selectedDocument);
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setSelectedGraphicPathNode(undefined);
    graphicGradientDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      target,
      handle,
      startDocument: selectedDocument,
      startPoint: point,
      latestPoint: point,
      dragging: false
    };
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(`Move ${graphicGradientHandleStatusName(target, handle)}`);
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    handleObjectResizeInputKeep,
    handleRotationInputKeep,
    pagePointFromPointerEvent,
    replacePresentDocument
  ]);

  const handleObjectResizePointerDown = useCallback((
    objectId: string,
    corner: ObjectResizeCorner,
    event: PointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    if (object && documentObjectSupportsArtTransform(object) && isTransformHandleSecondPress(objectId, `resize-${corner}`, event)) {
      openObjectResizeInput(objectId, corner);
      return;
    }
    const point = pagePointFromPointerEvent(event);
    const selectedFragmentTarget = selectedNativeMoleculePart?.objectId === objectId
      ? nativeTransformableSelectionPart(selectedNativeMoleculePart)
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    const canResizeObject = object && point && (
      object.type !== "molecule"
        ? documentObjectSupportsArtTransform(object) && currentDocument.selection.objectIds.includes(objectId)
        : object.atoms.length > 0 &&
          (
            isWholeNativeMoleculeSelected(currentDocument, objectId, selectedNativeMoleculePart) ||
            selectedFragmentBounds !== undefined
          )
    );
    if (!canResizeObject || !object || !point) {
      return;
    }

    const selectedDocument = selectedFragmentTarget
      ? currentDocument
      : currentDocument.selection.objectIds.includes(objectId)
        ? currentDocument
        : selectDocumentObject(currentDocument, objectId);
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    replacePresentDocument(selectedDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(selectedFragmentTarget);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    const transform = object.type === "molecule" ? nativeMoleculeTransformState(object) : undefined;
    const startCumulativeScale = selectedFragmentTarget
      ? { x: 1, y: 1 }
      : {
          x: transform?.scaleX ?? 1,
          y: transform?.scaleY ?? 1
        };
    objectResizeDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      target: selectedFragmentTarget,
      corner,
      startDocument: selectedDocument,
      centerPoint: selectedFragmentBounds ? documentObjectCenter(selectedFragmentBounds) : documentObjectCenter(object),
      startPoint: point,
      startCumulativeScale,
      latestPoint: point,
      latestScale: { x: 1, y: 1 },
      latestCumulativeScale: startCumulativeScale,
      stretching: event.shiftKey,
      dragging: false
    };
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(selectedFragmentTarget
      ? "Resize selected molecule fragment"
      : object.type === "molecule" ? "Resize selected molecule" : "Resize selected art object");
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    handleObjectResizeInputKeep,
    handleRotationInputKeep,
    openObjectResizeInput,
    pagePointFromPointerEvent,
    replacePresentDocument,
    selectedNativeMoleculePart,
  ]);

  const handleObjectResizeDoubleClick = useCallback((
    objectId: string,
    corner: ObjectResizeCorner,
    event: ReactMouseEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openObjectResizeInput(objectId, corner);
  }, [openObjectResizeInput]);

  const handleObjectContextMenu = useCallback((objectId: string, event: ObjectMouseEvent) => {
    const currentDocument = documentRef.current;
    const point = pagePointFromPointerEvent(event);
    const crossingHit = point ? findNearestCrossingHit(pageSvgRenderPlan.crossings, point) : undefined;

    // Resolve by geometry before crossing actions, so a right-click at a weave still acts
    // on the atom/bond under the pointer. Crossing state is secondary menu context.
    const resolvedNativeHit = point
      ? nativeMoleculeCanvasHoverTarget(
          currentDocument,
          point,
          event.target,
          hitToleranceForScale(viewportRef.current.scale)
        )
      : undefined;
    let nativeMoleculeHit: NativeMoleculeDeleteHit | undefined;
    if (resolvedNativeHit) {
      objectId = resolvedNativeHit.objectId;
      nativeMoleculeHit = resolvedNativeHit.kind === "atom"
        ? {
            kind: "atom",
            atomId: resolvedNativeHit.atomId,
            distanceToPointer: resolvedNativeHit.distanceToPointer
          }
        : {
            kind: "bond",
            bondId: resolvedNativeHit.bondId,
            fromAtomId: resolvedNativeHit.fromAtomId,
            toAtomId: resolvedNativeHit.toAtomId,
            distanceToPointer: resolvedNativeHit.distanceToPointer
          };
    } else if (crossingHit) {
      objectId = crossingHit.front.objectId;
    }
    const object = findDocumentObject(currentDocument, objectId);
    nativeMoleculeHit ??= object?.type === "molecule" && point
      ? nativeMoleculeHitFromPointerTarget(
          object,
          point,
          event.target,
          hitToleranceForScale(viewportRef.current.scale)
        )
      : undefined;
    let nextSelectedNativePart: NativeMoleculeSelectionPart | undefined;
    let targetKind: ObjectContextMenuState["targetKind"] = "object";

    if (object?.type === "molecule" && nativeMoleculeHit) {
      const selectionResolution = nativeContextMenuSelectionResolutionFromHit(
        currentDocument,
        objectId,
        nativeMoleculeHit,
        selectedNativeMoleculePart
      );
      nextSelectedNativePart = selectionResolution.selectedPart;
      targetKind = selectionResolution.targetKind;
    } else if (object?.type === "molecule" && !nativeMoleculeHit) {
      return;
    }

    if (!object || !shouldActivateDocumentObject(object, "selection")) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    replacePresentDocument((current) => selectDocumentObject(current, objectId));
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(nextSelectedNativePart);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setObjectContextMenu({
      objectId,
      targetKind,
      bondDepthContext: bondDepthContextFromNativeSelection(nextSelectedNativePart, pageSvgRenderPlan.crossings, currentDocument),
      x: event.clientX,
      y: event.clientY
    });
    setStatus(crossingHit && targetKind !== "object"
        ? "Layer and bond depth options for selected molecule part"
        : targetKind === "object" ? "Layer options for selected object" : "Layer options for selected molecule part");
  }, [
    assignHoveredNativeDeleteTarget,
    pagePointFromPointerEvent,
    pageSvgRenderPlan.crossings,
    replacePresentDocument,
    selectedNativeMoleculePart
  ]);

  const handleObjectPointerMove = useCallback((objectId: string, event: ObjectPointerEvent) => {
    event.stopPropagation();
    const bezierArtNodeDrag = bezierArtNodeDragRef.current;
    if (bezierArtNodeDrag?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (point) {
        updateBezierArtNodeDrag(bezierArtNodeDrag, point);
      }
      return;
    }

    if (pathArtDrawRef.current) {
      const point = pagePointFromPointerEvent(event);
      if (point) {
        updateNativePathArtPreview(point);
      }
      return;
    }

    const textResize = textResizeRef.current;
    if (textResize?.pointerId === event.pointerId && textResize.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (point) {
        previewTextResize(textResize, point);
      }
      return;
    }

    const editDrag = nativeBondEditDragRef.current;
    if (editDrag?.pointerId === event.pointerId && editDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      editDrag.latestPoint = point;
      setNativeDoubleBondSidePreview(undefined);
      if (!editDrag.dragging && clientPointDistance(editDrag.startPoint, point) >= DOUBLE_BOND_SIDE_DRAG_THRESHOLD) {
        editDrag.dragging = true;
      }
      if (editDrag.dragging) {
        previewNativeDoubleBondSideDrag(editDrag, point);
      }
      return;
    }

    const nativePartDrag = nativePartDragRef.current;
    if (nativePartDrag?.pointerId === event.pointerId && nativePartDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      nativePartDrag.latestPoint = point;
      if (!nativePartDrag.dragging && clientPointDistance(nativePartDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        nativePartDrag.dragging = true;
        clearTransientInteractionChrome();
      }

      if (nativePartDrag.dragging) {
        previewNativePartDrag(nativePartDrag, point);
      }
      return;
    }

    const objectRotateDrag = objectRotateDragRef.current;
    if (objectRotateDrag?.pointerId === event.pointerId && objectRotateDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      objectRotateDrag.latestPoint = point;
      objectRotateMachineRef.current = interactionReducer(objectRotateMachineRef.current, { type: "pointerMove", pointerId: event.pointerId, world: point, target: { kind: "empty" } });
      const nowDragging = objectRotateMachineRef.current.phase === "dragging";
      if (!objectRotateDrag.dragging && nowDragging) {
        objectRotateDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (objectRotateDrag.dragging) {
        previewObjectRotateDrag(objectRotateDrag, point);
      }
      return;
    }

    const objectResizeDrag = objectResizeDragRef.current;
    if (objectResizeDrag?.pointerId === event.pointerId && objectResizeDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      objectResizeDrag.latestPoint = point;
      if (!objectResizeDrag.dragging && clientPointDistance(objectResizeDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        objectResizeDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (objectResizeDrag.dragging) {
        previewObjectResize(objectResizeDrag, point, event.shiftKey);
      }
      return;
    }

    const graphicCornerRadiusDrag = graphicCornerRadiusDragRef.current;
    if (graphicCornerRadiusDrag?.pointerId === event.pointerId && graphicCornerRadiusDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicCornerRadiusDrag.latestPoint = point;
      if (!graphicCornerRadiusDrag.dragging && clientPointDistance(graphicCornerRadiusDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD) {
        graphicCornerRadiusDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicCornerRadiusDrag.dragging) {
        previewGraphicCornerRadius(graphicCornerRadiusDrag, point);
      }
      return;
    }

    const graphicPathEditDrag = graphicPathEditDragRef.current;
    if (graphicPathEditDrag?.pointerId === event.pointerId && graphicPathEditDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicPathEditDrag.latestPoint = point;
      if (
        !graphicPathEditDrag.dragging &&
        (
          graphicPathEditDrag.handle === "middle" ||
          clientPointDistance(graphicPathEditDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD
        )
      ) {
        graphicPathEditDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicPathEditDrag.dragging) {
        previewGraphicPathEdit(graphicPathEditDrag, point);
      }
      return;
    }

    const graphicMarkerDrag = graphicMarkerDragRef.current;
    if (graphicMarkerDrag?.pointerId === event.pointerId && graphicMarkerDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicMarkerDrag.latestPoint = point;
      if (!graphicMarkerDrag.dragging && clientPointDistance(graphicMarkerDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD) {
        graphicMarkerDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicMarkerDrag.dragging) {
        previewGraphicMarkerDrag(graphicMarkerDrag, point);
      }
      return;
    }

    const graphicGradientDrag = graphicGradientDragRef.current;
    if (graphicGradientDrag?.pointerId === event.pointerId && graphicGradientDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicGradientDrag.latestPoint = point;
      if (!graphicGradientDrag.dragging && clientPointDistance(graphicGradientDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD) {
        graphicGradientDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicGradientDrag.dragging) {
        previewGraphicGradientDrag(graphicGradientDrag, point);
      }
      return;
    }

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId && objectDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      objectDrag.latestPoint = point;
      if (!objectDrag.dragging && clientPointDistance(objectDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        objectDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (objectDrag.dragging) {
        previewObjectDrag(objectDrag, point);
      }
      return;
    }

    const drag = nativeBondDragRef.current;
    if (drag?.pointerId === event.pointerId && drag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      if (!drag.dragging && clientPointDistance(drag.startPoint, point) >= FREEFORM_BOND_DRAG_THRESHOLD) {
        drag.dragging = true;
        setHoveredNativeAtom(undefined);
      }

      if (drag.dragging) {
        updateFreeformBondPreview(document, drag, point);
      } else {
        updateBondGrowthPreview(document, point);
      }
      return;
    }

    updateNativeCanvasHover(document, pagePointFromPointerEvent(event), event.target);
  }, [
    assignHoveredNativeDeleteTarget,
    document,
    pagePointFromPointerEvent,
    previewObjectDrag,
    previewObjectRotateDrag,
    previewObjectResize,
    previewGraphicCornerRadius,
    previewGraphicPathEdit,
    previewGraphicMarkerDrag,
    previewNativeDoubleBondSideDrag,
    previewNativePartDrag,
    previewTextResize,
    updateFreeformBondPreview,
    updateBezierArtNodeDrag,
    updateNativePathArtPreview,
    updateNativeCanvasHover
  ]);

  const handleObjectPointerUp = useCallback((objectId: string, event: ObjectPointerEvent) => {
    const bezierArtNodeDrag = bezierArtNodeDragRef.current;
    if (bezierArtNodeDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? bezierArtNodeDrag.latestPoint;
      updateBezierArtNodeDrag(bezierArtNodeDrag, point);
      clearBezierArtNodeDrag(event);
      return;
    }

    const textResize = textResizeRef.current;
    if (textResize?.pointerId === event.pointerId && textResize.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? textResize.latestPoint;
      const changed = commitTextResize(textResize, point);
      clearTextResize(event);
      setStatus(changed ? "Resized text box" : "Text box size unchanged");
      return;
    }

    const editDrag = nativeBondEditDragRef.current;
    if (editDrag?.pointerId === event.pointerId && editDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? editDrag.latestPoint;
      if (editDrag.dragging) {
        const changed = commitNativeDoubleBondSideDrag(editDrag, point);
        if (changed) {
          clearTransientInteractionChrome();
        }
        setStatus(changed ? "Moved double bond line" : "Double bond side unchanged");
      } else {
        cycleNativeBondOrder(editDrag.target);
      }
      clearNativeBondEditDrag(event);
      return;
    }

    const nativePartDrag = nativePartDragRef.current;
    if (nativePartDrag?.pointerId === event.pointerId && nativePartDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? nativePartDrag.latestPoint;
      if (nativePartDrag.dragging) {
        const changed = commitNativePartDrag(nativePartDrag, point);
        setStatus(changed ? "Moved selected molecule part" : "Molecule part did not move");
      }
      clearNativePartDrag(event);
      return;
    }

    const objectRotateDrag = objectRotateDragRef.current;
    if (objectRotateDrag?.pointerId === event.pointerId && objectRotateDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? objectRotateDrag.latestPoint;
      if (objectRotateDrag.dragging) {
        const changed = commitObjectRotateDrag(objectRotateDrag, point);
        const object = findDocumentObject(documentRef.current, objectRotateDrag.objectId);
        const label = documentObjectTransformLabel(object);
        setStatus(changed ? `Rotated ${label}` : `${capitalizeLabel(label)} rotation unchanged`);
      }
      clearObjectRotateDrag(event);
      return;
    }

    const objectResizeDrag = objectResizeDragRef.current;
    if (objectResizeDrag?.pointerId === event.pointerId && objectResizeDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? objectResizeDrag.latestPoint;
      if (objectResizeDrag.dragging) {
        objectResizeDrag.latestScale = objectResizeScaleFromDrag(
          objectResizeDrag.centerPoint,
          objectResizeDrag.startPoint,
          point,
          objectResizeDrag.stretching
        );
        const changed = commitObjectResize(objectResizeDrag, point);
        const object = findDocumentObject(documentRef.current, objectResizeDrag.objectId);
        const label = documentObjectTransformLabel(object);
        setStatus(changed
          ? objectResizeDrag.stretching ? `Stretched ${label}` : `Resized ${label}`
          : `${capitalizeLabel(label)} size unchanged`);
      }
      clearObjectResizeDrag(event);
      return;
    }

    const graphicCornerRadiusDrag = graphicCornerRadiusDragRef.current;
    if (graphicCornerRadiusDrag?.pointerId === event.pointerId && graphicCornerRadiusDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicCornerRadiusDrag.latestPoint;
      if (graphicCornerRadiusDrag.dragging) {
        const changed = commitGraphicCornerRadius(graphicCornerRadiusDrag, point);
        setStatus(changed ? "Adjusted corner radius" : "Corner radius unchanged");
      } else {
        setStatus("Selected rounded rectangle");
      }
      clearGraphicCornerRadiusDrag(event);
      return;
    }

    const graphicPathEditDrag = graphicPathEditDragRef.current;
    if (graphicPathEditDrag?.pointerId === event.pointerId && graphicPathEditDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicPathEditDrag.latestPoint;
      if (graphicPathEditDrag.dragging) {
        const changed = commitGraphicPathEdit(graphicPathEditDrag, point);
        setStatus(graphicPathEditStatus(graphicPathEditDrag, changed));
      } else {
        setStatus("Selected art path");
      }
      clearGraphicPathEditDrag(event);
      return;
    }

    const graphicMarkerDrag = graphicMarkerDragRef.current;
    if (graphicMarkerDrag?.pointerId === event.pointerId && graphicMarkerDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicMarkerDrag.latestPoint;
      if (graphicMarkerDrag.dragging) {
        const changed = commitGraphicMarkerDrag(graphicMarkerDrag, point);
        setStatus(changed ? "Adjusted arrowhead size" : "Arrowhead size unchanged");
      } else {
        setStatus("Selected arrowhead");
      }
      clearGraphicMarkerDrag(event);
      return;
    }

    const graphicGradientDrag = graphicGradientDragRef.current;
    if (graphicGradientDrag?.pointerId === event.pointerId && graphicGradientDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicGradientDrag.latestPoint;
      if (graphicGradientDrag.dragging) {
        const changed = commitGraphicGradientDrag(graphicGradientDrag, point);
        const handleName = graphicGradientHandleStatusName(graphicGradientDrag.target, graphicGradientDrag.handle);
        setStatus(changed ? `Moved ${handleName}` : "Gradient handle unchanged");
      } else {
        setStatus("Selected gradient handle");
      }
      clearGraphicGradientDrag(event);
      return;
    }

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId && objectDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? objectDrag.latestPoint;
      if (objectDrag.dragging) {
        const changed = commitObjectDrag(objectDrag, point);
        setStatus(changed ? "Moved selected object" : "Object did not move");
      } else if (objectDrag.bondTarget) {
        cycleNativeBondOrder(objectDrag.bondTarget);
      } else {
        const object = findDocumentObject(documentRef.current, objectId);
        if (shouldOpenMoleculeEditorFromObjectClick(object, activeToolState.activeKind, event.detail)) {
          setActiveEditorObjectId(object.id);
        }
      }
      clearObjectDrag(event);
      return;
    }

    const drag = nativeBondDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.objectId !== objectId) {
      return;
    }

    event.stopPropagation();
    const point = pagePointFromPointerEvent(event) ?? drag.latestPoint;
    const selectedDocument = selectDocumentObject(document, objectId);
    if (drag.dragging) {
      applyFreeformBondDocumentAtPoint(selectedDocument, objectId, drag.atomId, point, drag.freeformUnlocked, drag.bondStyle);
    } else {
      applySingleBondDocumentAtPoint(selectedDocument, point, drag.bondStyle);
    }
    clearNativeBondDrag(event);
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    applyFreeformBondDocumentAtPoint,
    applySingleBondDocumentAtPoint,
    clearNativeBondEditDrag,
    clearNativeBondDrag,
    clearNativePartDrag,
    clearBezierArtNodeDrag,
    clearObjectDrag,
    clearObjectRotateDrag,
    clearObjectResizeDrag,
    clearGraphicCornerRadiusDrag,
    clearGraphicGradientDrag,
    clearGraphicPathEditDrag,
    clearGraphicMarkerDrag,
    clearTextResize,
    commitGraphicGradientDrag,
    commitGraphicPathEdit,
    commitGraphicMarkerDrag,
    commitNativeDoubleBondSideDrag,
    commitNativePartDrag,
    commitObjectResize,
    commitGraphicCornerRadius,
    commitTextResize,
    updateBezierArtNodeDrag,
    commitObjectDrag,
    commitObjectRotateDrag,
    cycleNativeBondOrder,
    document,
    pagePointFromPointerEvent
  ]);

  const handleObjectPointerCancel = useCallback((event: ObjectPointerEvent) => {
    const textResize = textResizeRef.current;
    if (textResize?.pointerId === event.pointerId) {
      replacePresentDocument(textResize.startDocument);
      clearTextResize(event);
    }

    const editDrag = nativeBondEditDragRef.current;
    if (editDrag?.pointerId === event.pointerId && editDrag.dragging) {
      replacePresentDocument(editDrag.startDocument);
    }

    const nativePartDrag = nativePartDragRef.current;
    if (nativePartDrag?.pointerId === event.pointerId && nativePartDrag.dragging) {
      replacePresentDocument(nativePartDrag.startDocument);
    }

    const objectRotateDrag = objectRotateDragRef.current;
    if (objectRotateDrag?.pointerId === event.pointerId && objectRotateDrag.dragging) {
      replacePresentDocument(objectRotateDrag.startDocument);
    }

    const objectResizeDrag = objectResizeDragRef.current;
    if (objectResizeDrag?.pointerId === event.pointerId && objectResizeDrag.dragging) {
      replacePresentDocument(objectResizeDrag.startDocument);
      setObjectResizeReadout(undefined);
    }

    const graphicCornerRadiusDrag = graphicCornerRadiusDragRef.current;
    if (graphicCornerRadiusDrag?.pointerId === event.pointerId && graphicCornerRadiusDrag.dragging) {
      replacePresentDocument(graphicCornerRadiusDrag.startDocument);
    }

    const graphicPathEditDrag = graphicPathEditDragRef.current;
    if (graphicPathEditDrag?.pointerId === event.pointerId && graphicPathEditDrag.dragging) {
      replacePresentDocument(graphicPathEditDrag.startDocument);
    }

    const graphicMarkerDrag = graphicMarkerDragRef.current;
    if (graphicMarkerDrag?.pointerId === event.pointerId && graphicMarkerDrag.dragging) {
      replacePresentDocument(graphicMarkerDrag.startDocument);
    }

    const graphicGradientDrag = graphicGradientDragRef.current;
    if (graphicGradientDrag?.pointerId === event.pointerId && graphicGradientDrag.dragging) {
      replacePresentDocument(graphicGradientDrag.startDocument);
    }

    const bezierArtNodeDrag = bezierArtNodeDragRef.current;
    if (bezierArtNodeDrag?.pointerId === event.pointerId) {
      clearBezierArtNodeDrag(event);
    }

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId && objectDrag.dragging) {
      replacePresentDocument(objectDrag.startDocument);
    }
    clearNativePartDrag(event);
    clearObjectRotateDrag(event);
    clearObjectResizeDrag(event);
    clearGraphicCornerRadiusDrag(event);
    clearGraphicGradientDrag(event);
    clearGraphicPathEditDrag(event);
    clearGraphicMarkerDrag(event);
    clearBezierArtNodeDrag(event);
    clearObjectDrag(event);
    clearNativeBondEditDrag(event);
    clearNativeBondDrag(event);
    setHoveredNativeAtom(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
  }, [
    assignHoveredNativeDeleteTarget,
    clearNativeBondDrag,
    clearNativeBondEditDrag,
    clearNativePartDrag,
    clearGraphicCornerRadiusDrag,
    clearGraphicGradientDrag,
    clearGraphicPathEditDrag,
    clearGraphicMarkerDrag,
    clearBezierArtNodeDrag,
    clearObjectResizeDrag,
    clearObjectDrag,
    clearObjectRotateDrag,
    clearTextResize,
    replacePresentDocument
  ]);

  const handleObjectPointerLeave = useCallback((objectId: string) => {
    if (
      nativeBondDragRef.current?.objectId === objectId ||
      nativeBondEditDragRef.current?.objectId === objectId ||
      nativePartDragRef.current?.objectId === objectId ||
      objectDragRef.current?.objectId === objectId ||
      graphicCornerRadiusDragRef.current?.objectId === objectId ||
      graphicPathEditDragRef.current?.objectId === objectId ||
      graphicMarkerDragRef.current?.objectId === objectId ||
      graphicGradientDragRef.current?.objectId === objectId ||
      objectRotateDragRef.current?.objectId === objectId ||
      objectResizeDragRef.current?.objectId === objectId
    ) {
      return;
    }

    setHoveredNativeAtom((current) => current?.objectId === objectId ? undefined : current);
    setNativeDoubleBondSidePreview((current) => current?.objectId === objectId ? undefined : current);
    assignHoveredNativeDeleteTarget(
      hoveredNativeDeleteTargetRef.current?.objectId === objectId ? undefined : hoveredNativeDeleteTargetRef.current
    );
  }, [assignHoveredNativeDeleteTarget]);

  const handleApplyKetcherEdit = useCallback((result: Parameters<typeof applyEditorSaveResultToSelectedMolecule>[1]) => {
    commitDocumentChange((current) => applyEditorSaveResultToSelectedMolecule(current, result));
  }, [commitDocumentChange]);

  const createAgentSnapshot = useCallback((): AgentSnapshot => {
    const currentDocument = documentRef.current;
    const page = currentDocument.pages[0];
    const pages = currentDocument.pages.map((candidate) => ({
      id: candidate.id,
      width: candidate.width,
      height: candidate.height,
      objectCount: candidate.objects.length,
      objectTypes: candidate.objects.reduce<Partial<Record<DocumentObject["type"], number>>>((counts, object) => {
        counts[object.type] = (counts[object.type] ?? 0) + 1;
        return counts;
      }, {}),
      crossingCount: candidate.crossings.length
    }));
    return {
      bridgeVersion: 1,
      build: `${CURRENT_BUILD_STAMP} · ${__BUILD_STAMP__}`,
      runtime: {
        desktop: nativePaletteRef.current,
        source: agentRuntimeSourceRef.current
      },
      document: currentDocument,
      activeToolCommandId: activeToolCommandIdRef.current,
      selection: currentDocument.selection,
      selectedNativeMoleculePart: selectedNativeMoleculePartRef.current,
      hoveredNativeTarget: hoveredNativeDeleteTargetRef.current,
      viewport: viewportRef.current,
      page: {
        id: page.id,
        width: page.width,
        height: page.height,
        objectCount: page.objects.length
      },
      pages,
      file: {
        dirty: fileStateRef.current.dirty,
        path: fileStateRef.current.path
      },
      objects: page.objects.map(agentObjectSummary)
    };
  }, []);

  const debugAgentArtObject = useCallback((objectId: string): AgentArtDebugResult => {
    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    if (object?.type !== "graphic") {
      return { ok: false, error: `Graphic object not found: ${objectId}` };
    }
    const editPoints = nativeGraphicPathEditPoints(object);
    const projectedEditPoints = editPoints
      ? {
          pathKind: editPoints.pathKind,
          start: projectGraphicVisualPagePoint(object, editPoints.start),
          middle: projectGraphicVisualPagePoint(object, editPoints.middle),
          end: projectGraphicVisualPagePoint(object, editPoints.end)
        }
      : undefined;
    const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
    return {
      ok: true,
      object,
      editPoints,
      projectedEditPoints,
      plan: {
        pathD: plan.pathD,
        frameBounds: plan.frameBounds,
        markerHandles: plan.markerHandles,
        projectionTransform: plan.projectionTransform,
        width: plan.width,
        height: plan.height
      }
    } satisfies ChemDraftAgentArtDebugSnapshot;
  }, []);

  const resolveAgentPoint = useCallback((target: AgentPointTarget): AgentResolvedPoint => {
    const page = pageRef.current;
    if (!page) {
      throw new Error("ChemDraft page is not mounted.");
    }

    return resolveAgentPointInDocument(target, documentRef.current, page.getBoundingClientRect(), viewportRef.current.scale);
  }, []);

  const hitTestAgentPoint = useCallback((target: AgentPointTarget): AgentHitResult => {
    const point = resolveAgentPoint(target);
    return {
      point,
      target: nativeMoleculeCanvasHoverTarget(
        documentRef.current,
        point.page,
        undefined,
        hitToleranceForScale(viewportRef.current.scale)
      )
    };
  }, [resolveAgentPoint]);

  const dispatchAgentPointer = useCallback((
    type: AgentPointerEventType,
    target: AgentPointTarget,
    options?: AgentPointerOptions
  ) => {
    const page = pageRef.current;
    if (!page) {
      throw new Error("ChemDraft page is not mounted.");
    }

    return dispatchAgentPointerEvent({
      activePointerTargets: agentPointerTargetsRef.current,
      ownerDocument: page.ownerDocument,
      pageElement: page,
      resolvedPoint: resolveAgentPoint(target),
      type,
      options
    });
  }, [resolveAgentPoint]);

  const waitForAgentIdle = useCallback(async () => {
    await waitForAnimationFrames(2);
    return createAgentSnapshot();
  }, [createAgentSnapshot]);

  useEffect(() => {
    let disposed = false;
    let installedBridge: Window[typeof AGENT_BRIDGE_GLOBAL_NAME] | undefined;

    void resolveAgentBridgePermission().then((permission) => {
      agentRuntimeSourceRef.current = permission.source;
      if (disposed || !permission.enabled) {
        return;
      }

      installedBridge = createChemDraftAgentBridge({
        snapshot: createAgentSnapshot,
        command(commandId) {
          return invokeCommandRef.current(commandId);
        },
        resolvePoint: resolveAgentPoint,
        hitTest: hitTestAgentPoint,
        pointer: dispatchAgentPointer,
        debugArtObject: debugAgentArtObject,
        waitForIdle: waitForAgentIdle
      });
      window[AGENT_BRIDGE_GLOBAL_NAME] = installedBridge;
      setStatus(`Agent bridge enabled (${permission.source})`);
    });

    return () => {
      disposed = true;
      agentPointerTargetsRef.current.clear();
      if (installedBridge && window[AGENT_BRIDGE_GLOBAL_NAME] === installedBridge) {
        delete window[AGENT_BRIDGE_GLOBAL_NAME];
      }
    };
  }, [
    createAgentSnapshot,
    debugAgentArtObject,
    dispatchAgentPointer,
    hitTestAgentPoint,
    resolveAgentPoint,
    waitForAgentIdle
  ]);

  const activeSpin3dState = spin3dState && findDocumentObject(document, spin3dState.objectId)?.type === "molecule"
    ? spin3dState
    : undefined;

  // The browser build has no native OS menu, so it renders the shared app-menu model in-viewport.
  // On the Tauri desktop build the native menu owns this, so the in-window bar stays hidden.
  const showAppMenuBar = !isDesktopRuntime();
  const appMenuSections = useMemo(
    () =>
      buildAppMenuModel({
        rulersVisible,
        crosshairsVisible,
        canUndo,
        canRedo,
        hasSelection: document.selection.objectIds.length > 0,
        hasSelectedMolecule: selectedMolecule !== undefined,
        toolbars: getToolbarsMenuModel(visibleToolsetIds, toolsetRegistry),
        pluginMenuItems: pluginRuntime.pluginMenuItems
      }),
    [
      rulersVisible,
      crosshairsVisible,
      canUndo,
      canRedo,
      document.selection.objectIds.length,
      selectedMolecule,
      visibleToolsetIds,
      toolsetRegistry,
      pluginRuntime.pluginMenuItems
    ]
  );

  return (
    <main
      className={[
        "app-shell",
        effectiveNativePalette ? "native-shell" : "web-shell",
        showAppMenuBar ? "has-app-menu-bar" : ""
      ].filter(Boolean).join(" ")}
      aria-label="ChemDraft desktop workspace"
      data-active-tool={activeToolState.activeCommandId}
      data-active-tool-kind={activeToolState.activeKind}
      data-art-target-cue={artPaintTargetCueActive ? "true" : undefined}
      data-can-undo={canUndo ? "true" : "false"}
      data-can-redo={canRedo ? "true" : "false"}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".chemdraft,.cdxml,.xml,.json,chemical/x-cdxml,application/xml,text/xml,application/json,application/vnd.chemdraft+json"
        className="native-file-input"
        aria-label="Open native ChemDraft document"
        onChange={handleOpenFile}
      />
      <input
        ref={moleculeTemplateInputRef}
        type="file"
        accept=".template,.cds,application/json,application/octet-stream"
        className="native-file-input"
        aria-label="Import Molecule Inspector template"
        onChange={handleMoleculeTemplateFile}
      />

      {showAppMenuBar ? <MenuBar sections={appMenuSections} onInvoke={invoke} /> : null}

      {pluginManagerOpen ? (
        <PluginManagerDialog
          runtime={pluginRuntime.runtime}
          bundledPlugins={pluginRuntime.bundledPlugins}
          installedPlugins={pluginRuntime.installedPlugins}
          onPickPackage={pluginRuntime.pickPackage}
          onInstallPackage={pluginRuntime.installPackage}
          onUninstallPlugin={pluginRuntime.uninstallInstalledPlugin}
          installedPluginCatalogReady={pluginRuntime.installedPluginCatalogReady}
          onCheckPluginUpdates={pluginRuntime.checkInstalledPluginUpdates}
          onPreparePluginUpdate={pluginRuntime.prepareInstalledPluginUpdate}
          onUpdatePlugin={pluginRuntime.updateInstalledPlugin}
          onClose={() => setPluginManagerOpen(false)}
          onPluginsChanged={() => setStatus("Plugin settings updated")}
        />
      ) : null}

      <PluginPanelSurface
        openPanel={pluginRuntime.openPanel}
        diagnosticsOpen={pluginDiagnosticsOpen}
        plugins={pluginRuntime.plugins}
        diagnostics={pluginRuntime.diagnostics}
        stale={pluginPanelStale}
        onClose={pluginRuntime.closePanel}
        onCloseDiagnostics={() => setPluginDiagnosticsOpen(false)}
        onRunAgain={(commandId) => invoke(commandId)}
        onOpenAsWindow={isDesktopRuntime() ? popOutOpenPanel : undefined}
      />



      {!effectiveNativePalette
        ? visibleFloatingToolsets.map((toolset) => {
            const position = webPalettePositions[toolset.id] ?? defaultToolsetPosition(toolset.id, toolsetRegistry);
            const customizingThis = customizeMainToolbarActive && toolset.id === DEFAULT_TOOLSET_ID;
            const paletteGroups = getToolsetPaletteGroups(toolset.id, toolsetRegistry, shellCommandsById);
            // Render from a given set of groups — the controller passes an optimistic overlay while a
            // drop settles so the palette doesn't flash the old layout during the broadcast round-trip.
            const renderPalette = (renderGroups: readonly ToolbarPaletteGroupModel[]) => (
              <ToolPalette
                itemGroups={renderGroups.map((group) => group.items)}
                gridLayout={toolset.gridLayout}
                activeTool={activeTool}
                currentDistributeMode={distributeMode}
                mode="floating"
                orientation={toolset.gridLayout?.orientation ?? "vertical"}
                title={toolset.title}
                onInvoke={invoke}
                customize={customizingThis ? { groupIds: renderGroups.map((group) => group.id) } : undefined}
                widgetState={{
                  currentObjectColor: currentToolbarObjectColor,
                  currentArtStyle,
                  currentArtStyleTarget: activeArtPaintTarget,
                  currentMoleculeInspector,
                  currentMolecularInspector: analysisReport,
                  molecularInspectorBusy: analysisBusy,
                  currentTextStyle: currentToolbarTextStyle,
                  currentTextScript: currentToolbarTextScript,
                  onArtStylePreview: previewObjectStyleCommand,
                  onArtStyleCommit: commitObjectStylePreview,
                  onArtStyleCancel: cancelObjectStylePreview,
                  onMoleculeInspectorPreview: previewMoleculeInspectorCommand,
                  onMoleculeInspectorCommit: commitMoleculeInspectorPreview,
                  onMoleculeInspectorCancel: cancelMoleculeInspectorPreview,
                  onMolecularInspectorCopy: copyAnalysisText,
                  onMolecularInspectorChangeInterpretation: recomputeAnalysisFor,
                  onInvoke: invoke
                }}
              />
            );
            return (
              <section
                className="web-floating-palette"
                aria-label={`Floating ${toolset.title}`}
                data-floating-palette="web-preview"
                data-toolset-id={toolset.id}
                key={toolset.id}
                style={
                  {
                    "--palette-x": `${position.x}px`,
                    "--palette-y": `${position.y}px`,
                    "--palette-width": `${toolset.preferredWindowSize?.width ?? 96}px`
                  } as CSSProperties
                }
                onPointerDown={(event) => startWebPaletteDrag(toolset.id, event)}
                onPointerMove={moveWebPalette}
                onPointerUp={stopWebPaletteDrag}
                onPointerCancel={stopWebPaletteDrag}
              >
                <div
                  className="palette-title"
                  data-palette-title-drag-surface="true"
                  data-web-palette-drag-region="true"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    startWebPaletteDrag(toolset.id, event);
                  }}
                  onPointerMove={moveWebPalette}
                  onPointerUp={stopWebPaletteDrag}
                  onPointerCancel={stopWebPaletteDrag}
                >
                  <span className="palette-title-label">{toolset.title.replace(/ Toolbar$/, "")}</span>
                </div>
                {customizingThis ? (
                  <ToolbarCustomizeController
                    toolsetId={toolset.id}
                    groups={paletteGroups}
                    onEdit={(edit) => sendToolsetLayoutEdit({ toolsetId: toolset.id, edit })}
                  >
                    {(effectiveGroups) => (
                      <>
                        {renderPalette(effectiveGroups)}
                        <CustomizeBar
                          onDone={() => void sendToolsetLayoutEdit({ toolsetId: toolset.id, edit: { kind: "exitCustomize" } }).catch(() => undefined)}
                          onRestoreDefaults={() => void sendToolsetLayoutEdit({ toolsetId: toolset.id, edit: { kind: "resetToolset" } }).catch(() => undefined)}
                        />
                        <GalleryTray
                          commands={galleryCommands}
                          widgets={APPENDABLE_TOOLBAR_WIDGETS}
                          presentItemIds={new Set(effectiveGroups.flatMap((group) => group.items.map((item) => item.id)))}
                        />
                      </>
                    )}
                  </ToolbarCustomizeController>
                ) : (
                  renderPalette(paletteGroups)
                )}
              </section>
            );
          })
        : null}

      <section className="workspace">
        <section
          ref={canvasRegionRef}
          className={["canvas-region", rulersVisible ? "rulers-visible" : ""].filter(Boolean).join(" ")}
          aria-label="Document workspace"
          data-zoom-surface="document"
          // Gates the ring interior hit surface (see .native-molecule-ring-hit-target): ring
          // centers only become selectable while the Rings toolbar is open.
          data-ring-inspector-open={ringInspectorOpen ? "true" : "false"}
        >
          {rulersVisible ? (
            <DocumentRulers
              viewport={viewport}
              frame={rulerFrame}
              pageWidth={activePage.width}
              pageHeight={activePage.height}
            />
          ) : null}
          <div className="page-stage" style={{ ...viewportCssVars(viewport), ...pageCssVars } as CSSProperties}>
            <div className="document-board without-rulers">
              <div
                ref={pageRef}
                className={["page", crosshairsVisible ? "crosshairs-visible" : "crosshairs-hidden"].join(" ")}
                aria-label={document.title}
                onPointerDown={handlePagePointerDown}
                onPointerMove={handlePagePointerMove}
                onPointerUp={handlePagePointerUp}
                onPointerCancel={handlePagePointerCancel}
                onPointerLeave={handlePagePointerLeave}
                onContextMenu={handlePageContextMenu}
              >
                {crosshairsVisible ? (
                  <CrosshairOverlay
                    horizontalTicks={horizontalCrosshairTicks}
                    verticalTicks={verticalCrosshairTicks}
                  />
                ) : null}
                <PageSvgSurface
                  ariaLabel={document.title}
                  pageHeight={activePage.height}
                  pageWidth={activePage.width}
                  plan={pageSvgRenderPlan}
                  spinningObjectId={activeSpin3dState?.objectId}
                  onContextMenu={handleObjectContextMenu}
                  onPointerCancel={handleObjectPointerCancel}
                  onPointerDown={handleObjectPointerDown}
                  onPointerLeave={handleObjectPointerLeave}
                  onPointerMove={handleObjectPointerMove}
                  onPointerUp={handleObjectPointerUp}
                />
                {activeNativeTemplateId && templatePreview ? (
                  <NativeTemplateGhostOverlay
                    plan={templatePreview}
                    pageWidth={activePage.width}
                    pageHeight={activePage.height}
                  />
                ) : null}
                <svg
                  className="freehand-art-preview-layer"
                  viewBox={`0 0 ${activePage.width} ${activePage.height}`}
                  aria-hidden="true"
                  data-freehand-art-preview-layer="true"
                >
                  <path
                    ref={freehandArtPreviewPathRef}
                    className="freehand-art-preview-path"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    data-freehand-art-preview-path="true"
                  />
                </svg>
                {pathArtPreview ? (
                  <svg
                    className="path-art-preview-layer"
                    viewBox={`0 0 ${activePage.width} ${activePage.height}`}
                    aria-hidden="true"
                    data-path-art-kind={pathArtPreview.pathKind}
                    data-path-art-preview-layer="true"
                    data-polyline-art-preview-layer={pathArtPreview.pathKind === "polyline" ? "true" : undefined}
                  >
                    {pathArtPreviewControlPlans(pathArtPreview).map((control) => (
                      <line
                        className="path-art-preview-control-line"
                        data-path-art-preview-control-line={`${control.index}:${control.kind}`}
                        key={`${control.index}:${control.kind}:line`}
                        x1={control.anchor.x}
                        y1={control.anchor.y}
                        x2={control.point.x}
                        y2={control.point.y}
                      />
                    ))}
                    <path
                      className="path-art-preview-path"
                      d={pathArtPreviewPathD(pathArtPreview)}
                      fill={pathArtPreview.closed ? "rgba(29, 127, 104, 0.08)" : "none"}
                      data-path-art-preview-path="true"
                      data-polyline-art-preview-path={pathArtPreview.pathKind === "polyline" ? "true" : undefined}
                    />
                    {pathArtPreview.nodes.map((node, index) => (
                      <circle
                        className="path-art-preview-node"
                        cx={node.point.x}
                        cy={node.point.y}
                        data-path-art-preview-node={index}
                        data-polyline-art-preview-node={pathArtPreview.pathKind === "polyline" ? index : undefined}
                        key={`${index}:${node.point.x}:${node.point.y}`}
                        r={4}
                      />
                    ))}
                    {pathArtPreviewControlPlans(pathArtPreview).map((control) => (
                      <circle
                        className="path-art-preview-control"
                        cx={control.point.x}
                        cy={control.point.y}
                        data-path-art-preview-control={control.kind}
                        data-path-art-preview-control-index={control.index}
                        key={`${control.index}:${control.kind}:control`}
                        r={3.5}
                      />
                    ))}
                  </svg>
                ) : null}
                {tapeMeasure ? (
                  <TapeMeasureOverlay
                    measurement={tapeMeasure}
                    pageWidth={activePage.width}
                    pageHeight={activePage.height}
                    rulerUnit={pageRulerUnit}
                  />
                ) : null}
                {selectionMarquee ? (
                  <SelectionMarqueeOverlay
                    startPoint={selectionMarquee.startPoint}
                    latestPoint={selectionMarquee.latestPoint}
                  />
                ) : null}
                {selectionLasso ? (
                  <SelectionLassoOverlay
                    points={selectionLasso.points}
                    latestPoint={selectionLasso.latestPoint}
                    pageWidth={activePage.width}
                    pageHeight={activePage.height}
                  />
                ) : null}
                {(() => {
                  const resolvedSelectionObjectIds = resolveGroupedDocumentObjectIds(
                    document.pages[0].objects,
                    document.selection.objectIds
                  );
                  const groupSelectionActive = activeToolState.activeKind === "selection" &&
                    resolvedSelectionObjectIds.length > 1 &&
                    !selectedNativeMoleculePart;
                  const rawGroupSelectionBounds = groupSelectionActive
                    ? visualSelectionBounds(document.pages[0].objects, resolvedSelectionObjectIds)
                    : undefined;
                  const groupSelectionBounds = rawGroupSelectionBounds
                    ? previewedGroupSelectionBounds(
                        rawGroupSelectionBounds,
                        resolvedSelectionObjectIds,
                        objectTransformPreview
                      )
                    : undefined;
                  const groupProjectedPlaneTiltObjectIds = rawGroupSelectionBounds
                    ? nativeMoleculeObjectIdsForGroupProjectedPlaneTilt(document.pages[0].objects, resolvedSelectionObjectIds)
                    : [];
                  return (
                  <>
                {document.pages[0].objects.map((object, layerIndex) => {
                  const selectionChromeActive = activeToolState.activeKind === "selection";
                  // Phase 7: each selected molecule renders its own part highlight, so shift/marquee
                  // selections that span several molecules all light up (not just the primary).
                  const selectedPart = selectionChromeActive
                    ? selectedNativeMoleculeParts.find((part) => part.objectId === object.id)
                    : undefined;
                  const selected = selectionChromeActive &&
                    document.selection.objectIds.includes(object.id) &&
                    selectedPart === undefined;
                  // While a multi-selection group is active, individual members defer their
                  // own resize/rotate handles to the single group overlay.
                  const inGroupSelection = groupSelectionBounds !== undefined &&
                    resolvedSelectionObjectIds.includes(object.id);
                  // While this molecule is being spun in 3D, its real 2D drawing is faded
                  // to a faint ghost (the live overlay paints on top). The selection box
                  // and rotate handle are separate chrome and stay fully visible.
                  const spinning = activeSpin3dState?.objectId === object.id;
                  const objectRenderKey = object.type === "molecule"
                    ? `${object.id}:${selected ? "selected" : "idle"}:${inGroupSelection ? "grouped" : "solo"}:${nativeSelectionRenderKey(selectedPart)}:${spinning ? "spinning" : "static"}`
                    : object.id;

                  return (
                    <DocumentObjectView
                      key={objectRenderKey}
                      object={object}
                      layerIndex={layerIndex}
                      pageHeight={activePage.height}
                      pageWidth={activePage.width}
                      spinning={spinning}
                      selected={selected}
                      inGroupSelection={inGroupSelection}
                      graphicTransformActive={activeGraphicTransformObjectId === object.id}
                      graphicDirectEditActive={activeToolState.activeCommandId === "tool.art.directEdit"}
                      graphicPathFeedbackActive={
                        activeToolState.activeCommandId === "tool.art.scissors" &&
                        selectedGraphicPathNode?.objectId === object.id
                      }
                      graphicSegmentEraseActive={activeToolState.activeCommandId === "tool.eraser"}
                      graphicEyedropperTargetActive={
                        activeToolState.activeCommandId === "tool.art.eyedropper" &&
                        object.type === "graphic" &&
                        document.selection.objectIds.includes(object.id)
                      }
                      activeArtPaintTarget={effectiveArtPaintTarget}
                      selectedGraphicPathNodeIndex={
                        selectedGraphicPathNode?.objectId === object.id
                          ? selectedGraphicPathNode.nodeIndex
                          : undefined
                      }
                      selectedPart={selectedPart}
                      transformHandlesEnabled={selectionChromeActive}
                      editingText={activeTextEditObjectId === object.id}
                      editingAtomLabel={activeAtomLabelEdit?.objectId === object.id ? activeAtomLabelEdit : undefined}
                      chargeByAtomId={object.type === "molecule" ? chargeResolutionByMoleculeId.get(object.id) : undefined}
                      growthPreview={hoveredNativeAtom?.objectId === object.id ? hoveredNativeAtom : undefined}
                      deleteTarget={hoveredNativeDeleteTarget?.objectId === object.id ? hoveredNativeDeleteTarget : undefined}
                      hoverDestructive={activeToolState.activeCommandId === "tool.eraser"}
                      freeformPreview={freeformNativeBond?.objectId === object.id ? freeformNativeBond : undefined}
                      doubleBondSidePreview={
                        nativeDoubleBondSidePreview?.objectId === object.id ? nativeDoubleBondSidePreview : undefined
                      }
                      nativeMoleculeSvgFragments={nativeMoleculeOverlayFragments.get(object.id)}
                      rotateReadout={objectRotateReadout?.objectId === object.id ? objectRotateReadout : undefined}
                      projectedPlaneTiltReadout={
                        projectedPlaneTiltReadout?.objectId === object.id ? projectedPlaneTiltReadout : undefined
                      }
                      rotationInput={rotationInput?.objectId === object.id ? rotationInput : undefined}
                      rotationHandlesVisible={transformRotationHandlesVisible}
                      resizeReadout={objectResizeReadout?.objectId === object.id ? objectResizeReadout : undefined}
                      resizeInput={objectResizeInput?.objectId === object.id ? objectResizeInput : undefined}
                      objectTransformPreview={
                        objectTransformPreview?.objectIds.includes(object.id) ? objectTransformPreview : undefined
                      }
                      graphicCornerRadiusReadout={
                        graphicCornerRadiusReadout?.objectId === object.id ? graphicCornerRadiusReadout : undefined
                      }
                      onPointerDown={handleObjectPointerDown}
                      onPointerMove={handleObjectPointerMove}
                      onPointerUp={handleObjectPointerUp}
                      onPointerCancel={handleObjectPointerCancel}
                      onPointerLeave={handleObjectPointerLeave}
                      onRotatePointerDown={handleObjectRotatePointerDown}
                      onRotateDoubleClick={handleObjectRotateDoubleClick}
                      onProjectedPlaneTiltPointerDown={handleProjectedPlaneTiltPointerDown}
                      onProjectedPlaneTiltDoubleClick={handleProjectedPlaneTiltDoubleClick}
                      onGraphicCornerRadiusPointerDown={handleGraphicCornerRadiusPointerDown}
                      onGraphicCornerRadiusDoubleClick={handleGraphicCornerRadiusDoubleClick}
                      onGraphicPathEditPointerDown={handleGraphicPathEditPointerDown}
                      onGraphicMarkerPointerDown={handleGraphicMarkerPointerDown}
                      onGraphicGradientPointerDown={handleGraphicGradientPointerDown}
                      onRotationInputChange={handleRotationInputChange}
                      onRotationInputKeep={handleRotationInputKeep}
                      onRotationInputHome={handleRotationInputHome}
                      onRotationInputCancel={handleRotationInputCancel}
                      onObjectResizePointerDown={handleObjectResizePointerDown}
                      onObjectResizeDoubleClick={handleObjectResizeDoubleClick}
                      onObjectResizeInputChange={handleObjectResizeInputChange}
                      onObjectResizeInputKeep={handleObjectResizeInputKeep}
                      onObjectResizeInputHome={handleObjectResizeInputHome}
                      onObjectResizeInputCancel={handleObjectResizeInputCancel}
                      onContextMenu={handleObjectContextMenu}
                      onTextChange={updateTextObjectContent}
                      onTextEditStart={startTextObjectEdit}
                      onTextEditFinish={() => setActiveTextEditObjectId(undefined)}
                      onTextSelectionChange={recordTextSelection}
                      onTextResizeStart={startTextResize}
                      onAtomLabelChange={updateAtomLabelDraft}
                      onAtomLabelCancel={cancelAtomLabelEdit}
                      onAtomLabelFinish={() => setActiveAtomLabelEdit(undefined)}
                    />
                  );
                })}
                {groupSelectionBounds ? (
                  <GroupSelectionOverlay
                    bounds={groupSelectionBounds}
                    canProjectedPlaneTilt={groupProjectedPlaneTiltObjectIds.length > 1}
                    rotationHandlesVisible={transformRotationHandlesVisible}
                    onProjectedPlaneTiltStart={handleGroupProjectedPlaneTiltPointerDown}
                    onRotateStart={handleGroupRotatePointerDown}
                    onResizeStart={handleGroupResizePointerDown}
                  />
                ) : null}
                {activeSpin3dState ? (() => {
                  const spinObject = activePage.objects.find((object) => object.id === activeSpin3dState.objectId);
                  // The overlay renders with the molecule's OWN drawing style so the
                  // spinning structure is visually the same structure as the drawing.
                  const spinStyle = nativeDrawingStyleFromObjectStyle(
                    spinObject?.type === "molecule" ? spinObject.style : {}
                  );
                  return (
                    <SpinOverlay
                      state={activeSpin3dState}
                      pageWidth={activePage.width}
                      pageHeight={activePage.height}
                      drawingStyle={spinStyle}
                      onPointerDown={handleSpinOverlayPointerDown}
                      onPointerMove={handleSpinOverlayPointerMove}
                      onPointerUp={handleSpinOverlayPointerUp}
                      onPointerCancel={handleSpinOverlayPointerUp}
                    />
                  );
                })() : null}
                {spin3dGenerating && !activeSpin3dState &&
                  activePage.objects.some((object) => object.id === spin3dGenerating.objectId) ? (
                  <Spin3dGeneratingCue
                    box={spin3dGenerating.box}
                    atomCount={spin3dGenerating.atomCount}
                    pageWidth={activePage.width}
                    pageHeight={activePage.height}
                  />
                ) : null}
                  </>
                  );
                })()}
                {artTransformQaEnabled ? (
                  <ArtTransformQaLayer
                    draft={artTransformQaDraft}
                    page={activePage}
                    selectionObjectIds={document.selection.objectIds}
                    onApplyScene={applyArtTransformQaScene}
                    onApplySelection={applyArtTransformQaToSelection}
                    onDraftChange={setArtTransformQaDraft}
                  />
                ) : null}
                {artStyleQaEnabled ? (
                  <ArtStyleQaLayer
                    page={activePage}
                    runCount={artStyleQaRunCount}
                    selectionObjectIds={document.selection.objectIds}
                    onApplyScene={applyArtStyleQaScene}
                    onRunStress={runArtStyleQaStress}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </section>
        {activeEditorMolecule ? (
          <KetcherEditorHost
            molecule={activeEditorMolecule}
            onApply={handleApplyKetcherEdit}
            onClose={() => setActiveEditorObjectId(undefined)}
            onStatus={setStatus}
          />
        ) : null}
        {exportDialog ? (
          <ExportDialog
            state={exportDialog}
            onCancel={cancelExportDialog}
            onChooseDestination={chooseExportDestination}
            onFilenameChange={(filename) => {
              setExportDialog((current) => current
                ? {
                    ...current,
                    filename,
                    destinationPath: nativePathWithBasename(current.destinationPath, filename)
                  }
                : current);
            }}
            onFormatChange={(format) => {
              const descriptor = getExportFormatDescriptor(format);
              setExportDialog((current) => current ? updateExportDialogFormat(current, format) : current);
              setStatus(descriptor.status === "implemented"
                ? `Export ready: ${descriptor.menuLabel}`
                : `${descriptor.menuLabel} export is not available yet`);
            }}
            onSvgOptionsChange={(svg) => {
              setExportDialog((current) => current
                ? { ...current, svg: { ...current.svg, ...svg } }
                : current);
            }}
            onPdfOptionsChange={(pdf) => {
              setExportDialog((current) => current
                ? { ...current, pdf: { ...current.pdf, ...pdf } }
                : current);
            }}
            onRasterOptionsChange={(raster) => {
              setExportDialog((current) => current
                ? { ...current, raster: { ...current.raster, ...raster } }
                : current);
            }}
            onCdxmlOptionsChange={(cdxml) => {
              setExportDialog((current) => current
                ? { ...current, cdxml: { ...current.cdxml, ...cdxml } }
                : current);
            }}
            onSubmit={submitExportDialog}
          />
        ) : null}
        {pageFitPrompt ? (
          <ImportedPageFitPrompt
            recommendation={pageFitPrompt}
            onKeep={keepImportedPageOverflow}
            onResize={acceptPageFitRecommendation}
          />
        ) : null}
        {customPageSizeDialog ? (
          <CustomPageSizeDialog
            state={customPageSizeDialog}
            onChange={setCustomPageSizeDialog}
            onCancel={() => setCustomPageSizeDialog(undefined)}
            onApply={applyCustomPageSize}
          />
        ) : null}
        {moleculeStyleOverridePrompt ? (
          <MoleculeStyleOverridePrompt
            objectCount={moleculeStyleOverridePrompt.objectIds.length}
            onKeep={() => applyPendingMoleculeStyleOverrideChoice("keep")}
            onClear={() => applyPendingMoleculeStyleOverrideChoice("clear")}
            onCancel={() => applyPendingMoleculeStyleOverrideChoice("cancel")}
          />
        ) : null}
        <PatchReviewTray
          host={pluginRuntime.runtime.host}
          queueVersion={patchQueueVersion}
          onAccept={acceptPluginProposal}
          onReject={rejectPluginProposal}
        />
        {customizeToolbarsOpen ? (
          <CustomizeToolbarsDialog
            baseToolsets={toolbarCatalog.baseToolsets()}
            layoutState={layoutStateRef.current ?? emptyLayoutState()}
            availableCommands={customizeCommandOptions}
            onApply={applyCustomizeToolbars}
            onLiveApply={liveApplyCustomizeToolbars}
            onClose={() => setCustomizeToolbarsOpen(false)}
          />
        ) : null}
        <div style={{ position: "absolute", bottom: 8, right: 8, color: "var(--cd-text-secondary)", opacity: 0.5, pointerEvents: "none", fontSize: 10, zIndex: 1000 }}>
          Build {CURRENT_BUILD_STAMP} · {__BUILD_STAMP__}
        </div>
        <div
          aria-live="polite"
          role="status"
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            maxWidth: "min(560px, calc(100% - 280px))",
            overflow: "hidden",
            color: "var(--cd-text-secondary)",
            fontSize: 11,
            pointerEvents: "none",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            zIndex: 1000
          }}
        >
          {interactive3dWorkspace
            ? [
                interactive3dWorkspace.status,
                interactive3dWorkspace.energyLabel,
                "Esc to close"
              ].filter(Boolean).join(" · ")
            : status}
        </div>
      </section>
      {objectContextMenu ? (
        <ObjectLayerContextMenu
          objectId={objectContextMenu.objectId}
          objectIndex={activePage.objects.findIndex((object) => object.id === objectContextMenu.objectId)}
          objectCount={activePage.objects.length}
          targetKind={objectContextMenu.targetKind}
          bondDepthContext={objectContextMenu.bondDepthContext}
          position={{ x: objectContextMenu.x, y: objectContextMenu.y }}
          onInvoke={(commandId) => {
            const menu = objectContextMenu;
            setObjectContextMenu(undefined);
            if (isBondDepthCommandId(commandId) && menu?.bondDepthContext) {
              const changed = commitDocumentChange((current) => {
                const patches = planBondDepthPatches(current.pages[0].id, menu.bondDepthContext, commandId);
                return patches.length > 0 ? applyPatches(current, patches) : current;
              });
              setStatus(changed ? bondDepthStatusForCommand(commandId) : "Bond depth unchanged");
              return;
            }
            invoke(commandId);
          }}
        />
      ) : null}
    </main>
  );
}

function applyObjectStyleCommandToMoleculeRings(
  currentDocument: ChemDraftDocument,
  commandId: string,
  target: GraphicStylePaintTarget,
  ringTargets: readonly NativeMoleculeRingTarget[]
): ObjectStyleCommandApplyResult {
  const unsupportedRingResult = (message: string): ObjectStyleCommandApplyResult => ({
    document: currentDocument,
    handled: true,
    targeted: false,
    message
  });

  const applyToRings = (
    update: (document: ChemDraftDocument, target: NativeMoleculeRingTarget) => ChemDraftDocument,
    singularMessage: string,
    pluralMessage: string
  ): ObjectStyleCommandApplyResult => ({
    document: ringTargets.reduce(update, currentDocument),
    handled: true,
    targeted: ringTargets.length > 0,
    message: ringTargets.length === 1 ? singularMessage : pluralMessage
  });

  const noneCommand = objectStyleNoneCommands.find((command) => command.id === commandId);
  if (noneCommand) {
    return noneCommand.target === "fill"
      ? applyToRings(
          (nextDocument, ringTarget) => applyMoleculeRingFillNone(nextDocument, ringTarget),
          "Removed selected ring fill",
          `Removed ${ringTargets.length} selected ring fills`
        )
      : unsupportedRingResult("Selected rings do not have an Art stroke");
  }

  const paintType = objectPaintTypeForCommand(commandId);
  if (paintType) {
    if (target !== "fill") {
      return unsupportedRingResult("Selected rings do not have an Art stroke");
    }
    if (paintType === "none") {
      return applyToRings(
        (nextDocument, ringTarget) => applyMoleculeRingFillNone(nextDocument, ringTarget),
        "Removed selected ring fill",
        `Removed ${ringTargets.length} selected ring fills`
      );
    }
    if (paintType === "solid") {
      return applyToRings(
        (nextDocument, ringTarget) => applyMoleculeRingFillColor(
          nextDocument,
          ringTarget,
          moleculeRingSolidFallbackColor(currentDocument, ringTarget)
        ),
        "Updated selected ring fill paint",
        `Updated ${ringTargets.length} selected ring fill paints`
      );
    }
    return unsupportedRingResult("Selected rings support solid fill only");
  }

  const opacity = objectOpacityForCommand(commandId);
  if (opacity) {
    return opacity.key === "fillOpacity"
      ? applyToRings(
          (nextDocument, ringTarget) => applyMoleculeRingFillOpacity(nextDocument, ringTarget, opacity.value),
          "Updated selected ring fill opacity",
          `Updated ${ringTargets.length} selected ring fill opacities`
        )
      : unsupportedRingResult("Selected rings do not have object opacity");
  }

  const disabledEffectKind = objectEffectDisableForCommand(commandId);
  if (disabledEffectKind) {
    return applyToRings(
      (nextDocument, ringTarget) => deactivateMoleculeRingEffect(nextDocument, ringTarget, disabledEffectKind),
      `Disabled selected ring ${disabledEffectKind} effect`,
      `Disabled ${ringTargets.length} selected ring ${disabledEffectKind} effects`
    );
  }

  const effectKind = objectEffectForCommand(commandId);
  if (effectKind) {
    return applyToRings(
      (nextDocument, ringTarget) => applyMoleculeRingEffect(nextDocument, ringTarget, effectKind),
      effectKind === "none" ? "Cleared selected ring effects" : `Applied selected ring ${effectKind} effect`,
      effectKind === "none"
        ? `Cleared ${ringTargets.length} selected ring effects`
        : `Applied ${ringTargets.length} selected ring ${effectKind} effects`
    );
  }

  const effectColor = objectEffectColorForCommand(commandId);
  if (effectColor) {
    return applyToRings(
      (nextDocument, ringTarget) =>
        applyMoleculeRingEffectColor(nextDocument, ringTarget, effectColor.effectKind, effectColor.color),
      `Updated selected ring ${effectColor.effectKind} color`,
      `Updated ${ringTargets.length} selected ring ${effectColor.effectKind} colors`
    );
  }

  const effectOpacity = objectEffectOpacityForCommand(commandId);
  if (effectOpacity) {
    return applyToRings(
      (nextDocument, ringTarget) =>
        applyMoleculeRingEffectOpacity(nextDocument, ringTarget, effectOpacity.effectKind, effectOpacity.opacity),
      `Updated selected ring ${effectOpacity.effectKind} opacity`,
      `Updated ${ringTargets.length} selected ring ${effectOpacity.effectKind} opacities`
    );
  }

  const effectSize = objectEffectSizeForCommand(commandId);
  if (effectSize) {
    return applyToRings(
      (nextDocument, ringTarget) =>
        applyMoleculeRingEffectSize(nextDocument, ringTarget, effectSize.effectKind, effectSize.size),
      `Updated selected ring ${effectSize.effectKind} size`,
      `Updated ${ringTargets.length} selected ring ${effectSize.effectKind} sizes`
    );
  }

  const selectedColor = objectColorForCommand(commandId);
  if (selectedColor) {
    return target === "fill"
      ? applyToRings(
          (nextDocument, ringTarget) => applyMoleculeRingFillColor(nextDocument, ringTarget, selectedColor),
          "Updated selected ring fill",
          `Updated ${ringTargets.length} selected ring fills`
        )
      : unsupportedRingResult("Selected rings do not have an Art stroke");
  }

  return { document: currentDocument, handled: false, targeted: false, message: "" };
}

function objectStyleResultWithRingOverrideChoice(
  currentDocument: ChemDraftDocument,
  result: ObjectStyleCommandApplyResult,
  moleculeObjectIds: readonly string[],
  mode: ObjectStyleRingOverrideMode
): ObjectStyleCommandApplyResult {
  if (!result.handled || !result.targeted) {
    return result;
  }

  const objectIdsWithRingOverrides = moleculeObjectIdsWithRingOverrides(currentDocument, moleculeObjectIds);
  if (objectIdsWithRingOverrides.length === 0) {
    return result;
  }

  if (mode === "clear") {
    return {
      ...result,
      document: clearMoleculeRingStyles(result.document, objectIdsWithRingOverrides),
      message: `${result.message}; cleared ring overrides`
    };
  }

  if (mode === "keep") {
    return result;
  }

  return {
    ...result,
    document: currentDocument,
    needsRingOverrideChoice: true,
    ringOverrideObjectIds: objectIdsWithRingOverrides
  };
}

function moleculeObjectIdsWithRingOverrides(
  document: ChemDraftDocument,
  objectIds: readonly string[]
): string[] {
  return objectIds.filter((objectId) => {
    const object = findDocumentObject(document, objectId);
    if (object?.type !== "molecule") {
      return false;
    }

    const ringStyles = object.style.ringStyles;
    return Boolean(
      ringStyles &&
      typeof ringStyles === "object" &&
      !Array.isArray(ringStyles) &&
      Object.keys(ringStyles).length > 0
    );
  });
}

function moleculeRingSolidFallbackColor(
  document: ChemDraftDocument,
  target: NativeMoleculeRingTarget
): string {
  const object = findDocumentObject(document, target.objectId);
  if (object?.type !== "molecule") {
    return "#111111";
  }

  const ringStyle = moleculeRingStyleRecord(object.style.ringStyles, target.ringKey);
  const ringPaint = graphicPaintRecordColor(ringStyle.fillPaint);
  if (ringPaint) {
    return ringPaint;
  }

  const ringFillColor = metadataStyleString(ringStyle.fillColor);
  if (ringFillColor && ringFillColor.toLowerCase() !== "none") {
    return ringFillColor;
  }

  const objectPaint = graphicPaintRecordColor(object.style.fillPaint);
  if (objectPaint) {
    return objectPaint;
  }

  const objectFillColor = metadataStyleString(object.style.fillColor);
  return objectFillColor && objectFillColor.toLowerCase() !== "none"
    ? objectFillColor
    : "#111111";
}

function moleculeRingStyleRecord(value: unknown, ringKey: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const style = (value as Record<string, unknown>)[ringKey];
  return style && typeof style === "object" && !Array.isArray(style)
    ? style as Record<string, unknown>
    : {};
}

function graphicPaintRecordColor(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const paint = value as Record<string, unknown>;
  return paint.kind === "solid" ? metadataStyleString(paint.color) : undefined;
}

function metadataStyleString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface MoleculeStyleOverridePromptProps {
  objectCount: number;
  onKeep: () => void;
  onClear: () => void;
  onCancel: () => void;
}

function MoleculeStyleOverridePrompt({
  objectCount,
  onKeep,
  onClear,
  onCancel
}: MoleculeStyleOverridePromptProps) {
  const moleculeLabel = objectCount === 1 ? "This molecule has" : "These molecules have";
  return (
    <div
      aria-label="Per-ring appearance attributes"
      aria-modal="true"
      role="dialog"
      style={exportDialogBackdropStyle}
    >
      <section style={exportDialogPanelStyle}>
        <div style={exportDialogHeaderStyle}>
          <h2 style={exportDialogTitleStyle}>Per-Ring Attributes</h2>
        </div>
        <p style={exportDialogHintStyle}>
          {moleculeLabel} per-ring attributes from the Molecule Inspector. Whole-molecule appearance changes can either keep those ring overrides or clear them for a uniform molecule.
        </p>
        <p style={exportDialogWarningStyle}>
          Clearing per-ring attributes removes them from the whole selected molecule. Use Undo to restore them.
        </p>
        <div style={exportDialogFooterStyle}>
          <button type="button" style={exportDialogButtonStyle} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" style={exportDialogButtonStyle} onClick={onKeep}>
            Keep Overrides
          </button>
          <button type="button" style={exportDialogPrimaryButtonStyle} onClick={onClear}>
            Clear Overrides
          </button>
        </div>
      </section>
    </div>
  );
}

interface ImportedPageFitPromptProps {
  recommendation: ImportedPageFitPromptState;
  onKeep: () => void;
  onResize: () => void;
}

function ImportedPageFitPrompt({ recommendation, onKeep, onResize }: ImportedPageFitPromptProps) {
  const currentLabel = pageFitPromptLayoutLabel(recommendation.currentPageTitle, recommendation.currentOrientation);
  const recommendedLabel = pageFitRecommendedLabel(recommendation);
  const overflow = [
    recommendation.overflowLeftPx > 0 ? `${Math.ceil(recommendation.overflowLeftPx)} px left of the page` : undefined,
    recommendation.overflowTopPx > 0 ? `${Math.ceil(recommendation.overflowTopPx)} px above the page` : undefined,
    recommendation.overflowRightPx > 0 ? `${Math.ceil(recommendation.overflowRightPx)} px wider` : undefined,
    recommendation.overflowBottomPx > 0 ? `${Math.ceil(recommendation.overflowBottomPx)} px taller` : undefined
  ].filter(Boolean).join(" and ");

  return (
    <div
      aria-label="Imported content page size"
      aria-modal="true"
      role="dialog"
      style={exportDialogBackdropStyle}
    >
      <section style={exportDialogPanelStyle}>
        <div style={exportDialogHeaderStyle}>
          <h2 style={exportDialogTitleStyle}>Imported Content Exceeds Page</h2>
        </div>
        <p style={exportDialogHintStyle}>
          {recommendation.displayName} extends beyond {currentLabel}{overflow ? ` by about ${overflow}` : ""}.
        </p>
        <p style={exportDialogHintStyle}>
          Resize the page to {recommendedLabel} and place the import on the page, or keep the current page size and leave the overflow unchanged.
        </p>
        <div style={exportDialogFooterStyle}>
          <button type="button" style={exportDialogButtonStyle} onClick={onKeep}>
            Keep Current Page
          </button>
          <button type="button" style={exportDialogPrimaryButtonStyle} onClick={onResize}>
            Use {recommendedLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function pageFitPromptLayoutLabel(pageTitle: string, orientation: "portrait" | "landscape"): string {
  return `${pageTitle} ${orientation === "landscape" ? "Landscape" : "Portrait"}`;
}

/** The recommended-size label: a custom title already carries its dimensions, so the
 *  portrait/landscape suffix (meaningful only for presets) is omitted for it. */
function pageFitRecommendedLabel(recommendation: ImportedPageFitRecommendation): string {
  return recommendation.recommendedPresetId === "custom"
    ? recommendation.recommendedPageTitle
    : pageFitPromptLayoutLabel(recommendation.recommendedPageTitle, recommendation.recommendedOrientation);
}

function formatPageSizeFieldValue(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function pageSizeUnitShortLabel(unit: PageSizeUnit): string {
  return unit === "inch" ? "in" : unit === "mm" ? "mm" : "px";
}

const customPageFieldLabelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--cd-text-secondary)"
};

const customPageInputStyle: CSSProperties = {
  width: 110,
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--cd-border-subtle)",
  background: "var(--cd-bg-panel)",
  color: "var(--cd-text-primary)",
  fontSize: 13
};

interface CustomPageSizeDialogProps {
  state: CustomPageSizeDialogState;
  onChange: (next: CustomPageSizeDialogState) => void;
  onCancel: () => void;
  onApply: (size: { width: number; height: number; unit: PageSizeUnit }) => void;
}

function CustomPageSizeDialog({ state, onChange, onCancel, onApply }: CustomPageSizeDialogProps) {
  const width = Number.parseFloat(state.width);
  const height = Number.parseFloat(state.height);
  const valid = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
  const selectUnit = state.unit === "mm" ? "mm" : "inch";

  const changeUnit = (unit: PageSizeUnit) => {
    if (unit === state.unit) {
      return;
    }
    // Convert the entered values so the physical size is preserved across the unit switch.
    const convert = (raw: string): string => {
      const value = Number.parseFloat(raw);
      return Number.isFinite(value)
        ? formatPageSizeFieldValue(cssPxToPageSize(pageSizeToCssPx(value, state.unit), unit))
        : raw;
    };
    onChange({ unit, width: convert(state.width), height: convert(state.height) });
  };

  const submit = () => {
    if (valid) {
      onApply({ width, height, unit: state.unit });
    }
  };
  const onFieldKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      submit();
    }
  };

  return (
    <div aria-label="Custom page size" aria-modal="true" role="dialog" style={exportDialogBackdropStyle}>
      <section style={exportDialogPanelStyle}>
        <div style={exportDialogHeaderStyle}>
          <h2 style={exportDialogTitleStyle}>Custom Page Size</h2>
        </div>
        <p style={exportDialogHintStyle}>Enter the page width and height. Margins are kept from the current page.</p>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={customPageFieldLabelStyle}>
            Width
            <input
              type="number"
              min="0"
              step="any"
              value={state.width}
              style={customPageInputStyle}
              onChange={(event) => onChange({ ...state, width: event.target.value })}
              onKeyDown={onFieldKeyDown}
              autoFocus
            />
          </label>
          <span style={{ paddingBottom: 8, color: "var(--cd-text-secondary)" }}>×</span>
          <label style={customPageFieldLabelStyle}>
            Height
            <input
              type="number"
              min="0"
              step="any"
              value={state.height}
              style={customPageInputStyle}
              onChange={(event) => onChange({ ...state, height: event.target.value })}
              onKeyDown={onFieldKeyDown}
            />
          </label>
          <label style={customPageFieldLabelStyle}>
            Units
            <select
              value={selectUnit}
              style={customPageInputStyle}
              onChange={(event) => changeUnit(event.target.value as PageSizeUnit)}
            >
              <option value="inch">Inches</option>
              <option value="mm">Millimeters</option>
            </select>
          </label>
        </div>
        <div style={exportDialogFooterStyle}>
          <button type="button" style={exportDialogButtonStyle} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            style={{ ...exportDialogPrimaryButtonStyle, opacity: valid ? 1 : 0.5, cursor: valid ? "pointer" : "not-allowed" }}
            onClick={submit}
            disabled={!valid}
          >
            Apply
          </button>
        </div>
      </section>
    </div>
  );
}

interface ExportDialogProps {
  state: ExportDialogState;
  onCancel: () => void;
  onChooseDestination: () => void | Promise<void>;
  onFilenameChange: (filename: string) => void;
  onFormatChange: (format: ExportDialogFormat) => void;
  onSvgOptionsChange: (options: Partial<SvgDialogExportOptions>) => void;
  onPdfOptionsChange: (options: Partial<PdfDialogExportOptions>) => void;
  onRasterOptionsChange: (options: Partial<RasterDialogExportOptions>) => void;
  onCdxmlOptionsChange: (options: Partial<CdxmlDialogExportOptions>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
}

function ExportDialog({
  state,
  onCancel,
  onChooseDestination,
  onFilenameChange,
  onFormatChange,
  onSvgOptionsChange,
  onPdfOptionsChange,
  onRasterOptionsChange,
  onCdxmlOptionsChange,
  onSubmit
}: ExportDialogProps) {
  const descriptor = getExportFormatDescriptor(state.format);
  const implemented = descriptor.status === "implemented";
  const rasterFormat = rasterExportFormatForDialogFormat(state.format);
  const destinationLabel = state.destinationPath ?? (isDesktopRuntime() ? "Choose a location" : "Downloads");
  const exportDisabled = state.busy || state.filename.trim() === "" || !implemented;

  return (
    <div
      aria-label="Export"
      aria-modal="true"
      role="dialog"
      style={exportDialogBackdropStyle}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    >
      <form style={exportDialogPanelStyle} onSubmit={onSubmit}>
        <div style={exportDialogHeaderStyle}>
          <h2 style={exportDialogTitleStyle}>Export</h2>
          <button
            aria-label="Close export"
            disabled={state.busy}
            type="button"
            style={exportDialogIconButtonStyle}
            onClick={onCancel}
          >
            x
          </button>
        </div>

        <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-filename">
          Save as
        </label>
        <input
          id="chemdraft-export-filename"
          disabled={state.busy}
          value={state.filename}
          style={exportDialogInputStyle}
          onChange={(event) => onFilenameChange(event.currentTarget.value)}
        />

        <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-format">
          Export as
        </label>
        <select
          id="chemdraft-export-format"
          disabled={state.busy}
          value={state.format}
          style={exportDialogInputStyle}
          onChange={(event) => {
            onFormatChange(event.currentTarget.value as ExportDialogFormat);
          }}
        >
          {exportFormatGroups.map((group) => (
            <optgroup key={group} label={exportFormatGroupLabels[group]}>
              {exportFormatDescriptors
                .filter((candidate) => candidate.group === group)
                .map((candidate) => {
                  const rasterOnly = rasterExportFormatForDialogFormat(candidate.id) !== undefined;
                  const unavailableInBrowser = rasterOnly && !isDesktopRuntime();
                  return (
                    <option key={candidate.id} value={candidate.id} disabled={unavailableInBrowser}>
                      {candidate.label}
                      {candidate.status === "implemented" ? "" : ` (${candidate.status})`}
                      {unavailableInBrowser ? " (desktop only)" : ""}
                    </option>
                  );
                })}
            </optgroup>
          ))}
        </select>
        {descriptor.warningSummary || !implemented ? (
          <p style={implemented ? exportDialogHintStyle : exportDialogWarningStyle}>
            {descriptor.warningSummary ?? `${descriptor.menuLabel} export is not available yet.`}
          </p>
        ) : null}

        <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-destination">
          Where
        </label>
        <div style={exportDialogDestinationRowStyle}>
          <input
            id="chemdraft-export-destination"
            readOnly
            value={destinationLabel}
            style={{ ...exportDialogInputStyle, ...exportDialogDestinationInputStyle }}
          />
          <button
            disabled={state.busy || !isDesktopRuntime() || !implemented}
            type="button"
            style={exportDialogButtonStyle}
            onClick={() => {
              void onChooseDestination();
            }}
          >
            Choose...
          </button>
        </div>

        {state.format === "svg" ? (
          <fieldset style={exportDialogFieldsetStyle}>
            <legend style={exportDialogLegendStyle}>SVG</legend>
            <label style={exportDialogCheckboxRowStyle}>
              <input
                checked={state.svg.includeWarnings}
                disabled={state.busy}
                type="checkbox"
                onChange={(event) => onSvgOptionsChange({ includeWarnings: event.currentTarget.checked })}
              />
              Include warning metadata
            </label>
            <label style={exportDialogCheckboxRowStyle}>
              <input
                checked={state.svg.includePageGuides}
                disabled={state.busy}
                type="checkbox"
                onChange={(event) => onSvgOptionsChange({ includePageGuides: event.currentTarget.checked })}
              />
              Include page guides
            </label>
          </fieldset>
        ) : null}

        {state.format === "pdf" ? (
          <fieldset style={exportDialogFieldsetStyle}>
            <legend style={exportDialogLegendStyle}>PDF</legend>
            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-pdf-type">
              PDF type
            </label>
            <select
              id="chemdraft-export-pdf-type"
              disabled={state.busy}
              value={state.pdf.pdfType}
              style={exportDialogInputStyle}
              onChange={() => undefined}
            >
              <option value="vector">Vector PDF</option>
            </select>

            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-pdf-page">
              Page
            </label>
            <select
              id="chemdraft-export-pdf-page"
              disabled={state.busy}
              value={state.pdf.page}
              style={exportDialogInputStyle}
              onChange={() => undefined}
            >
              <option value="current">Current page</option>
            </select>

            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-pdf-background">
              Background
            </label>
            <select
              id="chemdraft-export-pdf-background"
              disabled={state.busy}
              value={state.pdf.background}
              style={exportDialogInputStyle}
              onChange={() => undefined}
            >
              <option value="white">White page</option>
            </select>

            <label style={exportDialogCheckboxRowStyle}>
              <input
                checked={state.pdf.compress}
                disabled={state.busy}
                type="checkbox"
                onChange={(event) => onPdfOptionsChange({ compress: event.currentTarget.checked })}
              />
              Compress PDF
            </label>
            <label style={exportDialogCheckboxRowStyle}>
              <input
                checked={state.pdf.includePageGuides}
                disabled={state.busy}
                type="checkbox"
                onChange={(event) => onPdfOptionsChange({ includePageGuides: event.currentTarget.checked })}
              />
              Include page guides
            </label>
          </fieldset>
        ) : null}

        {rasterFormat ? (
          <fieldset style={exportDialogFieldsetStyle}>
            <legend style={exportDialogLegendStyle}>{descriptor.menuLabel}</legend>
            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-raster-scale">
              Scale
            </label>
            <select
              id="chemdraft-export-raster-scale"
              disabled={state.busy}
              value={String(state.raster.scale)}
              style={exportDialogInputStyle}
              onChange={(event) => onRasterOptionsChange({ scale: Number(event.currentTarget.value) })}
            >
              <option value="1">1x</option>
              <option value="2">2x</option>
              <option value="3">3x</option>
              <option value="4">4x</option>
            </select>

            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-raster-background">
              Background
            </label>
            <select
              id="chemdraft-export-raster-background"
              disabled={state.busy}
              value={state.raster.background}
              style={exportDialogInputStyle}
              onChange={(event) => {
                const value = event.currentTarget.value === "transparent" ? "transparent" : "white";
                onRasterOptionsChange({ background: value });
              }}
            >
              <option value="white">White page</option>
              <option value="transparent" disabled={rasterFormat !== "png"}>
                Transparent
              </option>
            </select>

            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-raster-max">
              Max dimension
            </label>
            <input
              id="chemdraft-export-raster-max"
              disabled={state.busy}
              min={256}
              max={8192}
              step={256}
              type="number"
              value={state.raster.maxDimensionPx}
              style={exportDialogInputStyle}
              onChange={(event) => onRasterOptionsChange({ maxDimensionPx: Number(event.currentTarget.value) })}
            />

            {rasterFormat === "jpeg" ? (
              <>
                <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-jpeg-quality">
                  JPEG quality
                </label>
                <input
                  id="chemdraft-export-jpeg-quality"
                  disabled={state.busy}
                  min={1}
                  max={100}
                  step={1}
                  type="range"
                  value={state.raster.jpegQuality}
                  style={exportDialogInputStyle}
                  onChange={(event) => onRasterOptionsChange({ jpegQuality: Number(event.currentTarget.value) })}
                />
              </>
            ) : null}
          </fieldset>
        ) : null}

        {state.format === "cdxml" ? (
          <fieldset style={exportDialogFieldsetStyle}>
            <legend style={exportDialogLegendStyle}>CDXML</legend>
            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-cdxml-program">
              Creation program
            </label>
            <input
              id="chemdraft-export-cdxml-program"
              disabled={state.busy}
              value={state.cdxml.creationProgram}
              style={exportDialogInputStyle}
              onChange={(event) => onCdxmlOptionsChange({ creationProgram: event.currentTarget.value })}
            />
          </fieldset>
        ) : null}

        <div style={exportDialogFooterStyle}>
          <button disabled={state.busy} type="button" style={exportDialogButtonStyle} onClick={onCancel}>
            Cancel
          </button>
          <button disabled={exportDisabled} type="submit" style={exportDialogPrimaryButtonStyle}>
            {state.busy ? "Exporting..." : "Export"}
          </button>
        </div>
      </form>
    </div>
  );
}

function createDefaultExportDialogState(
  document: ChemDraftDocument,
  destinationDirectory?: string
): ExportDialogState {
  const descriptor = getExportFormatDescriptor("pdf");
  const filename = createExportFilename(document, descriptor.extensions[0] ?? descriptor.id);
  return {
    format: descriptor.id,
    filename,
    destinationPath: nativePathJoin(destinationDirectory, filename),
    svg: {
      includeWarnings: true,
      includePageGuides: false
    },
    pdf: {
      compress: true,
      includePageGuides: false,
      page: "current",
      pdfType: "vector",
      background: "white"
    },
    raster: {
      scale: 1,
      background: "white",
      jpegQuality: 90,
      maxDimensionPx: 8192
    },
    cdxml: {
      creationProgram: "ChemDraft"
    },
    busy: false
  };
}

function updateExportDialogFormat(state: ExportDialogState, format: ExportDialogFormat): ExportDialogState {
  const descriptor = getExportFormatDescriptor(format);
  const rasterFormat = rasterExportFormatForDialogFormat(format);
  const filename = replaceExportFileExtension(state.filename, descriptor);
  return {
    ...state,
    format,
    filename,
    destinationPath: nativePathWithBasename(state.destinationPath, filename),
    raster: {
      ...state.raster,
      background: rasterFormat === "png" ? state.raster.background : "white"
    }
  };
}

function rasterExportFormatForDialogFormat(format: ExportFormatId): NativeRasterExportFormat | undefined {
  return rasterExportFormatsByFormatId[format];
}

function replaceExportFileExtension(filename: string, descriptor: ExportFormatDescriptor): string {
  const extension = descriptor.extensions[0] ?? descriptor.id;
  const trimmed = filename.trim() || "Untitled";
  const escapedExtensions = exportFormatOptionExtensions.map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const knownExportExtension = new RegExp(`\\.(${escapedExtensions.join("|")})$`, "i");
  return `${trimmed.replace(knownExportExtension, "")}.${extension}`;
}

const exportDialogBackdropStyle: CSSProperties = {
  alignItems: "center",
  background: "rgba(12, 18, 24, 0.22)",
  display: "flex",
  inset: 0,
  justifyContent: "center",
  padding: 24,
  position: "absolute",
  zIndex: 1200
};

const exportDialogPanelStyle: CSSProperties = {
  background: "#f7f9fb",
  border: "1px solid #b7c1ca",
  borderRadius: 8,
  boxShadow: "0 18px 48px rgba(20, 30, 40, 0.22)",
  color: "#18212a",
  display: "grid",
  gap: 8,
  maxHeight: "calc(100vh - 64px)",
  maxWidth: "calc(100vw - 48px)",
  overflow: "auto",
  padding: 16,
  width: 480
};

const exportDialogHeaderStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  justifyContent: "space-between",
  marginBottom: 4
};

const exportDialogTitleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 650,
  lineHeight: 1.2,
  margin: 0
};

const exportDialogLabelStyle: CSSProperties = {
  color: "#44515e",
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.2,
  marginTop: 4
};

const exportDialogInputStyle: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #aeb8c2",
  borderRadius: 6,
  boxSizing: "border-box",
  color: "#18212a",
  font: "inherit",
  fontSize: 13,
  minHeight: 30,
  padding: "4px 8px",
  width: "100%"
};

const exportDialogHintStyle: CSSProperties = {
  color: "#52606d",
  fontSize: 12,
  lineHeight: 1.3,
  margin: "0 0 2px"
};

const exportDialogWarningStyle: CSSProperties = {
  ...exportDialogHintStyle,
  color: "#875300"
};

const exportDialogDestinationRowStyle: CSSProperties = {
  alignItems: "center",
  display: "grid",
  gap: 8,
  gridTemplateColumns: "minmax(0, 1fr) auto"
};

const exportDialogDestinationInputStyle: CSSProperties = {
  color: "#52606d",
  overflow: "hidden",
  textOverflow: "ellipsis"
};

const exportDialogFieldsetStyle: CSSProperties = {
  border: "1px solid #c8d0d8",
  borderRadius: 8,
  display: "grid",
  gap: 8,
  margin: "8px 0 0",
  padding: "10px 12px 12px"
};

const exportDialogLegendStyle: CSSProperties = {
  color: "#44515e",
  fontSize: 12,
  fontWeight: 650,
  padding: "0 4px"
};

const exportDialogCheckboxRowStyle: CSSProperties = {
  alignItems: "center",
  color: "#28343f",
  display: "flex",
  fontSize: 13,
  gap: 8,
  lineHeight: 1.2,
  marginTop: 4
};

const exportDialogFooterStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
  marginTop: 10
};

const exportDialogButtonStyle: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #aeb8c2",
  borderRadius: 6,
  color: "#18212a",
  font: "inherit",
  fontSize: 13,
  minHeight: 30,
  padding: "4px 12px"
};

const exportDialogPrimaryButtonStyle: CSSProperties = {
  ...exportDialogButtonStyle,
  background: "#1967d2",
  borderColor: "#1967d2",
  color: "#ffffff"
};

const exportDialogIconButtonStyle: CSSProperties = {
  ...exportDialogButtonStyle,
  borderRadius: 999,
  height: 28,
  minHeight: 28,
  padding: 0,
  width: 28
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function markFrame<T>(label: string, fn: () => T): T {
  const perf = typeof performance !== "undefined" ? performance : undefined;
  const start = perf?.now();
  try {
    return fn();
  } finally {
    if (start !== undefined) {
      const elapsed = perf!.now() - start;
      if (elapsed > 8) {
        console.warn(`[perf] ${label}: ${elapsed.toFixed(1)}ms`);
      }
    }
  }
}

function clientPointDistance(left: ClientPoint, right: ClientPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function freehandPointFromPointerEvent(point: ClientPoint, event: Pick<ObjectPointerEvent, "pressure">): GraphicFreehandPoint {
  const pressure = typeof event.pressure === "number" && Number.isFinite(event.pressure) && event.pressure > 0
    ? clamp(event.pressure, 0, 1)
    : 0.5;
  return {
    x: point.x,
    y: point.y,
    pressure
  };
}

function appendFreehandDragPoint(drag: FreehandArtDragState, point: GraphicFreehandPoint): void {
  const previous = drag.points[drag.points.length - 1];
  if (
    previous &&
    Math.hypot(previous.x - point.x, previous.y - point.y) < 0.75 &&
    Math.abs((previous.pressure ?? 0.5) - (point.pressure ?? 0.5)) < 0.01
  ) {
    return;
  }
  drag.points.push(point);
}

function resetFreehandArtPreviewPath(path: SVGPathElement | null): void {
  if (!path) {
    return;
  }

  path.removeAttribute("d");
  path.removeAttribute("stroke");
  path.removeAttribute("stroke-width");
  path.removeAttribute("data-active");
}

function freehandArtPreviewPathD(points: readonly GraphicFreehandPoint[]): string {
  const [first, ...rest] = points;
  if (!first) {
    return "";
  }

  if (rest.length === 0) {
    return `M ${formatSvgNumber(first.x)} ${formatSvgNumber(first.y)} L ${formatSvgNumber(first.x + 0.01)} ${formatSvgNumber(first.y)}`;
  }

  return [
    `M ${formatSvgNumber(first.x)} ${formatSvgNumber(first.y)}`,
    ...rest.map((point) => `L ${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`)
  ].join(" ");
}

function pathArtPreviewPathD(preview: PathArtPreviewState): string {
  const nodes = preview.nodes.map((node) => ({ ...node }));
  const lastNode = nodes[nodes.length - 1];
  if (
    preview.latestPoint &&
    (!lastNode || clientPointDistance(lastNode.point, preview.latestPoint) >= 0.75)
  ) {
    nodes.push({ point: preview.latestPoint });
  }

  const [first, ...rest] = nodes;
  if (!first) {
    return "";
  }

  if (rest.length === 0) {
    return `M ${formatSvgNumber(first.point.x)} ${formatSvgNumber(first.point.y)} L ${formatSvgNumber(first.point.x + 0.01)} ${formatSvgNumber(first.point.y)}`;
  }

  const commands = [`M ${formatSvgPreviewPoint(first.point)}`];
  for (let index = 1; index < nodes.length; index += 1) {
    commands.push(pathArtPreviewSegmentCommand(preview.pathKind, nodes[index - 1]!, nodes[index]!));
  }
  if (preview.closed) {
    const last = nodes[nodes.length - 1]!;
    if (preview.pathKind === "bezier" && (last.outControl || first.inControl)) {
      commands.push(pathArtPreviewSegmentCommand(preview.pathKind, last, first));
    }
    commands.push("Z");
  }
  return commands.join(" ");
}

function pathArtPreviewControlPlans(preview: PathArtPreviewState): Array<{
  anchor: ClientPoint;
  index: number;
  kind: "in" | "out";
  point: ClientPoint;
}> {
  if (preview.pathKind !== "bezier") {
    return [];
  }

  return preview.nodes.flatMap((node, index) => [
    node.inControl ? {
      anchor: node.point,
      index,
      kind: "in" as const,
      point: node.inControl
    } : undefined,
    node.outControl ? {
      anchor: node.point,
      index,
      kind: "out" as const,
      point: node.outControl
    } : undefined
  ].filter((control): control is {
    anchor: ClientPoint;
    index: number;
    kind: "in" | "out";
    point: ClientPoint;
  } => control !== undefined));
}

function pathArtPreviewSegmentCommand(
  pathKind: PathArtDrawKind,
  startNode: PathArtDrawNode,
  endNode: PathArtDrawNode
): string {
  if (pathKind === "bezier" && (startNode.outControl || endNode.inControl)) {
    return [
      "C",
      formatSvgPreviewPoint(startNode.outControl ?? startNode.point),
      formatSvgPreviewPoint(endNode.inControl ?? endNode.point),
      formatSvgPreviewPoint(endNode.point)
    ].join(" ");
  }

  return `L ${formatSvgPreviewPoint(endNode.point)}`;
}

function formatSvgPreviewPoint(point: ClientPoint): string {
  return `${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`;
}

function pathCloseTolerance(scale: number): number {
  return Math.max(6, 10 / Math.max(scale, 0.1));
}

function penControlDragThreshold(scale: number): number {
  return Math.max(4, PEN_CONTROL_DRAG_THRESHOLD_PX / Math.max(scale, 0.1));
}

function graphicObjectIdsForCssDragPreview(drag: ObjectDragState): string[] | undefined {
  const objectIds = drag.groupObjectIds && drag.groupObjectIds.length > 1
    ? [...drag.groupObjectIds]
    : [drag.objectId];
  return objectIds.every((objectId) => findDocumentObject(drag.startDocument, objectId)?.type === "graphic")
    ? objectIds
    : undefined;
}

function createArtTransformDragPreviewProxies(
  document: ChemDraftDocument,
  objectIds: readonly string[],
  viewportScale: number
): Record<string, ArtTransformDragPreviewProxy> | undefined {
  if (objectIds.length === 0) {
    return undefined;
  }

  const proxies: Record<string, ArtTransformDragPreviewProxy> = {};
  for (const objectId of objectIds) {
    const object = findDocumentObject(document, objectId);
    if (object?.type !== "graphic") {
      return undefined;
    }
    proxies[objectId] = createGraphicArtTransformDragPreviewProxy(object, viewportScale);
  }

  return proxies;
}

function createGraphicArtTransformDragPreviewProxy(
  object: GraphicObject,
  viewportScale: number
): ArtTransformDragPreviewProxy {
  const rasterScale = Math.max(0.25, viewportScale);
  if (ART_TRANSFORM_DRAG_PREVIEW_BOUNDS_ONLY) {
    return {
      kind: "bounds",
      width: Math.max(1, object.width),
      height: Math.max(1, object.height),
      rasterScale
    };
  }

  const preview = graphicArtTransformPreviewSvgDataUrl(object);
  return preview
    ? { kind: "svg-image", ...preview, rasterScale }
    : { kind: "bounds", width: Math.max(1, object.width), height: Math.max(1, object.height), rasterScale };
}

export function graphicArtTransformPreviewSvgDataUrl(object: GraphicObject): {
  imageUrl: string;
  width: number;
  height: number;
} | undefined {
  try {
    const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
    const width = Math.max(1, plan.width);
    const height = Math.max(1, plan.height);
    const freehandPath = graphicObjectIsFreehandPath(object);
    const fillPaintId = `preview-fill-${object.id}`;
    const strokePaintId = `preview-stroke-${object.id}`;
    const glossPaintId = `preview-gloss-${object.id}`;
    const effectFilterId = `preview-effects-${object.id}`;
    const strokeAttrs = [
      previewSvgPaintAttrs("stroke", plan.stroke.paint, strokePaintId),
      `stroke-width="${xmlAttributeValue(plan.stroke.width)}"`,
      plan.stroke.dasharray ? `stroke-dasharray="${xmlAttributeValue(plan.stroke.dasharray)}"` : "",
      `stroke-linecap="${xmlAttributeValue(plan.stroke.lineCap)}"`,
      `stroke-linejoin="${xmlAttributeValue(plan.stroke.lineJoin)}"`,
      `stroke-miterlimit="${xmlAttributeValue(plan.stroke.miterLimit)}"`,
      `vector-effect="${plan.projectionTransform ? "none" : "non-scaling-stroke"}"`
    ].filter(Boolean).join(" ");
    const fillAttrs = plan.fill.mode === "gloss" && plan.glossGradient
      ? previewSvgGlossPaintAttrs(glossPaintId, plan.fill.opacity)
      : previewSvgPaintAttrs("fill", plan.fill.paint, fillPaintId);
    const definitions = [
      plan.fill.mode === "gloss" && plan.glossGradient
        ? previewSvgGlossDefinition(plan.glossGradient, glossPaintId)
        : previewSvgPaintDefinition(plan.fill.paint, fillPaintId),
      previewSvgPaintDefinition(plan.stroke.paint, strokePaintId),
      previewSvgEffectDefinition(plan, effectFilterId)
    ].filter(Boolean).join("");
    const pathD = plan.visiblePathD ?? plan.pathD;
    const projectionTransform = plan.projectionTransform
      ? ` transform="${xmlAttributeValue(plan.projectionTransform)}"`
      : "";
    let body = "";
    const closedFillEffectSource = plan.capabilities.supportsFill && !plan.capabilities.isOpenStroke;
    const pathFillEffectSource = freehandPath || closedFillEffectSource || !plan.capabilities.supportsStroke;

    if (plan.projectedShapePathD) {
      body = [
        previewSvgEffectSourcePath(plan, effectFilterId, plan.projectedShapePathD, closedFillEffectSource),
        `<path d="${xmlAttributeValue(plan.projectedShapePathD)}" ${fillAttrs} ${strokeAttrs}/>`
      ].filter(Boolean).join("");
    } else if (object.graphicKind === "path" && pathD) {
      const pathFillAttrs = freehandPath || plan.capabilities.supportsFill
        ? fillAttrs
        : `fill="none"`;
      body = [
        previewSvgEffectSourcePath(plan, effectFilterId, pathD, pathFillEffectSource, projectionTransform),
        `<path d="${xmlAttributeValue(pathD)}" ${pathFillAttrs} ${strokeAttrs}${projectionTransform}/>`
      ].filter(Boolean).join("");
    } else if (object.graphicKind === "line" && plan.visibleLine) {
      body = [
        previewSvgEffectSourceLine(plan, effectFilterId, plan.visibleLine, projectionTransform),
        `<line x1="${xmlAttributeValue(plan.visibleLine.x1)}" y1="${xmlAttributeValue(plan.visibleLine.y1)}" x2="${xmlAttributeValue(plan.visibleLine.x2)}" y2="${xmlAttributeValue(plan.visibleLine.y2)}" fill="none" ${strokeAttrs}${projectionTransform}/>`
      ].filter(Boolean).join("");
    } else if (object.graphicKind === "rect") {
      const rectGeometry = `x="${xmlAttributeValue(plan.stroke.width / 2)}" y="${xmlAttributeValue(plan.stroke.width / 2)}" width="${xmlAttributeValue(Math.max(width - plan.stroke.width, 0.5))}" height="${xmlAttributeValue(Math.max(height - plan.stroke.width, 0.5))}" rx="${xmlAttributeValue(plan.cornerRadius)}" ry="${xmlAttributeValue(plan.cornerRadius)}"`;
      body = [
        previewSvgEffectSourceShape(plan, effectFilterId, "rect", rectGeometry, closedFillEffectSource, projectionTransform),
        `<rect ${rectGeometry} ${fillAttrs} ${strokeAttrs}${projectionTransform}/>`
      ].filter(Boolean).join("");
    } else if (object.graphicKind === "ellipse") {
      const ellipseGeometry = `cx="${xmlAttributeValue(width / 2)}" cy="${xmlAttributeValue(height / 2)}" rx="${xmlAttributeValue(Math.max(width / 2 - plan.stroke.width / 2, 0.5))}" ry="${xmlAttributeValue(Math.max(height / 2 - plan.stroke.width / 2, 0.5))}"`;
      body = [
        previewSvgEffectSourceShape(plan, effectFilterId, "ellipse", ellipseGeometry, closedFillEffectSource, projectionTransform),
        `<ellipse ${ellipseGeometry} ${fillAttrs} ${strokeAttrs}${projectionTransform}/>`
      ].filter(Boolean).join("");
    }

    if (!body) {
      return undefined;
    }

    const opacity = plan.opacity === 1 ? "" : ` opacity="${xmlAttributeValue(plan.opacity)}"`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${xmlAttributeValue(width)}" height="${xmlAttributeValue(height)}" viewBox="0 0 ${xmlAttributeValue(width)} ${xmlAttributeValue(height)}"${opacity}>${definitions}${body}${previewSvgSketchEffects(plan, object.id)}</svg>`;
    return {
      imageUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      width,
      height
    };
  } catch {
    return undefined;
  }
}

function previewSvgPaintAttrs(
  attribute: "fill" | "stroke",
  paint: NativeArtPaintPlan,
  id: string
): string {
  if (paint.kind === "none") {
    return `${attribute}="none"`;
  }
  if (paint.kind === "solid") {
    return [
      `${attribute}="${xmlAttributeValue(paint.color)}"`,
      paint.opacity === 1 ? "" : `${attribute}-opacity="${xmlAttributeValue(paint.opacity)}"`
    ].filter(Boolean).join(" ");
  }
  return `${attribute}="url(#${xmlAttributeValue(id)})"`;
}

function previewSvgPaintDefinition(paint: NativeArtPaintPlan, id: string): string {
  if (paint.kind === "linear-gradient") {
    return `<defs><linearGradient id="${xmlAttributeValue(id)}" x1="${xmlAttributeValue(paint.x1)}" y1="${xmlAttributeValue(paint.y1)}" x2="${xmlAttributeValue(paint.x2)}" y2="${xmlAttributeValue(paint.y2)}"${previewSvgGradientTransformAttr(paint.gradientTransform)} gradientUnits="userSpaceOnUse">${previewSvgGradientStops(paint.stops)}</linearGradient></defs>`;
  }
  if (paint.kind === "radial-gradient") {
    return `<defs><radialGradient id="${xmlAttributeValue(id)}" cx="${xmlAttributeValue(paint.cx)}" cy="${xmlAttributeValue(paint.cy)}" r="${xmlAttributeValue(paint.r)}"${typeof paint.fx === "number" ? ` fx="${xmlAttributeValue(paint.fx)}"` : ""}${typeof paint.fy === "number" ? ` fy="${xmlAttributeValue(paint.fy)}"` : ""}${previewSvgGradientTransformAttr(paint.gradientTransform)} gradientUnits="userSpaceOnUse">${previewSvgGradientStops(paint.stops)}</radialGradient></defs>`;
  }
  return "";
}

function previewSvgGlossPaintAttrs(id: string, opacity: number): string {
  return [
    `fill="url(#${xmlAttributeValue(id)})"`,
    opacity === 1 ? "" : `fill-opacity="${xmlAttributeValue(opacity)}"`
  ].filter(Boolean).join(" ");
}

function previewSvgGlossDefinition(
  gradient: NonNullable<NativeArtVisualPlan["glossGradient"]>,
  id: string
): string {
  return `<defs><radialGradient id="${xmlAttributeValue(id)}" cx="${xmlAttributeValue(gradient.cx)}" cy="${xmlAttributeValue(gradient.cy)}" r="${xmlAttributeValue(gradient.r)}"${previewSvgGradientTransformAttr(gradient.gradientTransform)} gradientUnits="userSpaceOnUse">${previewSvgGradientStops(gradient.stops)}</radialGradient></defs>`;
}

function previewSvgEffectSourceAttrs(
  plan: NativeArtVisualPlan,
  effectFilterId: string,
  includeFill: boolean
): string {
  const hasFilter = plan.effects.some((effect) => effect.kind === "shadow" || effect.kind === "glow");
  if (!hasFilter) {
    return "";
  }

  const fill = includeFill && plan.fill.paint.kind !== "none" ? "#000000" : "none";
  const stroke = plan.capabilities.supportsStroke && plan.stroke.paint.kind !== "none" ? "#000000" : "none";
  return [
    `class="graphic-glyph-effect-source"`,
    `data-graphic-effect-source="true"`,
    `fill="${fill}"`,
    `stroke="${stroke}"`,
    `stroke-width="${xmlAttributeValue(plan.stroke.width)}"`,
    plan.stroke.dasharray ? `stroke-dasharray="${xmlAttributeValue(plan.stroke.dasharray)}"` : "",
    `stroke-linecap="${xmlAttributeValue(plan.stroke.lineCap)}"`,
    `stroke-linejoin="${xmlAttributeValue(plan.stroke.lineJoin)}"`,
    `stroke-miterlimit="${xmlAttributeValue(plan.stroke.miterLimit)}"`,
    `vector-effect="${plan.projectionTransform ? "none" : "non-scaling-stroke"}"`,
    `pointer-events="none"`,
    `filter="url(#${xmlAttributeValue(effectFilterId)})"`
  ].filter(Boolean).join(" ");
}

function previewSvgEffectSourcePath(
  plan: NativeArtVisualPlan,
  effectFilterId: string,
  pathD: string,
  includeFill: boolean,
  transform = ""
): string {
  const attrs = previewSvgEffectSourceAttrs(plan, effectFilterId, includeFill);
  return attrs ? `<path d="${xmlAttributeValue(pathD)}" ${attrs}${transform}/>` : "";
}

function previewSvgEffectSourceLine(
  plan: NativeArtVisualPlan,
  effectFilterId: string,
  line: NonNullable<NativeArtVisualPlan["visibleLine"]>,
  transform = ""
): string {
  const attrs = previewSvgEffectSourceAttrs(plan, effectFilterId, false);
  return attrs
    ? `<line x1="${xmlAttributeValue(line.x1)}" y1="${xmlAttributeValue(line.y1)}" x2="${xmlAttributeValue(line.x2)}" y2="${xmlAttributeValue(line.y2)}" ${attrs}${transform}/>`
    : "";
}

function previewSvgEffectSourceShape(
  plan: NativeArtVisualPlan,
  effectFilterId: string,
  tag: "ellipse" | "rect",
  geometry: string,
  includeFill: boolean,
  transform = ""
): string {
  const attrs = previewSvgEffectSourceAttrs(plan, effectFilterId, includeFill);
  return attrs ? `<${tag} ${geometry} ${attrs}${transform}/>` : "";
}

type SvgEffectFilterRegion = { x: number; y: number; width: number; height: number };

function svgEffectPadding(effect: NativeArtVisualPlan["effects"][number]): number {
  if (effect.kind === "shadow") {
    return Math.max(Math.abs(effect.offsetX), Math.abs(effect.offsetY)) + effect.blurPx * 4 + 2;
  }
  if (effect.kind === "glow") {
    return effect.blurPx * 4 + effect.spreadPx * 2 + 2;
  }
  return 0;
}

function svgEffectFilterRegionForPlan(plan: NativeArtVisualPlan): SvgEffectFilterRegion {
  const padding = Math.max(24, ...plan.effects.map(svgEffectPadding));
  return {
    x: plan.frameBounds.x - padding,
    y: plan.frameBounds.y - padding,
    width: Math.max(plan.frameBounds.width + padding * 2, 1),
    height: Math.max(plan.frameBounds.height + padding * 2, 1)
  };
}

function previewSvgEffectDefinition(plan: NativeArtVisualPlan, id: string): string {
  const effects = plan.effects.filter((effect): effect is Extract<NativeArtVisualPlan["effects"][number], { kind: "shadow" | "glow" }> =>
    effect.kind === "shadow" || effect.kind === "glow"
  );
  if (effects.length === 0) {
    return "";
  }

  const children: string[] = [];
  const mergeInputs: string[] = [];
  effects.forEach((effect) => {
    if (effect.kind === "shadow") {
      const blurResult = `${id}-shadow-blur`;
      const offsetResult = `${id}-shadow-offset`;
      const floodResult = `${id}-shadow-color`;
      const result = `${id}-shadow`;
      children.push(
        `<feGaussianBlur in="SourceAlpha" stdDeviation="${xmlAttributeValue(effect.blurPx)}" result="${xmlAttributeValue(blurResult)}"/>`,
        `<feOffset in="${xmlAttributeValue(blurResult)}" dx="${xmlAttributeValue(effect.offsetX)}" dy="${xmlAttributeValue(effect.offsetY)}" result="${xmlAttributeValue(offsetResult)}"/>`,
        `<feFlood flood-color="${xmlAttributeValue(effect.color)}" flood-opacity="${xmlAttributeValue(effect.opacity)}" result="${xmlAttributeValue(floodResult)}"/>`,
        `<feComposite in="${xmlAttributeValue(floodResult)}" in2="${xmlAttributeValue(offsetResult)}" operator="in" result="${xmlAttributeValue(result)}"/>`
      );
      mergeInputs.push(result);
      return;
    }

    const spreadResult = `${id}-glow-spread`;
    const blurInput = effect.spreadPx > 0 ? spreadResult : "SourceAlpha";
    const blurResult = `${id}-glow-blur`;
    const floodResult = `${id}-glow-color`;
    const compositeResult = `${id}-glow`;
    if (effect.spreadPx > 0) {
      children.push(`<feMorphology in="SourceAlpha" operator="dilate" radius="${xmlAttributeValue(effect.spreadPx)}" result="${xmlAttributeValue(spreadResult)}"/>`);
    }
    children.push(
      `<feGaussianBlur in="${xmlAttributeValue(blurInput)}" stdDeviation="${xmlAttributeValue(effect.blurPx)}" result="${xmlAttributeValue(blurResult)}"/>`,
      `<feFlood flood-color="${xmlAttributeValue(effect.color)}" flood-opacity="${xmlAttributeValue(effect.opacity)}" result="${xmlAttributeValue(floodResult)}"/>`,
      `<feComposite in="${xmlAttributeValue(floodResult)}" in2="${xmlAttributeValue(blurResult)}" operator="in" result="${xmlAttributeValue(compositeResult)}"/>`
    );
    mergeInputs.push(compositeResult);
  });

  const mergeNodes = [
    ...mergeInputs.map((input) => `<feMergeNode in="${xmlAttributeValue(input)}"/>`)
  ].join("");
  const region = svgEffectFilterRegionForPlan(plan);
  return [
    `<defs><filter id="${xmlAttributeValue(id)}" filterUnits="userSpaceOnUse"`,
    ` x="${xmlAttributeValue(region.x)}" y="${xmlAttributeValue(region.y)}"`,
    ` width="${xmlAttributeValue(region.width)}" height="${xmlAttributeValue(region.height)}"`,
    ` color-interpolation-filters="sRGB">${children.join("")}<feMerge>${mergeNodes}</feMerge></filter></defs>`
  ].join("");
}

function previewSvgSketchEffects(plan: NativeArtVisualPlan, objectId: string): string {
  const sketch = plan.effects.find((effect) => effect.kind === "sketch");
  if (!sketch) {
    return "";
  }

  const transform = plan.projectedShapePathD || !plan.projectionTransform
    ? ""
    : ` transform="${xmlAttributeValue(plan.projectionTransform)}"`;
  return sketch.paths.map((path, index) => [
    `<path class="graphic-glyph-sketch" data-preview-sketch="${xmlAttributeValue(`${objectId}-${index}`)}"`,
    ` d="${xmlAttributeValue(path.d)}"`,
    ` fill="${xmlAttributeValue(path.fill ?? "none")}"`,
    ` stroke="${xmlAttributeValue(path.stroke)}"`,
    ` stroke-width="${xmlAttributeValue(path.strokeWidth)}"`,
    sketch.opacity === 1 ? "" : ` stroke-opacity="${xmlAttributeValue(sketch.opacity)}"`,
    ` stroke-linecap="round" stroke-linejoin="round" pointer-events="none"${transform}/>`
  ].join("")).join("");
}

type PreviewSvgGradientStop = { offset: number; color: string; opacity: number };

function previewSvgGradientStops(stops: readonly PreviewSvgGradientStop[]): string {
  return stops.map((stop) => [
    `<stop offset="${xmlAttributeValue(`${Number((stop.offset * 100).toFixed(4))}%`)}"`,
    ` stop-color="${xmlAttributeValue(stop.color)}"`,
    stop.opacity === 1 ? "" : ` stop-opacity="${xmlAttributeValue(stop.opacity)}"`,
    "/>"
  ].join("")).join("");
}

function previewSvgGradientTransformAttr(transform: string | undefined): string {
  return transform ? ` gradientTransform="${xmlAttributeValue(transform)}"` : "";
}

function xmlAttributeValue(value: string | number | undefined): string {
  const text = typeof value === "number" ? String(formatSvgNumber(value)) : String(value ?? "");
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function artObjectPreviewElement(root: HTMLElement, objectId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-object-id="${cssEscapeIdentifier(objectId)}"].graphic-object`);
}

function canPreviewGraphicObjectColorOnDom(
  document: ChemDraftDocument,
  objectIds: readonly string[],
  target: GraphicStylePaintTarget
): boolean {
  return objectIds.every((objectId) => {
    const object = findDocumentObject(document, objectId);
    if (object?.type !== "graphic") {
      return true;
    }
    if (target === "fill" && object.style.fillMode === "gloss") {
      return false;
    }
    const paint = target === "fill" ? object.style.fillPaint : object.style.strokePaint;
    return paint?.kind !== "linear-gradient" && paint?.kind !== "radial-gradient";
  });
}

function previewGraphicObjectColorOnDom(
  root: HTMLElement | null,
  document: ChemDraftDocument,
  objectIds: readonly string[],
  target: GraphicStylePaintTarget,
  color: string
): boolean {
  if (!root || objectIds.length === 0) {
    return false;
  }

  let applied = false;
  for (const objectId of objectIds) {
    const object = findDocumentObject(document, objectId);
    if (object?.type !== "graphic") {
      continue;
    }

    const element = artObjectPreviewElement(root, objectId);
    if (!element) {
      continue;
    }

    const freehandPath = graphicObjectIsFreehandPath(object);
    const paintAttribute = freehandPath || target === "fill" ? "fill" : "stroke";
    const selector = freehandPath || target === "fill"
      ? ".graphic-glyph-path, .graphic-glyph-shape, .graphic-glyph-projected-shape"
      : ".graphic-glyph-path, .graphic-glyph-shape, .graphic-glyph-projected-shape, .graphic-glyph-stroke";
    for (const paintElement of Array.from(element.querySelectorAll<SVGElement>(selector))) {
      if (paintElement.classList.contains("graphic-glyph-hit-target") || paintElement.classList.contains("graphic-glyph-shadow")) {
        continue;
      }
      primeArtStylePreviewElement(paintElement, paintAttribute);
      paintElement.setAttribute(paintAttribute, color);
      applied = true;
    }
  }

  return applied;
}

function clearArtStyleDomPreview(root: HTMLElement | null): void {
  if (!root) {
    return;
  }

  for (const element of Array.from(root.querySelectorAll<SVGElement>("[data-art-style-preview='true']"))) {
    restoreArtStylePreviewElement(element);
  }
}

function primeArtStylePreviewElement(element: SVGElement, attribute: "fill" | "stroke"): void {
  element.setAttribute("data-art-style-preview", "true");
  const originalAttribute = `data-art-style-preview-original-${attribute}`;
  if (!element.hasAttribute(originalAttribute)) {
    element.setAttribute(originalAttribute, element.getAttribute(attribute) ?? "");
  }
}

function restoreArtStylePreviewElement(element: SVGElement): void {
  restoreArtStylePreviewAttribute(element, "fill");
  restoreArtStylePreviewAttribute(element, "stroke");
  element.removeAttribute("data-art-style-preview");
}

function restoreArtStylePreviewAttribute(element: SVGElement, attribute: "fill" | "stroke"): void {
  const originalAttribute = `data-art-style-preview-original-${attribute}`;
  if (!element.hasAttribute(originalAttribute)) {
    return;
  }

  const originalValue = element.getAttribute(originalAttribute) ?? "";
  if (originalValue.length > 0) {
    element.setAttribute(attribute, originalValue);
  } else {
    element.removeAttribute(attribute);
  }
  element.removeAttribute(originalAttribute);
}

function cssEscapeIdentifier(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

function findNearestCrossingHit(
  crossings: readonly ResolvedBondCrossing[],
  point: ClientPoint,
  hitRadius = 10
): ResolvedBondCrossing | undefined {
  return crossings
    .map((crossing) => ({
      crossing,
      distance: clientPointDistance(point, crossing.point)
    }))
    .filter((candidate) => candidate.distance <= hitRadius)
    .sort((left, right) => left.distance - right.distance || left.crossing.key.localeCompare(right.crossing.key))[0]?.crossing;
}

function documentObjectCenter(object: Pick<DocumentObject, "x" | "y" | "width" | "height">): ClientPoint {
  return {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2
  };
}

function nativeMoleculeObjectIdsForGroupProjectedPlaneTilt(
  objects: readonly DocumentObject[],
  objectIds: readonly string[]
): string[] {
  if (objectIds.length <= 1) {
    return [];
  }
  const selected = new Set(objectIds);
  const molecules = objects.filter((object): object is MoleculeObject => selected.has(object.id) && object.type === "molecule");
  if (molecules.length !== objectIds.length) {
    return [];
  }
  return molecules.every((object) => isNativeMoleculeGraph(object) && object.atoms.length > 0)
    ? molecules.map((object) => object.id)
    : [];
}

export function rotationDeltaDegrees(center: ClientPoint, start: ClientPoint, latest: ClientPoint): number {
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const latestAngle = Math.atan2(latest.y - center.y, latest.x - center.x);
  let angularDelta = (latestAngle - startAngle) * 180 / Math.PI;
  if (angularDelta > 180) {
    angularDelta -= 360;
  }
  if (angularDelta < -180) {
    angularDelta += 360;
  }

  const radius = clientPointDistance(center, start);
  if (radius <= 0.001) {
    return Number(angularDelta.toFixed(3));
  }

  const tangent = {
    x: -(start.y - center.y) / radius,
    y: (start.x - center.x) / radius
  };
  const dragVector = {
    x: latest.x - start.x,
    y: latest.y - start.y
  };
  return Number(((dragVector.x * tangent.x + dragVector.y * tangent.y) *
    OBJECT_ROTATE_TANGENTIAL_DEGREES_PER_PIXEL).toFixed(3));
}

export function parseRotationInputDegrees(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function rotationInputDraftDegrees(degrees: number): string {
  return `${Number(degrees.toFixed(3))}`;
}

export function rotationInputHomeDraftDegrees(kind: "z"): { draftZDegrees: string };
export function rotationInputHomeDraftDegrees(kind: "xy"): { draftXDegrees: string; draftYDegrees: string };
export function rotationInputHomeDraftDegrees(kind: "z" | "xy") {
  return kind === "z"
    ? { draftZDegrees: "0" }
    : { draftXDegrees: "0", draftYDegrees: "0" };
}

export function parseObjectResizeInputPercent(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function objectResizeInputDraftPercent(scale: number): string {
  return `${objectResizeReadoutPercent(scale)}`;
}

export function manualRotationDeltaDegrees(fromDegrees: number, toDegrees: number): number {
  let delta = normalizeRotationInputDegrees(toDegrees) - normalizeRotationInputDegrees(fromDegrees);
  if (delta > 180) {
    delta -= 360;
  }
  if (delta < -180) {
    delta += 360;
  }
  return Number(delta.toFixed(3));
}

function normalizeRotationInputDegrees(degrees: number): number {
  let normalized = degrees % 360;
  if (normalized < 0) {
    normalized += 360;
  }
  return Number(normalized.toFixed(3));
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function radiansToDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}

export function nativePlacementRotationDegrees(start: ClientPoint, latest: ClientPoint): number {
  const dx = latest.x - start.x;
  const dy = latest.y - start.y;
  if (Math.hypot(dx, dy) <= 0.001) {
    return 0;
  }

  return Number((Math.atan2(dy, dx) * 180 / Math.PI).toFixed(3));
}

export function projectedPlaneTiltRadiansFromDrag(start: ClientPoint, latest: ClientPoint): number {
  const rawTilt = (start.y - latest.y) / PROJECTED_PLANE_TILT_DRAG_PX * projectedPlaneTiltMaxRadians;
  return Number(wrapProjectedPlaneTiltVectorRadians(rawTilt, 0).tiltXRad.toFixed(6));
}

export function projectedPlaneTiltVectorFromDrag(start: ClientPoint, latest: ClientPoint): { xRad: number; yRad: number } {
  const rawXTilt = (start.y - latest.y) / PROJECTED_PLANE_TILT_DRAG_PX * projectedPlaneTiltMaxRadians;
  const rawYTilt = (latest.x - start.x) / PROJECTED_PLANE_TILT_DRAG_PX * projectedPlaneTiltMaxRadians;
  const wrapped = wrapProjectedPlaneTiltVectorRadians(rawXTilt, rawYTilt);
  return {
    xRad: Number(wrapped.tiltXRad.toFixed(6)),
    yRad: Number(wrapped.tiltYRad.toFixed(6))
  };
}

export function documentObjectProjectedPlaneTiltVectorFromDrag(
  start: ClientPoint,
  latest: ClientPoint
): { xRad: number; yRad: number } {
  return projectedPlaneTiltVectorFromDrag(start, latest);
}

export function projectedPlaneTiltReadoutDegrees(tiltRad: number): number {
  return Math.round(Math.abs(tiltRad) * 180 / Math.PI);
}

function projectedPlaneTiltSignedReadoutDegrees(tiltRad: number): number {
  const degrees = Math.round(tiltRad * 180 / Math.PI);
  return Object.is(degrees, -0) ? 0 : degrees;
}

export function projectedPlaneTiltReadoutLabel(tiltXRad: number, tiltYRad = 0): string {
  const xDegrees = projectedPlaneTiltSignedReadoutDegrees(tiltXRad);
  const yDegrees = projectedPlaneTiltSignedReadoutDegrees(tiltYRad);
  if (yDegrees === 0) {
    return `${Math.abs(xDegrees)}°`;
  }
  if (xDegrees === 0) {
    return `Y ${yDegrees}°`;
  }
  // Both axes are non-zero here (the single-axis cases returned above).
  return `X ${xDegrees}° / Y ${yDegrees}°`;
}

export function projectedPlaneTiltCommitHistory(
  currentHistory: DocumentHistory,
  startDocument: ChemDraftDocument,
  nextDocument: ChemDraftDocument
): DocumentHistory {
  return {
    past: [...currentHistory.past, startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
    present: nextDocument,
    future: []
  };
}

export function rotationReadoutDegrees(angleDegrees: number): number {
  const normalized = ((angleDegrees % 360) + 360) % 360;
  const rounded = Math.round(normalized);
  if (rounded === 0 && Math.abs(angleDegrees) >= 0.5) {
    return 360;
  }
  return rounded === 360 ? 360 : rounded;
}

export function cumulativeRotationReadoutDegrees(startDegrees: number, deltaDegrees: number): number {
  return rotationReadoutDegrees(startDegrees + deltaDegrees);
}

export function objectResizeScaleFromDrag(
  center: ClientPoint,
  start: ClientPoint,
  latest: ClientPoint,
  stretch: boolean
): ObjectResizeScale {
  const startVector = {
    x: start.x - center.x,
    y: start.y - center.y
  };
  const latestVector = {
    x: latest.x - center.x,
    y: latest.y - center.y
  };
  const startLengthSquared = startVector.x * startVector.x + startVector.y * startVector.y;
  if (startLengthSquared <= 0.001) {
    return { x: 1, y: 1 };
  }

  if (!stretch) {
    const projectedScale =
      (latestVector.x * startVector.x + latestVector.y * startVector.y) / startLengthSquared;
    const uniformScale = clampObjectResizeScale(projectedScale);
    return { x: uniformScale, y: uniformScale };
  }

  return {
    x: clampObjectResizeScale(Math.abs(startVector.x) <= 0.001 ? 1 : latestVector.x / startVector.x),
    y: clampObjectResizeScale(Math.abs(startVector.y) <= 0.001 ? 1 : latestVector.y / startVector.y)
  };
}

export function objectResizeReadoutPercent(scale: number): number {
  return Math.round(scale * 100);
}

export function cumulativeObjectResizeScale(
  startScale: ObjectResizeScale,
  deltaScale: ObjectResizeScale
): ObjectResizeScale {
  return {
    x: Number((startScale.x * deltaScale.x).toFixed(4)),
    y: Number((startScale.y * deltaScale.y).toFixed(4))
  };
}

function clampObjectResizeScale(scale: number): number {
  return Number(Math.max(OBJECT_RESIZE_MIN_SCALE, scale).toFixed(4));
}

function capitalizeLabel(label: string): string {
  return label.length > 0 ? `${label[0].toUpperCase()}${label.slice(1)}` : label;
}

function graphicPathEditStatus(drag: GraphicPathEditDragState, changed: boolean): string {
  if (/^node:\d+:(in|out)$/.test(drag.handle)) {
    return changed ? "Adjusted Bezier control handle" : "Bezier control handle unchanged";
  }

  if (drag.handle.startsWith("node:")) {
    return changed ? "Moved selected path node" : "Selected path node unchanged";
  }

  const semanticArc = graphicPathEditDragIsSemanticArc(drag);
  if (!changed) {
    return semanticArc ? "Selected arc geometry unchanged" : "Selected line geometry unchanged";
  }
  if (semanticArc) {
    return drag.handle === "middle" ? "Adjusted selected arc radius" : "Adjusted selected arc sweep";
  }
  return drag.handle === "middle" ? "Bent selected line into a curve" : "Adjusted selected line endpoint";
}

function graphicPathEditDragIsSemanticArc(drag: GraphicPathEditDragState): boolean {
  const object = findDocumentObject(drag.workingDocument, drag.objectId) ??
    findDocumentObject(drag.startDocument, drag.objectId);
  const points = object?.type === "graphic" ? nativeGraphicPathEditPoints(object) : undefined;
  return object?.type === "graphic" && points !== undefined && isSemanticCircularGraphicArc(object, points);
}

function nativeGraphicPathEditPointFromProjectedDrag(
  document: ChemDraftDocument,
  objectId: string,
  point: ClientPoint
): ClientPoint {
  const object = findDocumentObject(document, objectId);
  if (object?.type !== "graphic") {
    return point;
  }
  return unprojectGraphicObjectPoint(object, unrotateGraphicVisualPagePoint(object, point), { coordinateSpace: "page" });
}

function nativeGraphicLocalPointFromProjectedDrag(
  document: ChemDraftDocument,
  objectId: string,
  point: ClientPoint
): ClientPoint {
  const object = findDocumentObject(document, objectId);
  if (object?.type === "molecule") {
    return {
      x: point.x - object.x,
      y: point.y - object.y
    };
  }
  if (object?.type !== "graphic") {
    return point;
  }

  const unprojected = unprojectGraphicObjectPoint(object, unrotateGraphicVisualPagePoint(object, point), { coordinateSpace: "page" });
  return {
    x: unprojected.x - object.x,
    y: unprojected.y - object.y
  };
}

function nativeGraphicCornerRadiusPointFromProjectedDrag(
  document: ChemDraftDocument,
  objectId: string,
  point: ClientPoint
): ClientPoint {
  const object = findDocumentObject(document, objectId);
  if (object?.type !== "graphic") {
    return point;
  }
  return nativeGraphicLocalPointFromProjectedDrag(document, objectId, point);
}

function graphicCornerRadiusReadoutValue(object: GraphicObject): number {
  const point = nativeGraphicCornerRadiusEditPoint(object);
  return point ? point.x : 0;
}

function graphicArcSweepRadiansLabel(object: GraphicObject): string {
  const rawSweep = typeof object.data.arcSweepRadians === "number" && Number.isFinite(object.data.arcSweepRadians)
    ? object.data.arcSweepRadians
    : Math.PI;
  const sweep = Math.max(Math.PI / 180, Math.min(Math.PI * 2 - Math.PI / 1800, Math.abs(rawSweep)));
  return `${sweep.toFixed(3)} rad`;
}

function isSemanticCircularGraphicArc(
  object: GraphicObject,
  points: NativeGraphicPathEditPoints
): boolean {
  return points.pathKind === "arc" && object.data.pathControlPoint === undefined;
}

function nativeBondToolStatusLabel(bondStyle: NativeBondDisplayStyle | undefined): string {
  if (bondStyle === "wedge") {
    return "solid wedge bond";
  }
  if (bondStyle === "hashed") {
    return "hashed wedge bond";
  }
  if (bondStyle === "dashed") {
    return "dashed bond";
  }
  if (bondStyle === "bold") {
    return "bold bond";
  }

  return "single bond";
}

function nativePlacementStatusLabel(drag: NativePlacementDragState): string {
  if (drag.kind === "arrow" && drag.arrowKind) {
    return `${nativeReactionArrowStatusLabel(drag.arrowKind)} arrow`;
  }
  if (drag.kind === "chain") {
    return "carbon chain";
  }
  return drag.kind === "template" && drag.templateId
    ? `${nativeTemplateStatusLabel(drag.templateId)} template`
    : `${nativeBondToolStatusLabel(drag.bondStyle)} molecule`;
}

function nativeReactionArrowAriaLabel(arrowKind: ArrowObject["arrowKind"]): string {
  switch (arrowKind) {
    case "forward":
      return "Forward reaction arrow";
    case "resonance":
      return "Resonance arrow";
    case "equilibrium":
      return "Equilibrium arrow";
    case "retrosynthesis":
      return "Retrosynthesis arrow";
    default:
      return "Reaction arrow";
  }
}

function nativeReactionArrowStatusLabel(arrowKind: ArrowObject["arrowKind"]): string {
  switch (arrowKind) {
    case "forward":
      return "reaction";
    case "resonance":
      return "resonance";
    case "equilibrium":
      return "equilibrium";
    case "retrosynthesis":
      return "retrosynthesis";
    default:
      return "reaction";
  }
}

function nativeTemplateStatusLabel(templateId: NativeMoleculeTemplateId): string {
  switch (templateId) {
    case "cyclopentane":
      return "cyclopentane";
    case "cyclohexane":
      return "cyclohexane";
    case "benzene":
      return "benzene";
    case "chairCyclohexaneA":
      return "chair cyclohexane A";
    case "chairCyclohexaneB":
      return "chair cyclohexane B";
    default:
      return "structure";
  }
}

function nativeTemplateStatusForApplication(
  templateId: NativeMoleculeTemplateId,
  target: NativeMoleculeDeleteTarget | undefined,
  changed: boolean
): string {
  if (!target) {
    return `Inserted ${nativeTemplateStatusLabel(templateId)} template`;
  }

  if (!changed) {
    return `${capitalizeLabel(nativeTemplateStatusLabel(templateId))} template not applied`;
  }

  return target.kind === "bond"
    ? `Fused ${nativeTemplateStatusLabel(templateId)} template`
    : `Made spiro ${nativeTemplateStatusLabel(templateId)} template`;
}

function nativeAtomBondCount(molecule: MoleculeObject, atomId: string): number {
  return molecule.bonds.filter((bond) => bond.fromAtomId === atomId || bond.toAtomId === atomId).length;
}

function nativeDoubleBondSidePreviewFromHit(
  objectId: string,
  molecule: MoleculeObject,
  hit: NativeMoleculeDeleteHit,
  point: ClientPoint
): NativeDoubleBondSidePreview | undefined {
  if (hit.kind !== "bond") {
    return undefined;
  }

  const bond = molecule.bonds.find((candidate) => candidate.id === hit.bondId);
  if (!bond || bond.order !== "double") {
    return undefined;
  }

  const fromAtom = molecule.atoms.find((atom) => atom.id === bond.fromAtomId);
  const toAtom = molecule.atoms.find((atom) => atom.id === bond.toAtomId);
  if (!fromAtom || !toAtom) {
    return undefined;
  }

  const dx = toAtom.x - fromAtom.x;
  const dy = toAtom.y - fromAtom.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return undefined;
  }

  const normal = {
    x: -dy / length,
    y: dx / length
  };
  const midpoint = {
    x: (fromAtom.x + toAtom.x) / 2,
    y: (fromAtom.y + toAtom.y) / 2
  };
  const score = (point.x - midpoint.x) * normal.x + (point.y - midpoint.y) * normal.y;

  return {
    objectId,
    bondId: bond.id,
    side: score >= 0 ? "left" : "right"
  };
}

function updateVisibleToolsets(current: ReadonlySet<string>, toolsetId: string, visible: boolean): Set<string> {
  const next = new Set(current);
  if (visible) {
    next.add(toolsetId);
  } else {
    next.delete(toolsetId);
  }

  return next;
}

export function shouldActivateDocumentObject(object: DocumentObject | undefined, activeToolKind: string): boolean {
  return object !== undefined && activeToolKind === "selection";
}

export function shouldDragDocumentObject(object: DocumentObject | undefined, activeToolKind: string): boolean {
  if (activeToolKind === "selection") {
    return true;
  }

  return activeToolKind === "charge" && object?.type === "electron-mark" && object.markKind === "charge";
}

export function shouldOpenMoleculeEditorFromObjectClick(
  object: DocumentObject | undefined,
  activeToolKind: string,
  clickCount: number
): object is MoleculeObject {
  void object;
  void activeToolKind;
  void clickCount;
  return false;
}

export function hoveredNativeTargetShortcutCommand(
  target: NativeMoleculeDeleteTarget | undefined,
  key: string
): string | undefined {
  if (target?.kind === "bond") {
    if (key === "1") {
      return "bond.setHoveredBondOrder.single";
    }
    if (key === "2") {
      return "bond.setHoveredBondOrder.double";
    }
    if (key === "3") {
      return "bond.setHoveredBondOrder.triple";
    }
    return undefined;
  }

  if (target?.kind !== "atom") {
    return undefined;
  }

  if (key === "1") {
    return "atom.addSingleBondToHoveredAtom";
  }
  if (key.toLowerCase() === "k") {
    return "atom.addCarbonylToHoveredAtom";
  }
  if (key === "+") {
    return "atom.addPositiveChargeToHoveredAtom";
  }
  if (key === "-") {
    return "atom.addNegativeChargeToHoveredAtom";
  }

  const element = nativeElementFromKeyboardKey(key);
  return element ? atomElementCommandId(element) : undefined;
}

export function activeNativeTargetShortcutCommand(
  document: ChemDraftDocument,
  selectedPart: NativeMoleculeSelectionPart | undefined,
  hoveredTarget: NativeMoleculeDeleteTarget | undefined,
  key: string
): string | undefined {
  return hoveredNativeTargetShortcutCommand(
    hoveredTarget ?? nativeDeleteTargetFromSelectionPart(document, selectedPart),
    key
  );
}

export function shouldLetSystemClipboardHandleCommand(commandId: string): boolean {
  return (
    commandId === "clipboard.copy" ||
    commandId === "clipboard.cut" ||
    commandId === "clipboard.paste"
  );
}

export function selectionClipboardTextItems(
  payload: ChemDraftSelectionClipboardPayload
): ClipboardWriteTextItem[] {
  const text = serializeSelectionClipboardPayload(payload);
  const items: ClipboardWriteTextItem[] = [
    { type: CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, text }
  ];
  // Publish a human-readable public flavor only when the selection has real text; never leak the
  // selection JSON as text/plain to external apps.
  const plainText = selectionClipboardPlainText(payload);
  if (plainText.length > 0) {
    items.push({ type: "text/plain", text: plainText });
  }
  return items;
}

export function selectionClipboardPayloadKey(payload: ChemDraftSelectionClipboardPayload): string {
  return serializeSelectionClipboardPayload(payload);
}

export function initialSelectionClipboardPasteState(
  payload: ChemDraftSelectionClipboardPayload,
  sourceAction: SelectionClipboardSourceAction
): SelectionClipboardPasteState {
  return {
    key: selectionClipboardPayloadKey(payload),
    pasteCount: 0,
    sourceAction
  };
}

export function nextSelectionClipboardPastePlacement(
  payload: ChemDraftSelectionClipboardPayload,
  previousState: SelectionClipboardPasteState | undefined,
  page: DocumentPage
): { point: ClientPoint; state: SelectionClipboardPasteState } {
  const key = selectionClipboardPayloadKey(payload);
  const sourceAction = previousState?.key === key ? previousState.sourceAction : "external";
  const previousPasteCount = previousState?.key === key ? previousState.pasteCount : 0;
  const offsetIndex = sourceAction === "cut" ? previousPasteCount : previousPasteCount + 1;
  return {
    point: selectionClipboardPastePoint(payload.bounds, page, offsetIndex),
    state: {
      key,
      sourceAction,
      pasteCount: previousPasteCount + 1
    }
  };
}

export function selectionClipboardPastePoint(
  bounds: SelectionBounds,
  page: DocumentPage,
  offsetIndex: number
): ClientPoint {
  if (offsetIndex <= 0) {
    return { x: bounds.centerX, y: bounds.centerY };
  }

  const offset = SELECTION_CLIPBOARD_PASTE_OFFSET_PX * offsetIndex;
  const candidates: ClientPoint[] = [
    { x: bounds.centerX + offset, y: bounds.centerY + offset },
    { x: bounds.centerX - offset, y: bounds.centerY - offset },
    { x: bounds.centerX + offset, y: bounds.centerY - offset },
    { x: bounds.centerX - offset, y: bounds.centerY + offset }
  ];
  const fittingCandidate = candidates.find((point) =>
    selectionClipboardPasteBoundsFitPage(bounds, point, page)
  );
  if (fittingCandidate) {
    return fittingCandidate;
  }

  return clampSelectionClipboardPastePoint(candidates[0], bounds, page);
}

function selectionClipboardPasteBoundsFitPage(
  bounds: SelectionBounds,
  point: ClientPoint,
  page: DocumentPage
): boolean {
  const halfWidth = bounds.width / 2;
  const halfHeight = bounds.height / 2;
  return (
    point.x - halfWidth >= 0 &&
    point.y - halfHeight >= 0 &&
    point.x + halfWidth <= page.width &&
    point.y + halfHeight <= page.height
  );
}

function clampSelectionClipboardPastePoint(
  point: ClientPoint,
  bounds: SelectionBounds,
  page: DocumentPage
): ClientPoint {
  const halfWidth = bounds.width / 2;
  const halfHeight = bounds.height / 2;
  const minX = Math.min(halfWidth, page.width / 2);
  const maxX = Math.max(page.width - halfWidth, page.width / 2);
  const minY = Math.min(halfHeight, page.height / 2);
  const maxY = Math.max(page.height - halfHeight, page.height / 2);

  return {
    x: clamp(point.x, minX, maxX),
    y: clamp(point.y, minY, maxY)
  };
}

export function nativeDeleteTargetFromSelectionPart(
  document: ChemDraftDocument,
  part: NativeMoleculeSelectionPart | undefined
): NativeMoleculeDeleteTarget | undefined {
  if (!part) {
    return undefined;
  }

  const object = findDocumentObject(document, part.objectId);
  if (object?.type !== "molecule") {
    return undefined;
  }

  if (part.kind === "atom") {
    return object.atoms.some((atom) => atom.id === part.atomId)
      ? {
          objectId: part.objectId,
          kind: "atom",
          atomId: part.atomId,
          distanceToPointer: 0
        }
      : undefined;
  }

  if (part.kind !== "bond") {
    return undefined;
  }

  const bond = object.bonds.find((candidate) => candidate.id === part.bondId);
  return bond
    ? {
        objectId: part.objectId,
        kind: "bond",
        bondId: bond.id,
        fromAtomId: bond.fromAtomId,
        toAtomId: bond.toAtomId,
        distanceToPointer: 0
      }
    : undefined;
}

function isLayerCommandId(commandId: string): boolean {
  return (
    commandId === "layout.bringToFront" ||
    commandId === "layout.bringForward" ||
    commandId === "layout.sendBackward" ||
    commandId === "layout.sendToBack" ||
    commandId === "layout.alignLeft" ||
    commandId === "layout.alignCenter" ||
    commandId === "layout.alignRight" ||
    commandId === "layout.alignTop" ||
    commandId === "layout.alignMiddle" ||
    commandId === "layout.alignBottom" ||
    commandId === "layout.distributeHorizontal" ||
    commandId === "layout.distributeVertical" ||
    commandId === distributeModeCommandIds.centers ||
    commandId === distributeModeCommandIds.spacing ||
    commandId === "layout.flipHorizontal" ||
    commandId === "layout.flipVertical" ||
    commandId === "layout.rotate90" ||
    commandId === "layout.duplicate" ||
    commandId === "layout.group" ||
    commandId === "layout.ungroup" ||
    commandId === artBooleanOperationCommandIds.union ||
    commandId === artBooleanOperationCommandIds.subtract ||
    commandId === artBooleanOperationCommandIds.intersect ||
    commandId === artBooleanOperationCommandIds.split
  );
}

function alignModeForCommandId(commandId: string): DocumentAlignMode | undefined {
  switch (commandId) {
    case "layout.alignLeft":
      return "left";
    case "layout.alignCenter":
      return "center";
    case "layout.alignRight":
      return "right";
    case "layout.alignTop":
      return "top";
    case "layout.alignMiddle":
      return "middle";
    case "layout.alignBottom":
      return "bottom";
    default:
      return undefined;
  }
}

function distributeAxisForCommandId(commandId: string): DocumentDistributeAxis | undefined {
  switch (commandId) {
    case "layout.distributeHorizontal":
      return "horizontal";
    case "layout.distributeVertical":
      return "vertical";
    default:
      return undefined;
  }
}

const TOOLSET_STAGGER_STEP_PX = 18;

// Registry-order index used to stagger a palette's first-ever placement. Shared by the native window
// geometry (toolsetWindowGeometry) and the in-window web-palette default so the two can't silently
// diverge on how they stagger (only their base anchor differs).
function toolsetStaggerIndex(toolsetId: string, registry: DesktopToolsetRegistry): number {
  return Math.max(0, registry.listToolsets().findIndex((toolset) => toolset.id === toolsetId));
}

function createDefaultToolsetPositions(registry: DesktopToolsetRegistry): Record<string, PalettePosition> {
  return Object.fromEntries(
    registry.listToolsets().map((toolset, index) => [
      toolset.id,
      { x: 34 + index * TOOLSET_STAGGER_STEP_PX, y: 116 + index * TOOLSET_STAGGER_STEP_PX }
    ])
  );
}

function defaultToolsetPosition(toolsetId: string, registry: DesktopToolsetRegistry): PalettePosition {
  const offset = toolsetStaggerIndex(toolsetId, registry) * TOOLSET_STAGGER_STEP_PX;
  return { x: 34 + offset, y: 116 + offset };
}

function clientPointFromElementCenter(element: HTMLElement): ClientPoint {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

function clientPointFromGesture(
  event: WebKitGestureEvent,
  element: HTMLElement,
  fallback?: ClientPoint
): ClientPoint {
  if (typeof event.clientX === "number" && typeof event.clientY === "number") {
    return { x: event.clientX, y: event.clientY };
  }

  return fallback ?? clientPointFromElementCenter(element);
}

export function shouldUseViewportWheelZoom(event: Pick<globalThis.WheelEvent, "ctrlKey" | "deltaY" | "metaKey">): boolean {
  return Number.isFinite(event.deltaY) && event.deltaY !== 0 && (event.ctrlKey || event.metaKey);
}

export function pagePointFromRenderedPageRect(
  rect: Pick<DOMRect, "left" | "top">,
  scale: number,
  clientPoint: ClientPoint
): ClientPoint {
  // The page-coordinate conversion lives in the camera module (single source of truth);
  // this thin wrapper preserves the existing call sites and test imports.
  return clientToPage(clientPoint, { pageRect: rect, scale });
}

function clientPointIsInsideRect(
  point: ClientPoint,
  rect: Pick<DOMRect, "bottom" | "left" | "right" | "top">
): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

function pageCenterPoint(
  viewport: ViewportState,
  page: ChemDraftDocument["pages"][number]
): { x: number; y: number } {
  return {
    x: viewport.pageOriginX + viewport.translateX + (page.width / 2) * viewport.scale,
    y: viewport.pageOriginY + viewport.translateY + (page.height / 2) * viewport.scale
  };
}

function rulerUnitForDocument(document: ChemDraftDocument | undefined): RulerUnitState {
  return rulerUnitForPageLayout(document?.pages[0]?.layout);
}

function rulerUnitForPageLayout(layout: ChemDraftDocument["pages"][number]["layout"] | undefined): RulerUnitState {
  return layout?.sourceUnit === "mm" ? centimeterRulerUnit : inchRulerUnit;
}

function DocumentRulers({
  viewport,
  frame,
  pageWidth,
  pageHeight
}: {
  viewport: ViewportState;
  frame: RulerFrame;
  pageWidth: number;
  pageHeight: number;
}) {
  const horizontalRuler = createRulerRenderState(viewport, pageWidth, frame.horizontalScrollPx);
  const verticalRuler = createRulerRenderState(viewport, pageHeight, frame.verticalScrollPx);

  return (
    <div className="document-rulers-overlay" aria-hidden="true">
      <div className="ruler-corner" aria-hidden="true" />
      <div className="ruler ruler-top" style={{ width: frame.width, height: RULER_THICKNESS }}>
        <ScenaRuler
          type="horizontal"
          width={frame.width}
          height={RULER_THICKNESS}
          scrollPos={horizontalRuler.scrollPos}
          zoom={horizontalRuler.zoom}
          unit={horizontalRuler.unit}
          segment={horizontalRuler.segment}
          range={horizontalRuler.range}
          negativeRuler={false}
          backgroundColor="#f9faf9"
          lineColor="#8f9aa1"
          textColor="#2a3035"
          font="11px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          mainLineSize={22}
          longLineSize={15}
          shortLineSize={8}
          textOffset={[4, -5]}
          textFormat={(value) => formatRulerText(value)}
          useResizeObserver={false}
        />
      </div>
      <div className="ruler ruler-left" style={{ width: RULER_THICKNESS, height: frame.height }}>
        <ScenaRuler
          type="vertical"
          width={RULER_THICKNESS}
          height={frame.height}
          scrollPos={verticalRuler.scrollPos}
          zoom={verticalRuler.zoom}
          unit={verticalRuler.unit}
          segment={verticalRuler.segment}
          range={verticalRuler.range}
          negativeRuler={false}
          backgroundColor="#f9faf9"
          lineColor="#8f9aa1"
          textColor="#2a3035"
          font="11px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          mainLineSize={22}
          longLineSize={15}
          shortLineSize={8}
          textOffset={[4, -5]}
          textFormat={(value) => formatRulerText(value)}
          useResizeObserver={false}
        />
      </div>
      <span className="ruler-unit-label" aria-hidden="true">
        {viewport.rulerUnit.label}
      </span>
    </div>
  );
}

function rulerFramesEqual(left: RulerFrame, right: RulerFrame): boolean {
  return (
    Math.abs(left.horizontalScrollPx - right.horizontalScrollPx) < 0.5 &&
    Math.abs(left.verticalScrollPx - right.verticalScrollPx) < 0.5 &&
    left.width === right.width &&
    left.height === right.height
  );
}

function formatRulerText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function constrainTapeMeasurePoint(startPoint: ClientPoint, point: ClientPoint, constrained: boolean): ClientPoint {
  if (!constrained) {
    return point;
  }

  const dx = point.x - startPoint.x;
  const dy = point.y - startPoint.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) {
    return point;
  }

  const snappedAngle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return {
    x: startPoint.x + Math.cos(snappedAngle) * length,
    y: startPoint.y + Math.sin(snappedAngle) * length
  };
}

function formatTapeMeasureDistance(
  startPoint: ClientPoint,
  latestPoint: ClientPoint,
  rulerUnit: RulerUnitState
): string {
  const distancePx = Math.hypot(latestPoint.x - startPoint.x, latestPoint.y - startPoint.y);
  if (rulerUnit.kind === "pixel") {
    return `${Math.round(distancePx)} px`;
  }

  const value = distancePx / rulerUnit.pixelsPerUnit;
  const formatted = value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formatted} ${rulerUnit.label}`;
}

export function TapeMeasureOverlay({
  measurement,
  pageWidth,
  pageHeight,
  rulerUnit
}: {
  measurement: TapeMeasureOverlayState;
  pageWidth: number;
  pageHeight: number;
  rulerUnit: RulerUnitState;
}) {
  const label = formatTapeMeasureDistance(measurement.startPoint, measurement.latestPoint, rulerUnit);
  const midpoint = {
    x: (measurement.startPoint.x + measurement.latestPoint.x) / 2,
    y: (measurement.startPoint.y + measurement.latestPoint.y) / 2
  };

  return (
    <div
      className="tape-measure-overlay"
      aria-hidden="true"
      data-tape-measure-dragging={measurement.dragging ? "true" : undefined}
      data-tape-measure-constrained={measurement.constrained ? "true" : undefined}
    >
      <svg
        className="tape-measure-line-layer"
        viewBox={`0 0 ${pageWidth} ${pageHeight}`}
        style={{
          width: `calc(${pageWidth}px * var(--page-scale))`,
          height: `calc(${pageHeight}px * var(--page-scale))`
        }}
      >
        <line
          className="tape-measure-line"
          x1={measurement.startPoint.x}
          y1={measurement.startPoint.y}
          x2={measurement.latestPoint.x}
          y2={measurement.latestPoint.y}
        />
        <circle className="tape-measure-endpoint" cx={measurement.startPoint.x} cy={measurement.startPoint.y} r={3.5} />
        <circle className="tape-measure-endpoint" cx={measurement.latestPoint.x} cy={measurement.latestPoint.y} r={3.5} />
      </svg>
      <div
        className="tape-measure-label"
        style={{
          left: `calc(${midpoint.x}px * var(--page-scale))`,
          top: `calc(${midpoint.y}px * var(--page-scale))`
        }}
      >
        {label}
      </div>
    </div>
  );
}

function CrosshairOverlay({
  horizontalTicks,
  verticalTicks
}: {
  horizontalTicks: ReturnType<typeof buildCrosshairTicks>;
  verticalTicks: ReturnType<typeof buildCrosshairTicks>;
}) {
  return (
    <div className="crosshair-overlay" aria-hidden="true">
      <div className="crosshair-axis crosshair-axis-vertical" />
      <div className="crosshair-axis crosshair-axis-horizontal" />
      {verticalTicks.map((tick) => (
        <span
          className={["crosshair-tick", "crosshair-tick-on-vertical", `crosshair-tick-${tick.kind}`].join(" ")}
          key={`vertical-${tick.index}`}
          style={{ top: `calc(${tick.position}px * var(--page-scale))` }}
        />
      ))}
      {horizontalTicks.map((tick) => (
        <span
          className={["crosshair-tick", "crosshair-tick-on-horizontal", `crosshair-tick-${tick.kind}`].join(" ")}
          key={`horizontal-${tick.index}`}
          style={{ left: `calc(${tick.position}px * var(--page-scale))` }}
        />
      ))}
    </div>
  );
}

// A non-interactive ghost of the ring a template click will place, drawn from the SAME plan the
// click commits (so what you see is exactly what lands). Only the parts NEW to this placement are
// drawn — a full hexagon for a standalone insert, the open arc that shares the targeted edge for a
// fusion, the arc hanging off the shared atom for a spiro, and just the missing edges for a
// closure. The ghost only turns red (data-ghost-invalid) when the placement would actually make
// one of the atoms it touches invalid — the same predicate that paints the red "!" — so valid
// spiro rings (cyclohexane/cyclopentane, degree-4 sp3) stay neutral and only genuinely bad
// products (e.g. a spiro carbon shared by two aromatic rings) warn.
/** How one bond draws in the spin overlay — mirrors the 2D renderer's conventions. */
interface SpinBondRenderInfo {
  order: 1 | 2 | 3;
  bold: boolean;
  /** Terminal-heteroatom doubles (C=O etc.) straddle the bond axis symmetrically,
   *  exactly like the 2D drawing; all other doubles draw axis + inset inner line. */
  symmetric: boolean;
  /** Atom indices bonded to either endpoint (excluding the endpoints): the fallback
   *  substituent-rich side for NON-ring double bonds, matching `defaultDoubleBondSide`. */
  neighborIndices: number[];
  /** Atom indices of the smallest ring the bond lies on, if any. A ring double bond's inner
   *  line points toward this ring's PROJECTED centroid (true interior), overriding the
   *  neighbor-mass rule which flips outward when exocyclic substituents dominate. */
  ringAtomIndices?: number[];
}

interface Spin3dState {
  objectId: string;
  quat: Quaternion;
  coords3d: Float64Array;
  bondPairs: [number, number][];
  /** Per bondPairs entry: how the bond renders, mirroring the 2D drawing conventions. */
  bondRender: SpinBondRenderInfo[];
  /** Per atom: the exact label the 2D drawing shows (undefined = unlabeled carbon). */
  atomLabels: (string | undefined)[];
  /** Per atom: resolved label drawing style, including sparse atom-specific overrides. */
  atomLabelStyles: (NativeDrawingStyle | undefined)[];
  /** The source 2D atoms (same order as atomLabels/projection) — used for label-offset
   *  aware bond-end trimming, matching the committed 2D drawing. */
  atoms: readonly MoleculeAtom[];
  placement: ScreenPlacement;
  /** The molecule's selection box (page coords): drag inside to rotate, click outside to flatten. */
  selectionBox: { x: number; y: number; width: number; height: number };
  dragging: boolean;
  lastClient?: { x: number; y: number };
  /** Engine provenance recorded into the persisted 3D model on flatten (best-effort). */
  engine?: Spin3dEngineProvenance;
}

/**
 * On-canvas "Generating 3D…" cue shown over a molecule while its FIRST conformer embed
 * runs (the one-time ~1–2s cost a prefetch cache-hit otherwise hides). Positioned in the
 * same page-coordinate frame the SpinOverlay uses (a % of the positioned canvas area), so
 * it lands on the molecule at any zoom. Purely additive chrome — never touches the document
 * or the conformer geometry. Its CSS fade-in is delayed so a fast cache-hit (~90ms, which
 * unmounts this almost immediately) never flashes it.
 */
function Spin3dGeneratingCue({ box, atomCount, pageWidth, pageHeight }: {
  box: { x: number; y: number; width: number; height: number };
  atomCount: number;
  pageWidth: number;
  pageHeight: number;
}) {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const leftPct = pageWidth > 0 ? (centerX / pageWidth) * 100 : 50;
  const topPct = pageHeight > 0 ? (centerY / pageHeight) * 100 : 50;
  return (
    <div
      aria-hidden="true"
      data-spin3d-generating="true"
      className="spin3d-generating-cue"
      style={{ left: `${leftPct}%`, top: `${topPct}%` }}
    >
      <span className="spin3d-generating-cue__spinner" />
      <span>Generating 3D… ({atomCount} atoms)</span>
    </div>
  );
}

/**
 * Transient 3D spin overlay (Phase 4). A full-page SVG that dims the canvas, paints
 * the spun conformer in painter's order (far → near), and owns its own pointer
 * drag — so it needs no changes to the existing page/object pointer handlers. It
 * never mutates the document; the flatten-on-release commit is Phase 5.
 */
function SpinOverlay({
  state,
  pageWidth,
  pageHeight,
  drawingStyle,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel
}: {
  state: Spin3dState;
  pageWidth: number;
  pageHeight: number;
  /** The molecule's own 2D drawing style — the overlay renders with the SAME colors,
   *  stroke widths, label fonts and multi-bond geometry as the drawing it replaces,
   *  so spinning never reads as a different engine taking over. */
  drawingStyle: NativeDrawingStyle;
  onPointerDown: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerMove: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerUp: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerCancel: (event: PointerEvent<SVGSVGElement>) => void;
}) {
  const projection = projectSpin(state.coords3d, state.bondPairs, state.quat, state.placement);
  // Depth-cue weights computed with the EXACT recipe flattenSpunMolecule commits, so the
  // live overlay's stroke weighting is identical to the flattened result (no snap on
  // release). `undefined` = near-planar view ⇒ no depth cue, same as the commit.
  const depthWeights = bondDepthWeights(state.coords3d, state.bondPairs, quatToViewMatrix(state.quat));
  // Per-labeled-atom depth weight, derived from the incident bonds' weights exactly as the
  // committed 2D render does (packages/layout-engine averageDefinedDepthWeights over the SAME
  // per-bond weights), so label depth-cueing matches on flatten — no re-shade on release.
  const atomIncidentWeights: (number | undefined)[][] = projection.atoms.map(() => []);
  state.bondPairs.forEach(([from, to], bondIndex) => {
    const weight = depthWeights[bondIndex];
    atomIncidentWeights[from]?.push(weight);
    atomIncidentWeights[to]?.push(weight);
  });
  // Labeled atoms painted far → near so a nearer heteroatom's glyph sits over a farther one where
  // the projection stacks them; halo and fill passes share this order. Each label resolves its
  // per-atom Inspector style (font, color, halo color/width, anchor placement) exactly as the
  // committed 2D render does, so styled labels look identical live and on flatten.
  const spinLabels = projection.atoms
    .flatMap((atom) => {
      const label = state.atomLabels[atom.index];
      if (!label) return [];
      const labelStyle = state.atomLabelStyles[atom.index] ?? drawingStyle;
      const layout = atomLabelLayout(label, labelStyle);
      const sourceAtom = state.atoms[atom.index];
      const anchorOffset = sourceAtom
        ? atomLabelAnchorOffset(sourceAtom, label, labelStyle, layout)
        : { x: 0, y: 0 };
      const weight = averageDefinedDepthWeights(atomIncidentWeights[atom.index] ?? []);
      return [{
        atom,
        label,
        labelStyle,
        anchorOffset,
        weight,
        scale: depthCuedLabelScale(weight),
        runs: layout.runs,
        haloColor: labelStyle.atomLabelBackgroundColor !== "transparent" ? labelStyle.atomLabelBackgroundColor : undefined,
        haloWidth: atomLabelHaloWidthPx(labelStyle)
      }];
    })
    .sort((a, b) => (a.weight ?? 0.5) - (b.weight ?? 0.5));
  return (
    <svg
      aria-hidden="true"
      data-spin3d-overlay="true"
      viewBox={`0 0 ${pageWidth} ${pageHeight}`}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 50, cursor: "grab", touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {/* Full-page transparent hit-catcher. An SVG root only hit-tests where it is PAINTED,
          so without this a pointer-down on empty page area (away from a bond/atom) misses the
          overlay entirely and falls through to the tool underneath — e.g. the active benzene
          tool drops a new ring instead of the click flattening. A transparent-filled rect
          counts as painted (fill is rgba 0, not `none`), so every in-page click reaches
          handleSpinOverlayPointerDown, which routes inside-box → rotate, outside → flatten. */}
      <rect x={0} y={0} width={pageWidth} height={pageHeight} fill="transparent" />
      {projection.bonds.map((bond, index) => {
        const a = projection.atoms[bond.from];
        const b = projection.atoms[bond.to];
        // The SAME depth-cue helpers AND the SAME weight the committed 2D drawing uses
        // (flatten bakes the identical weight into display.depthWeight) — releasing changes
        // nothing visually. undefined ⇒ no cue, exactly as the commit leaves a planar view.
        const weight = depthWeights[bond.index];
        const render = state.bondRender[bond.index] ?? { order: 1, bold: false, symmetric: false, neighborIndices: [] };
        const stroke = depthCuedBondColor(drawingStyle.bondColor, weight);
        const baseWidth = render.bold ? drawingStyle.bondBoldWidthPx : drawingStyle.bondStrokeWidthPx;
        const width = depthCuedBondStrokeWidth(baseWidth, weight);
        const rawDx = b.sx - a.sx;
        const rawDy = b.sy - a.sy;
        const rawLength = Math.hypot(rawDx, rawDy) || 1;
        const ux = rawDx / rawLength, uy = rawDy / rawLength;
        const nx = -uy, ny = ux; // screen-space normal
        // Trim bond ends back from atom labels exactly like the 2D renderer does, so
        // lines never strike through an O / NH2 / charge label while spinning.
        const clearance = labelEndpointClearance(
          state.atoms[bond.from],
          state.atoms[bond.to],
          state.atomLabels[bond.from],
          state.atomLabels[bond.to],
          drawingStyle,
          rawLength,
          { x: ux, y: uy },
          state.atomLabelStyles[bond.from],
          state.atomLabelStyles[bond.to]
        );
        const ax = a.sx + ux * clearance.from, ay = a.sy + uy * clearance.from;
        const bx = b.sx - ux * clearance.to, by = b.sy - uy * clearance.to;
        const length = Math.hypot(bx - ax, by - ay) || 1;
        const gap = nativeMultipleBondGapPx(drawingStyle);
        const key = (suffix: string) => `${bond.from}-${bond.to}-${index}-${suffix}`;
        const line = (sx1: number, sy1: number, sx2: number, sy2: number, suffix: string) => (
          <line key={key(suffix)} x1={sx1} y1={sy1} x2={sx2} y2={sy2}
            stroke={stroke} strokeWidth={width} strokeLinecap={drawingStyle.bondLineCap} />
        );
        if (render.order === 2 && render.symmetric) {
          // Terminal heteroatom double (C=O …): two full lines straddling the axis — same as 2D.
          const o = gap / 2;
          return [
            line(ax + nx * o, ay + ny * o, bx + nx * o, by + ny * o, "p"),
            line(ax - nx * o, ay - ny * o, bx - nx * o, by - ny * o, "s")
          ];
        }
        if (render.order === 2) {
          // 2D convention: primary line on the bond axis, shorter secondary line a full gap to
          // one side. The side is chosen per frame from PROJECTED positions so it tracks the
          // rotation and matches the flattened drawing. For a RING bond the inner line points
          // toward the projected ring CENTROID (true interior) — this is the fix for aromatic
          // rings whose exocyclic substituents used to flip the neighbor-mass heuristic below
          // and push the double bond outside. Non-ring doubles keep the substituent-rich rule,
          // which is exactly what defaultDoubleBondSide falls back to on commit.
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          let score = 0;
          if (render.ringAtomIndices && render.ringAtomIndices.length > 0) {
            let cx = 0, cy = 0, n = 0;
            for (const ringIndex of render.ringAtomIndices) {
              const p = projection.atoms[ringIndex];
              if (p) { cx += p.sx; cy += p.sy; n += 1; }
            }
            if (n > 0) score = (cx / n - mx) * nx + (cy / n - my) * ny;
          }
          if (score === 0) {
            for (const neighborIndex of render.neighborIndices) {
              const p = projection.atoms[neighborIndex];
              if (p) score += (p.sx - mx) * nx + (p.sy - my) * ny;
            }
          }
          const dir = score >= 0 ? 1 : -1;
          const minimumVisible = Math.min(DOUBLE_BOND_MIN_VISIBLE_SEGMENT_PX, length);
          const inset = Math.min(drawingStyle.doubleBondInsetPx, Math.max(0, (length - minimumVisible) / 2));
          return [
            line(ax, ay, bx, by, "p"),
            line(
              ax + ux * inset + nx * gap * dir, ay + uy * inset + ny * gap * dir,
              bx - ux * inset + nx * gap * dir, by - uy * inset + ny * gap * dir,
              "s"
            )
          ];
        }
        if (render.order === 3) {
          // Triple: three full-length lines at -gap / 0 / +gap — same as 2D.
          return [-1, 0, 1].map((step) =>
            line(ax + nx * gap * step, ay + ny * gap * step, bx + nx * gap * step, by + ny * gap * step, `t${step}`)
          );
        }
        return line(ax, ay, bx, by, "p");
      })}
      {/* Labels, painted far → near, depth-cued to match the bonds: far labels fade lighter and
          shrink slightly, near labels stay dark and full-size. The knockout is a glyph-hugging
          halo (paint-order stroke, painted UNDER the fill) instead of an opaque box, so bonds
          behind a label vanish right at the letters; a nearer label's halo also clears a farther
          one it overlaps. Per-atom Inspector styles feed the SAME halo: the per-atom background
          color IS the halo stroke ("transparent" opts out), and the anchor honors per-atom
          placement/offsets so the live overlay matches the flatten commit exactly. */}
      {spinLabels.map(({ atom, label, labelStyle, anchorOffset, weight, scale, runs, haloColor, haloWidth }) => (
        <g
          key={`label-${atom.index}`}
          data-atom-label={label}
          transform={`translate(${atom.sx + anchorOffset.x} ${atom.sy + anchorOffset.y})${scale === 1 ? "" : ` scale(${scale})`}`}
          fill={depthCuedLabelColor(labelStyle.atomLabelColor, weight)}
          stroke={haloColor}
          strokeWidth={haloColor === undefined ? undefined : haloWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
          paintOrder="stroke"
          fontFamily={labelStyle.atomLabelFontFamily}
          fontSize={labelStyle.atomLabelFontSizePx}
          fontWeight={labelStyle.atomLabelFontWeight}
          fontStyle={labelStyle.atomLabelFontStyle}
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          {runs.map((run, runIndex) => (
            <text
              key={runIndex}
              x={run.x}
              y={run.y}
              textAnchor={run.textAnchor}
              dominantBaseline="central"
              fontSize={atomLabelRunFontSize(run.script, labelStyle) ?? labelStyle.atomLabelFontSizePx}
            >
              {run.text}
            </text>
          ))}
        </g>
      ))}
      <text
        x={pageWidth / 2}
        y={24}
        textAnchor="middle"
        fontSize={13}
        fill="var(--cd-text-secondary, #555)"
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        Drag the molecule to rotate · click outside to flatten · Esc to cancel
      </text>
    </svg>
  );
}

function NativeTemplateGhostOverlay({
  plan,
  pageWidth,
  pageHeight
}: {
  plan: NativeTemplatePlacementPlan;
  pageWidth: number;
  pageHeight: number;
}) {
  const atomById = new Map(plan.molecule.atoms.map((atom) => [atom.id, atom] as const));
  const addedBondIds = new Set(plan.addedBondIds);
  const ghostBonds = plan.molecule.bonds.filter((bond) => addedBondIds.has(bond.id));
  const invalidAtomIds = new Set(nativeMoleculeInvalidAtomStates(plan.molecule).map((state) => state.atomId));
  const touchedAtomIds = new Set<string>(plan.addedAtomIds);
  ghostBonds.forEach((bond) => {
    touchedAtomIds.add(bond.fromAtomId);
    touchedAtomIds.add(bond.toAtomId);
  });
  const producesInvalidAtom = [...touchedAtomIds].some((atomId) => invalidAtomIds.has(atomId));
  return (
    <svg
      className="native-template-ghost-surface"
      data-ghost-invalid={producesInvalidAtom ? "true" : undefined}
      aria-hidden="true"
      viewBox={`0 0 ${pageWidth} ${pageHeight}`}
    >
      {ghostBonds.map((bond) => {
        const from = atomById.get(bond.fromAtomId);
        const to = atomById.get(bond.toAtomId);
        return from && to ? (
          <line
            key={bond.id}
            className="native-template-ghost-bond"
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
          />
        ) : null;
      })}
      {plan.addedAtomIds.map((atomId) => {
        const atom = atomById.get(atomId);
        return atom ? (
          <circle key={atomId} className="native-template-ghost-atom" cx={atom.x} cy={atom.y} r={2.5} />
        ) : null;
      })}
    </svg>
  );
}

export function SelectionMarqueeOverlay({
  startPoint,
  latestPoint
}: {
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
}) {
  const rect = normalizedRect(startPoint, latestPoint);
  return (
    <div
      className="selection-marquee"
      aria-hidden="true"
      style={{
        left: `calc(${rect.x}px * var(--page-scale))`,
        top: `calc(${rect.y}px * var(--page-scale))`,
        width: `calc(${rect.width}px * var(--page-scale))`,
        height: `calc(${rect.height}px * var(--page-scale))`
      }}
    />
  );
}

export function SelectionLassoOverlay({
  points,
  latestPoint,
  pageWidth,
  pageHeight
}: {
  points: readonly ClientPoint[];
  latestPoint: ClientPoint;
  pageWidth: number;
  pageHeight: number;
}) {
  const pathPoints = lassoPointsForPreview(points, latestPoint);
  const pathD = lassoPathD(pathPoints);
  return (
    <svg
      className="selection-lasso-surface"
      aria-hidden="true"
      viewBox={`0 0 ${pageWidth} ${pageHeight}`}
      style={{
        width: `calc(${pageWidth}px * var(--page-scale))`,
        height: `calc(${pageHeight}px * var(--page-scale))`
      }}
    >
      {pathD ? <path className="selection-lasso-fill" d={pathD} /> : null}
      {pathD ? <path className="selection-lasso-path" d={pathD} /> : null}
    </svg>
  );
}

// One bounding box + rotate/resize handles around a multi-object selection, so the
// whole group can be rotated or scaled as one. Reuses the per-molecule handle classes.
function GroupSelectionOverlay({
  bounds,
  canProjectedPlaneTilt,
  rotationHandlesVisible,
  onProjectedPlaneTiltStart,
  onRotateStart,
  onResizeStart
}: {
  bounds: SelectionBounds;
  canProjectedPlaneTilt: boolean;
  rotationHandlesVisible: boolean;
  onProjectedPlaneTiltStart(event: PointerEvent<HTMLButtonElement>): void;
  onRotateStart(event: PointerEvent<HTMLButtonElement>): void;
  onResizeStart(corner: ObjectResizeCorner): (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div
      className="object-transform-frame group-selection-frame"
      data-group-selection="true"
      data-has-tilt3d={canProjectedPlaneTilt ? "true" : undefined}
      style={{
        left: `calc(${bounds.x}px * var(--page-scale))`,
        top: `calc(${bounds.y}px * var(--page-scale))`,
        width: `calc(${bounds.width}px * var(--page-scale))`,
        height: `calc(${bounds.height}px * var(--page-scale))`
      }}
    >
      <ObjectResizeHandles
        targetLabel="selected group"
        onResizeDoubleClick={() => (event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onResizeStart={onResizeStart}
      />
      {/*
        The 2D rotate handle is a privileged control of the group frame: like the always-on
        resize handles above, it stays visible whenever a group is selected and does not wait
        for the shift-key reveal (rotationHandlesVisible) that gates the per-object handles.
        The heavier 3D-tilt handle below stays shift-gated.
      */}
      <button
        type="button"
        className="object-rotate-handle"
        aria-label="Rotate selected group"
        data-selection-rotate-handle="true"
        data-group-rotate-handle="true"
        title="Rotate selected group"
        onPointerDown={onRotateStart}
      >
        <RotateSelectionIcon />
      </button>
      {canProjectedPlaneTilt && rotationHandlesVisible ? (
        <button
          type="button"
          className="object-tilt3d-handle"
          aria-label="3D rotate selected molecules"
          data-selection-tilt3d-handle="true"
          data-group-tilt3d-handle="true"
          title="3D rotate selected molecules"
          onPointerDown={onProjectedPlaneTiltStart}
        >
          <ProjectedPlaneTiltIcon />
        </button>
      ) : null}
    </div>
  );
}

function ArtTransformQaLayer({
  page,
  selectionObjectIds,
  draft,
  onDraftChange,
  onApplyScene,
  onApplySelection
}: {
  page: ChemDraftDocument["pages"][number];
  selectionObjectIds: readonly string[];
  draft: ArtTransformQaDraft;
  onDraftChange(nextDraft: ArtTransformQaDraft): void;
  onApplyScene(): void;
  onApplySelection(): void;
}) {
  const selectionSet = new Set(selectionObjectIds);
  const graphicTargets = page.objects.filter((object): object is GraphicObject => object.type === "graphic");
  const targetObjects = graphicTargets.filter((object) =>
    selectionSet.has(object.id) || ART_TRANSFORM_QA_OBJECT_IDS.includes(object.id as typeof ART_TRANSFORM_QA_OBJECT_IDS[number])
  );
  const overlayObjects = targetObjects.length > 0 ? targetObjects : graphicTargets;
  const selectedGraphicIds = graphicTargets.filter((object) => selectionSet.has(object.id)).map((object) => object.id);
  const handleDraftChange = (field: keyof ArtTransformQaDraft) => (event: ChangeEvent<HTMLInputElement>) => {
    onDraftChange({ ...draft, [field]: event.currentTarget.value });
  };

  return (
    <>
      <svg
        className="art-transform-qa-overlay"
        data-art-transform-qa-layer="true"
        data-art-transform-qa-object-count={overlayObjects.length}
        data-art-transform-qa-selected-ids={selectedGraphicIds.join(",")}
        aria-hidden="true"
        viewBox={`0 0 ${page.width} ${page.height}`}
      >
        {overlayObjects.map((object) => {
          const corners = artTransformQaProjectedCorners(object);
          const projection = documentObjectProjectedPlaneProjection(object);
          const projectedBounds = projection
            ? {
                x: object.x + (Number.parseFloat(`${projection.frameStyle?.left ?? 0}`) || 0),
                y: object.y + (Number.parseFloat(`${projection.frameStyle?.top ?? 0}`) || 0),
                width: Number.parseFloat(`${projection.frameStyle?.width ?? object.width}`) || object.width,
                height: Number.parseFloat(`${projection.frameStyle?.height ?? object.height}`) || object.height
              }
            : { x: object.x, y: object.y, width: object.width, height: object.height };

          return (
            <g data-art-transform-qa-object-id={object.id} key={object.id}>
              <rect
                className="art-transform-qa-model-frame"
                x={object.x}
                y={object.y}
                width={object.width}
                height={object.height}
              />
              <polygon
                className="art-transform-qa-projected-corners"
                points={corners.map((point) => `${formatSvgNumber(point.x)},${formatSvgNumber(point.y)}`).join(" ")}
              />
              <rect
                className="art-transform-qa-projected-bounds"
                x={projectedBounds.x}
                y={projectedBounds.y}
                width={projectedBounds.width}
                height={projectedBounds.height}
              />
              <text className="art-transform-qa-label" x={object.x} y={Math.max(10, object.y - 8)}>
                {object.id}
              </text>
            </g>
          );
        })}
      </svg>
      <section
        className="art-transform-qa-panel"
        data-art-transform-qa-panel="true"
        data-art-transform-qa-selected-ids={selectedGraphicIds.join(",")}
        data-art-transform-qa-target-count={overlayObjects.length}
        aria-label="Art transform QA"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="art-transform-qa-title">Art QA</div>
        <div className="art-transform-qa-fields">
          <label>
            Z
            <input
              aria-label="Art QA Z degrees"
              data-art-transform-qa-input="z"
              inputMode="decimal"
              type="number"
              value={draft.rotationDegrees}
              onChange={handleDraftChange("rotationDegrees")}
            />
          </label>
          <label>
            X
            <input
              aria-label="Art QA X degrees"
              data-art-transform-qa-input="x"
              inputMode="decimal"
              type="number"
              value={draft.tiltXDegrees}
              onChange={handleDraftChange("tiltXDegrees")}
            />
          </label>
          <label>
            Y
            <input
              aria-label="Art QA Y degrees"
              data-art-transform-qa-input="y"
              inputMode="decimal"
              type="number"
              value={draft.tiltYDegrees}
              onChange={handleDraftChange("tiltYDegrees")}
            />
          </label>
        </div>
        <div className="art-transform-qa-actions">
          <button type="button" data-art-transform-qa-action="scene" onClick={onApplyScene}>
            Scene
          </button>
          <button type="button" data-art-transform-qa-action="apply" onClick={onApplySelection}>
            Apply
          </button>
        </div>
        <output className="art-transform-qa-output" data-art-transform-qa-output="true">
          {selectedGraphicIds.length > 0 ? selectedGraphicIds.join(", ") : "no graphic selected"}
        </output>
      </section>
    </>
  );
}

function ArtStyleQaLayer({
  page,
  runCount,
  selectionObjectIds,
  onApplyScene,
  onRunStress
}: {
  page: ChemDraftDocument["pages"][number];
  runCount: number;
  selectionObjectIds: readonly string[];
  onApplyScene(): void;
  onRunStress(): void;
}) {
  const styleObjectCount = page.objects.filter((object) =>
    object.type === "graphic" && ART_STYLE_QA_OBJECT_IDS.includes(object.id as typeof ART_STYLE_QA_OBJECT_IDS[number])
  ).length;
  const selectedStyleObjectIds = selectionObjectIds.filter((objectId) =>
    ART_STYLE_QA_OBJECT_IDS.includes(objectId as typeof ART_STYLE_QA_OBJECT_IDS[number])
  );

  return (
    <section
      className="art-style-qa-panel"
      data-art-style-qa-panel="true"
      data-art-style-qa-count={styleObjectCount}
      data-art-style-qa-run-count={runCount}
      data-art-style-qa-selected-ids={selectedStyleObjectIds.join(",")}
      aria-label="Art style QA"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="art-style-qa-title">Art Style QA</div>
      <div className="art-style-qa-actions">
        <button type="button" data-art-style-qa-action="scene" onClick={onApplyScene}>
          Scene
        </button>
        <button type="button" data-art-style-qa-action="stress" onClick={onRunStress}>
          Stress
        </button>
      </div>
      <output className="art-style-qa-output" data-art-style-qa-output="true">
        {styleObjectCount} graphics / pass {runCount}
      </output>
    </section>
  );
}

export function ObjectLayerContextMenu({
  objectId,
  objectIndex,
  objectCount,
  targetKind,
  bondDepthContext,
  position,
  onInvoke
}: {
  objectId: string;
  objectIndex: number;
  objectCount: number;
  targetKind: ObjectContextMenuState["targetKind"];
  bondDepthContext?: ObjectContextMenuState["bondDepthContext"];
  position: ClientPoint;
  onInvoke(commandId: string): void;
}) {
  const layerLabel = contextMenuLayerLabel(targetKind, objectIndex, objectCount);
  const hasBondDepthContext = bondDepthContext !== undefined && bondDepthContext.relevantCrossings.length > 0;
  const hasMultipleBondTargets = (bondDepthContext?.targetBondRefs.length ?? 0) > 1;

  return (
    <div
      className="object-context-menu"
      role="menu"
      aria-label="Object layer options"
      data-context-object-id={objectId}
      data-context-target-kind={targetKind}
      data-context-layer-index={objectIndex >= 0 ? objectIndex : undefined}
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {hasBondDepthContext ? (
        <>
          <div className="object-context-menu-title">Bond depth</div>
          <button
            type="button"
            role="menuitem"
            className="object-context-menu-item"
            data-command-id="bondDepth.bringInFront"
            onClick={() => onInvoke("bondDepth.bringInFront")}
          >
            {hasMultipleBondTargets ? "Bring Selected Bonds In Front" : "Bring Bond In Front"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="object-context-menu-item"
            data-command-id="bondDepth.sendBehind"
            onClick={() => onInvoke("bondDepth.sendBehind")}
          >
            {hasMultipleBondTargets ? "Send Selected Bonds Behind" : "Send Bond Behind"}
          </button>
          {bondDepthContext?.hasOverrides ? (
            <button
              type="button"
              role="menuitem"
              className="object-context-menu-item"
              data-command-id="bondDepth.useDefault"
              onClick={() => onInvoke("bondDepth.useDefault")}
            >
              Use Default Bond Depth
            </button>
          ) : null}
          <div className="object-context-menu-separator" role="separator" />
        </>
      ) : null}
      <div className="object-context-menu-title">{layerLabel}</div>
      {layerContextMenuItems.map((item) => (
        <button
          type="button"
          role="menuitem"
          className="object-context-menu-item"
          data-command-id={item.commandId}
          key={item.commandId}
          onClick={() => onInvoke(item.commandId)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function contextMenuLayerLabel(
  targetKind: ObjectContextMenuState["targetKind"],
  objectIndex: number,
  objectCount: number
): string {
  if (targetKind === "atom" || targetKind === "bond" || targetKind === "parts") {
    return "Molecule layer";
  }

  return objectIndex >= 0 ? `Layer ${objectIndex + 1} of ${objectCount}` : "Layer options";
}

function normalizedRect(startPoint: ClientPoint, latestPoint: ClientPoint): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const x = Math.min(startPoint.x, latestPoint.x);
  const y = Math.min(startPoint.y, latestPoint.y);
  return {
    x,
    y,
    width: Math.abs(startPoint.x - latestPoint.x),
    height: Math.abs(startPoint.y - latestPoint.y)
  };
}

function selectionChromeConsumesPointerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  return target.closest([
    "[data-selection-rotate-handle='true']",
    "[data-selection-tilt3d-handle='true']",
    "[data-object-resize-corner]",
    "[data-graphic-corner-radius-handle='true']",
    "[data-graphic-path-handle]",
    "[data-graphic-marker-handle]",
    "[data-rotation-input-popover='true']",
    "[data-scale-input-popover='true']"
  ].join(",")) !== null;
}

function lassoPointsForPreview(points: readonly ClientPoint[], latestPoint: ClientPoint): ClientPoint[] {
  if (points.length === 0) {
    return [latestPoint];
  }
  const lastPoint = points[points.length - 1];
  return clientPointDistance(lastPoint, latestPoint) > 0.001
    ? [...points, latestPoint]
    : [...points];
}

function lassoPointsForSelection(lasso: SelectionLassoState, latestPoint: ClientPoint): ClientPoint[] {
  const points = lassoPointsForPreview(lasso.points, latestPoint);
  return points.length >= 3 ? points : [];
}

function lassoPathD(points: readonly ClientPoint[]): string {
  if (points.length < 2) {
    return "";
  }

  const commands = points.map((point, index) =>
    `${index === 0 ? "M" : "L"} ${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`
  );
  return points.length >= 3 ? `${commands.join(" ")} Z` : commands.join(" ");
}

export function selectionInSelectionRect(
  objects: readonly DocumentObject[],
  startPoint: ClientPoint,
  latestPoint: ClientPoint
): { objectIds: string[]; nativeSelection?: NativeMoleculeSelectionPart } {
  const rect = normalizedRect(startPoint, latestPoint);
  const objectIds: string[] = [];
  let nativeSelection: NativeMoleculeSelectionPart | undefined;

  for (const object of objects) {
    if (object.type === "group") {
      continue;
    }

    if (object.type === "molecule" && isNativeMoleculeGraph(object)) {
      const moleculeSelection = nativeMoleculeSelectionInRect(object, rect);
      if (!moleculeSelection) {
        continue;
      }

      if (nativeMoleculeSelectionCoversWholeObject(object, moleculeSelection)) {
        objectIds.push(object.id);
        continue;
      }

      nativeSelection ??= moleculeSelection;
      continue;
    }

    if (object.type === "graphic") {
      if (graphicObjectIntersectsRect(object, rect)) {
        objectIds.push(object.id);
      }
      continue;
    }

    if (rectangleContainsRect(rect, objectBounds(object))) {
      objectIds.push(object.id);
    }
  }

  return promotedSelectionForGroupedObjects(objects, objectIds, nativeSelection);
}

export function eraserObjectIdsInSelectionRect(
  objects: readonly DocumentObject[],
  startPoint: ClientPoint,
  latestPoint: ClientPoint
): string[] {
  const rect = normalizedRect(startPoint, latestPoint);
  const objectIds: string[] = [];

  for (const object of objects) {
    if (object.type === "group") {
      continue;
    }

    if (object.type === "molecule" && isNativeMoleculeGraph(object)) {
      if (nativeMoleculeSelectionInRect(object, rect)) {
        objectIds.push(object.id);
      }
      continue;
    }

    if (object.type === "graphic") {
      const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
      if (
        plan.capabilities.isOpenStroke
          ? graphicObjectIntersectsRect(object, rect)
          : rectangleIntersectsRect(rect, documentObjectVisualBounds(object))
      ) {
        objectIds.push(object.id);
      }
      continue;
    }

    if (rectangleIntersectsRect(rect, objectBounds(object))) {
      objectIds.push(object.id);
    }
  }

  return objectIds;
}

export function selectionInSelectionLasso(
  objects: readonly DocumentObject[],
  points: readonly ClientPoint[]
): { objectIds: string[]; nativeSelection?: NativeMoleculeSelectionPart } {
  if (points.length < 3) {
    return { objectIds: [], nativeSelection: undefined };
  }

  const objectIds: string[] = [];
  let nativeSelection: NativeMoleculeSelectionPart | undefined;

  for (const object of objects) {
    if (object.type === "group") {
      continue;
    }

    if (object.type === "molecule" && isNativeMoleculeGraph(object)) {
      const moleculeSelection = nativeMoleculeSelectionInPolygon(object, points);
      if (!moleculeSelection) {
        continue;
      }

      if (nativeMoleculeSelectionCoversWholeObject(object, moleculeSelection)) {
        objectIds.push(object.id);
        continue;
      }

      nativeSelection ??= moleculeSelection;
      continue;
    }

    if (object.type === "graphic") {
      if (graphicObjectIntersectsPolygon(object, points)) {
        objectIds.push(object.id);
      }
      continue;
    }

    if (polygonIntersectsRect(points, objectBounds(object))) {
      objectIds.push(object.id);
    }
  }

  return promotedSelectionForGroupedObjects(objects, objectIds, nativeSelection);
}

function promotedSelectionForGroupedObjects(
  objects: readonly DocumentObject[],
  objectIds: readonly string[],
  nativeSelection: NativeMoleculeSelectionPart | undefined
): { objectIds: string[]; nativeSelection?: NativeMoleculeSelectionPart } {
  const selectableObjectIds = promoteDocumentObjectIdsToSelectableGroups(objects, objectIds);
  if (!nativeSelection) {
    return { objectIds: selectableObjectIds, nativeSelection: undefined };
  }

  const nativeSelectableId = promoteDocumentObjectIdsToSelectableGroups(objects, [nativeSelection.objectId])[0];
  if (!nativeSelectableId || nativeSelectableId === nativeSelection.objectId) {
    return { objectIds: selectableObjectIds, nativeSelection };
  }

  return {
    objectIds: selectableObjectIds.includes(nativeSelectableId)
      ? selectableObjectIds
      : [...selectableObjectIds, nativeSelectableId],
    nativeSelection: undefined
  };
}

function selectionSubtractStatusLabel(selection: { objectIds: readonly string[]; nativeSelection?: NativeMoleculeSelectionPart }): string {
  const removedCount = selection.objectIds.length + (selection.nativeSelection ? 1 : 0);
  if (removedCount === 0) {
    return "Selection unchanged";
  }
  return removedCount === 1 ? "Subtracted from selection" : `Subtracted ${removedCount} items from selection`;
}

export function selectionInSelectionPolygon(
  objects: readonly DocumentObject[],
  polygon: readonly ClientPoint[]
): { objectIds: string[]; nativeSelection?: NativeMoleculeSelectionPart } {
  if (polygon.length < 3) {
    return { objectIds: [] };
  }

  const objectIds: string[] = [];
  let nativeSelection: NativeMoleculeSelectionPart | undefined;

  for (const object of objects) {
    if (object.type === "molecule" && isNativeMoleculeGraph(object)) {
      const moleculeSelection = nativeMoleculeSelectionInPolygon(object, polygon);
      if (!moleculeSelection) {
        continue;
      }

      // If the lasso caught every atom and bond, it enclosed the whole molecule —
      // select it as an object (resize/rotate as a unit). Testing atom/bond coverage
      // is what the user actually drew around; gating on the padded bounding rect on
      // top of that just made "lasso around everything" unpredictably fall to a
      // fragment selection instead.
      if (nativeMoleculeSelectionCoversWholeObject(object, moleculeSelection)) {
        objectIds.push(object.id);
        continue;
      }

      nativeSelection ??= moleculeSelection;
      continue;
    }

    if (polygonContainsRect(polygon, objectBounds(object))) {
      objectIds.push(object.id);
    }
  }

  return { objectIds, nativeSelection };
}

function nativeMoleculeSelectionCoversWholeObject(
  object: MoleculeObject,
  selection: NativeMoleculeSelectionPart
): boolean {
  if (selection.kind === "atom") {
    return object.atoms.length === 1 && object.bonds.length === 0;
  }
  if (selection.kind === "bond") {
    return object.atoms.length === 0 && object.bonds.length === 1;
  }

  if (selection.kind === "ring" || selection.kind === "rings") {
    return false;
  }

  return (
    selection.atomIds.length === object.atoms.length &&
    selection.bondIds.length === object.bonds.length
  );
}

function rectangleContainsRect(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    inner.x >= outer.x &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y >= outer.y &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function rectangleIntersectsRect(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    first.x <= second.x + second.width &&
    first.x + first.width >= second.x &&
    first.y <= second.y + second.height &&
    first.y + first.height >= second.y
  );
}

function objectBounds(object: DocumentObject): { x: number; y: number; width: number; height: number } {
  return {
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height
  };
}

function parentGroupForDocumentObject(
  objects: readonly DocumentObject[],
  objectId: string
): GroupObject | undefined {
  return objects.find((object): object is GroupObject =>
    object.type === "group" && object.childObjectIds.includes(objectId)
  );
}

function selectableDocumentObjectIdForPointer(document: ChemDraftDocument, objectId: string): string {
  return promoteDocumentObjectIdsToSelectableGroups(document.pages[0]?.objects ?? [], [objectId])[0] ?? objectId;
}

export function groupedDragObjectIdsForPointer(document: ChemDraftDocument, objectId: string): string[] | undefined {
  const objects = document.pages[0]?.objects ?? [];
  if (document.selection.objectIds.length === 1 && document.selection.objectIds.includes(objectId)) {
    return undefined;
  }

  const resolvedSelectionIds = resolveGroupedDocumentObjectIds(objects, document.selection.objectIds);
  if (resolvedSelectionIds.length > 1 && resolvedSelectionIds.includes(objectId)) {
    return resolvedSelectionIds;
  }

  const parentGroup = parentGroupForDocumentObject(objects, objectId);
  if (!parentGroup) {
    return undefined;
  }

  const groupObjectIds = resolveGroupedDocumentObjectIds(objects, [parentGroup.id]);
  return groupObjectIds.length > 1 ? groupObjectIds : undefined;
}

export function visualSelectionBounds(
  objects: readonly DocumentObject[],
  ids: readonly string[]
): SelectionBounds | undefined {
  const selectedIds = new Set(resolveGroupedDocumentObjectIds(objects, ids));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (const object of objects) {
    if (!selectedIds.has(object.id)) {
      continue;
    }

    const bounds = documentObjectVisualBounds(object);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
    count += 1;
  }

  if (count === 0) {
    return undefined;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2
  };
}

function previewedGroupSelectionBounds(
  bounds: SelectionBounds,
  selectedIds: readonly string[],
  preview: ObjectTransformPreviewState | undefined
): SelectionBounds {
  if (preview?.mode !== "move" || !objectTransformPreviewCoversSelection(preview, selectedIds)) {
    return bounds;
  }

  return {
    x: bounds.x + preview.translateX,
    y: bounds.y + preview.translateY,
    width: bounds.width,
    height: bounds.height,
    centerX: bounds.centerX + preview.translateX,
    centerY: bounds.centerY + preview.translateY
  };
}

function objectTransformPreviewCoversSelection(
  preview: ObjectTransformPreviewState,
  selectedIds: readonly string[]
): boolean {
  if (preview.objectIds.length !== selectedIds.length) {
    return false;
  }

  const previewIds = new Set(preview.objectIds);
  return selectedIds.every((id) => previewIds.has(id));
}

function pointInsideObjectBounds(
  point: ClientPoint,
  object: DocumentObject,
  paddingPx = 0
): boolean {
  const bounds = objectBounds(object);
  return (
    point.x >= bounds.x - paddingPx &&
    point.x <= bounds.x + bounds.width + paddingPx &&
    point.y >= bounds.y - paddingPx &&
    point.y <= bounds.y + bounds.height + paddingPx
  );
}

export function nativeMoleculeObjectAtPoint(
  objects: readonly DocumentObject[],
  point: ClientPoint
): MoleculeObject | undefined {
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const object = objects[index];
    if (object.type === "molecule" && isNativeMoleculeGraph(object) && pointInsideObjectBounds(point, object, 4)) {
      return object;
    }
  }
  return undefined;
}

function moleculeTransformFrameForSelection(
  object: MoleculeObject,
  selectedPartBounds: { x: number; y: number; width: number; height: number } | undefined
): MoleculeTransformFrame {
  const rawFrame = selectedPartBounds
    ? {
        x: selectedPartBounds.x - object.x,
        y: selectedPartBounds.y - object.y,
        width: selectedPartBounds.width,
        height: selectedPartBounds.height
      }
    : {
        x: 0,
        y: 0,
        width: object.width,
        height: object.height
      };
  const minSize = 28;
  const width = Math.max(rawFrame.width, minSize);
  const height = Math.max(rawFrame.height, minSize);
  const center = {
    x: rawFrame.x + rawFrame.width / 2,
    y: rawFrame.y + rawFrame.height / 2
  };

  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height
  };
}

function nativeMoleculeSelectionInRect(
  object: MoleculeObject,
  rect: { x: number; y: number; width: number; height: number }
): NativeMoleculeSelectionPart | undefined {
  const atomIds = object.atoms
    .filter((atom) => pointInRect(atom, rect))
    .map((atom) => atom.id);
  const bondIds = object.bonds
    .filter((bond) => nativeBondIntersectsRect(object, bond, rect))
    .map((bond) => bond.id);

  if (atomIds.length === 0 && bondIds.length === 0) {
    return undefined;
  }

  if (atomIds.length === 1 && bondIds.length === 0) {
    return { objectId: object.id, kind: "atom", atomId: atomIds[0] };
  }

  if (atomIds.length === 0 && bondIds.length === 1) {
    return { objectId: object.id, kind: "bond", bondId: bondIds[0] };
  }

  return { objectId: object.id, kind: "parts", atomIds, bondIds };
}

function nativeMoleculeSelectionInPolygon(
  object: MoleculeObject,
  polygon: readonly ClientPoint[]
): NativeMoleculeSelectionPart | undefined {
  const atomIds = object.atoms
    .filter((atom) => pointInPolygon(atom, polygon))
    .map((atom) => atom.id);
  const bondIds = object.bonds
    .filter((bond) => nativeBondIntersectsPolygon(object, bond, polygon))
    .map((bond) => bond.id);

  if (atomIds.length === 0 && bondIds.length === 0) {
    return undefined;
  }

  if (atomIds.length === 1 && bondIds.length === 0) {
    return { objectId: object.id, kind: "atom", atomId: atomIds[0] };
  }

  if (atomIds.length === 0 && bondIds.length === 1) {
    return { objectId: object.id, kind: "bond", bondId: bondIds[0] };
  }

  return { objectId: object.id, kind: "parts", atomIds, bondIds };
}

function nativeBondIntersectsRect(
  object: MoleculeObject,
  bond: MoleculeObject["bonds"][number],
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  const fromAtom = object.atoms.find((atom) => atom.id === bond.fromAtomId);
  const toAtom = object.atoms.find((atom) => atom.id === bond.toAtomId);
  if (!fromAtom || !toAtom) {
    return false;
  }

  return (
    pointInRect(fromAtom, rect) ||
    pointInRect(toAtom, rect) ||
    lineIntersectsRect(fromAtom, toAtom, rect)
  );
}

function nativeBondIntersectsPolygon(
  object: MoleculeObject,
  bond: MoleculeObject["bonds"][number],
  polygon: readonly ClientPoint[]
): boolean {
  const fromAtom = object.atoms.find((atom) => atom.id === bond.fromAtomId);
  const toAtom = object.atoms.find((atom) => atom.id === bond.toAtomId);
  if (!fromAtom || !toAtom) {
    return false;
  }

  return (
    pointInPolygon(fromAtom, polygon) ||
    pointInPolygon(toAtom, polygon) ||
    lineIntersectsPolygon(fromAtom, toAtom, polygon)
  );
}

function pointInRect(
  point: ClientPoint,
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function polygonIntersectsRect(
  polygon: readonly ClientPoint[],
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  if (polygon.length < 3) {
    return false;
  }

  const corners = rectCorners(rect);
  return (
    corners.some((corner) => pointInPolygon(corner, polygon)) ||
    polygon.some((point) => pointInRect(point, rect)) ||
    polygonEdges(polygon).some(([start, end]) => lineIntersectsRect(start, end, rect))
  );
}

function pointInPolygon(point: ClientPoint, polygon: readonly ClientPoint[]): boolean {
  if (polygon.length < 3) {
    return false;
  }

  if (polygonEdges(polygon).some(([start, end]) => pointOnSegment(point, start, end))) {
    return true;
  }

  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crossesY = (currentPoint.y > point.y) !== (previousPoint.y > point.y);
    if (!crossesY) {
      continue;
    }

    const xAtY = ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
      (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (point.x <= xAtY) {
      inside = !inside;
    }
  }
  return inside;
}

export function nativeMoleculeRingSelectionFromPoint(
  object: MoleculeObject,
  point: ClientPoint
): NativeMoleculeRingSelectionPart | undefined {
  const ring = nativeMoleculeRings(object)
    .filter((candidate) => pointInPolygon(point, candidate.points))
    .sort((a, b) => a.area - b.area || a.ringKey.localeCompare(b.ringKey))[0];
  return ring
    ? {
        objectId: object.id,
        kind: "ring",
        ringKey: ring.ringKey,
        atomIds: ring.atomIds,
        bondIds: ring.bondIds
      }
    : undefined;
}

function nativeMoleculeRingSelectionFromPointerTarget(
  object: MoleculeObject,
  target: EventTarget | null,
  point: ClientPoint
): NativeMoleculeRingSelectionPart | undefined {
  const targetRingKey = nativeMoleculeRingKeyFromPointerTarget(target);
  if (targetRingKey) {
    const ring = nativeMoleculeRings(object).find((candidate) => candidate.ringKey === targetRingKey);
    if (ring) {
      return {
        objectId: object.id,
        kind: "ring",
        ringKey: ring.ringKey,
        atomIds: ring.atomIds,
        bondIds: ring.bondIds
      };
    }
  }

  return nativeMoleculeRingSelectionFromPoint(object, point);
}

function nativeMoleculeRingKeyFromPointerTarget(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }

  return target.closest("[data-ring-hit-key]")?.getAttribute("data-ring-hit-key") ?? undefined;
}

function nativeRingSelectionItems(part: NativeMoleculeSelectionPart | undefined): NativeMoleculeRingSelectionItem[] {
  if (part?.kind === "ring") {
    return [{
      ringKey: part.ringKey,
      atomIds: part.atomIds,
      bondIds: part.bondIds
    }];
  }

  return part?.kind === "rings" ? [...part.rings] : [];
}

function nativeRingSelectionFromItems(
  objectId: string,
  rings: readonly NativeMoleculeRingSelectionItem[]
): NativeMoleculeRingSelectionPart | NativeMoleculeRingSetSelectionPart | undefined {
  const unique = rings.filter((ring, index) =>
    rings.findIndex((candidate) => candidate.ringKey === ring.ringKey) === index
  );
  if (unique.length === 0) {
    return undefined;
  }

  if (unique.length === 1) {
    const ring = unique[0];
    return {
      objectId,
      kind: "ring",
      ringKey: ring.ringKey,
      atomIds: ring.atomIds,
      bondIds: ring.bondIds
    };
  }

  return { objectId, kind: "rings", rings: unique };
}

/**
 * Validate one molecule's selected part against the current document (atoms/bonds/rings may have
 * been deleted, or the Rings toolbar closed) and return the still-valid part, or undefined to drop it.
 * Shared by the post-mutation prune effect so every selected molecule stays consistent (Phase 7
 * keeps a part per molecule, so this runs once per entry instead of once for a single slot).
 */
// Prunes a stored native part against the current document, dropping only parts whose
// atoms/bonds/rings no longer exist. It deliberately does NOT clear ring parts based on
// whether the Rings toolbar is open: that state is synced from asynchronous native
// window events and can momentarily read "closed" while the toolbar is genuinely open,
// which used to clobber a just-made ring selection on the next document change. Clearing a
// ring selection when the toolbar is *deliberately* closed is handled in `toggleToolset`.
export function pruneNativeMoleculePart(
  document: ChemDraftDocument,
  part: NativeMoleculeSelectionPart
): NativeMoleculeSelectionPart | undefined {
  const object = findDocumentObject(document, part.objectId);
  if (object?.type !== "molecule") {
    return undefined;
  }

  if (part.kind === "atom") {
    return object.atoms.some((atom) => atom.id === part.atomId) ? part : undefined;
  }

  if (part.kind === "bond") {
    return object.bonds.some((bond) => bond.id === part.bondId) ? part : undefined;
  }

  if (part.kind === "ring") {
    const ring = nativeMoleculeRings(object).find((candidate) => candidate.ringKey === part.ringKey);
    return ring ? { ...part, atomIds: ring.atomIds, bondIds: ring.bondIds } : undefined;
  }

  if (part.kind === "rings") {
    const objectRings = nativeMoleculeRings(object);
    const rings = part.rings.flatMap((selectedRing) => {
      const ring = objectRings.find((candidate) => candidate.ringKey === selectedRing.ringKey);
      return ring ? [{ ringKey: ring.ringKey, atomIds: ring.atomIds, bondIds: ring.bondIds }] : [];
    });
    return nativeRingSelectionFromItems(part.objectId, rings);
  }

  const atomIds = part.atomIds.filter((atomId) => object.atoms.some((atom) => atom.id === atomId));
  const bondIds = part.bondIds.filter((bondId) => object.bonds.some((bond) => bond.id === bondId));
  return atomIds.length > 0 || bondIds.length > 0 ? { ...part, atomIds, bondIds } : undefined;
}

function lineIntersectsPolygon(
  start: ClientPoint,
  end: ClientPoint,
  polygon: readonly ClientPoint[]
): boolean {
  return (
    pointInPolygon(start, polygon) ||
    pointInPolygon(end, polygon) ||
    polygonEdges(polygon).some(([edgeStart, edgeEnd]) => segmentsIntersect(start, end, edgeStart, edgeEnd))
  );
}

function lineIntersectsRect(
  start: ClientPoint,
  end: ClientPoint,
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;

  return (
    segmentsIntersect(start, end, { x: left, y: top }, { x: right, y: top }) ||
    segmentsIntersect(start, end, { x: right, y: top }, { x: right, y: bottom }) ||
    segmentsIntersect(start, end, { x: right, y: bottom }, { x: left, y: bottom }) ||
    segmentsIntersect(start, end, { x: left, y: bottom }, { x: left, y: top })
  );
}

function polygonEdges(polygon: readonly ClientPoint[]): Array<[ClientPoint, ClientPoint]> {
  return polygon.map((point, index) => [point, polygon[(index + 1) % polygon.length]]);
}

function polygonContainsRect(
  polygon: readonly ClientPoint[],
  rect: { x: number; y: number; width: number; height: number },
  marginPx = 0
): boolean {
  const expanded = {
    x: rect.x - marginPx,
    y: rect.y - marginPx,
    width: rect.width + marginPx * 2,
    height: rect.height + marginPx * 2
  };
  return rectangleContainsRect(polygonBounds(polygon), expanded) &&
    rectCorners(expanded).every((point) => pointInPolygon(point, polygon));
}

function polygonBounds(polygon: readonly ClientPoint[]): { x: number; y: number; width: number; height: number } {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY
  };
}

function rectCorners(rect: { x: number; y: number; width: number; height: number }): ClientPoint[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height }
  ];
}

function segmentsIntersect(a: ClientPoint, b: ClientPoint, c: ClientPoint, d: ClientPoint): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const denominator = abx * cdy - aby * cdx;

  if (denominator === 0) {
    return false;
  }

  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const t = (acx * cdy - acy * cdx) / denominator;
  const u = (acx * aby - acy * abx) / denominator;

  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function pointOnSegment(point: ClientPoint, start: ClientPoint, end: ClientPoint): boolean {
  const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
  if (lengthSquared === 0) {
    // Degenerate (zero-length) segment — lasso paths routinely contain consecutive
    // duplicate points (release without moving). Without this guard the cross/dot
    // math below degenerates to 0 <= 0 and EVERY point tests "on segment", which
    // made pointInPolygon swallow the whole page and the lasso grab whole molecules.
    return point.x === start.x && point.y === start.y;
  }

  const cross = (point.y - start.y) * (end.x - start.x) - (point.x - start.x) * (end.y - start.y);
  if (Math.abs(cross) > 0.0001) {
    return false;
  }

  const dot = (point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y);
  if (dot < 0) {
    return false;
  }

  return dot <= lengthSquared;
}

export function nativeSelectionFromHit(
  objectId: string,
  hit: NativeMoleculeDeleteHit
): NativeMoleculeTransformableSelectionPart {
  return hit.kind === "atom"
    ? { objectId, kind: "atom", atomId: hit.atomId }
    : { objectId, kind: "bond", bondId: hit.bondId };
}

export function nativeContextMenuSelectionFromHit(
  objectId: string,
  hit: NativeMoleculeDeleteHit,
  currentPart: NativeMoleculeSelectionPart | undefined,
  molecule?: MoleculeObject
): NativeMoleculeSelectionPart {
  const compatibleCurrentPart = currentPart?.objectId === objectId ? currentPart : undefined;
  // Preserve the existing (possibly multi-part) selection when the hit is inside the visible
  // selected fragment — including an endpoint atom of a selected bond — not just when the raw
  // primitive id is explicitly listed. Falls back to strict containment without the molecule.
  const preserve = compatibleCurrentPart !== undefined && (
    molecule
      ? nativeSelectionContextContainsHit(molecule, compatibleCurrentPart, hit)
      : nativeSelectionContainsHit(compatibleCurrentPart, hit)
  );
  return preserve && compatibleCurrentPart
    ? compatibleCurrentPart
    : nativeSelectionFromHit(objectId, hit);
}

export function nativeContextMenuSelectionResolutionFromHit(
  document: ChemDraftDocument,
  objectId: string,
  hit: NativeMoleculeDeleteHit,
  currentPart: NativeMoleculeSelectionPart | undefined
): {
  selectedPart?: NativeMoleculeSelectionPart;
  targetKind: "object" | NativeMoleculeSelectionPart["kind"];
} {
  if (isWholeNativeMoleculeSelected(document, objectId, currentPart)) {
    return { targetKind: "object" };
  }

  const selectedPart = nativeContextMenuSelectionFromHit(
    objectId,
    hit,
    currentPart,
    nativeMoleculeById(document, objectId)
  );
  return {
    selectedPart,
    targetKind: selectedPart.kind
  };
}

function nativeSelectionAtomIds(part: NativeMoleculeSelectionPart | undefined): string[] {
  if (part?.kind === "atom") {
    return [part.atomId];
  }

  return part?.kind === "parts" ? [...part.atomIds] : [];
}

function nativeSelectionBondIds(part: NativeMoleculeSelectionPart | undefined): string[] {
  if (part?.kind === "bond") {
    return [part.bondId];
  }

  return part?.kind === "parts" ? [...part.bondIds] : [];
}

function nativeSelectionColorTarget(
  part: NativeMoleculeSelectionPart | undefined
): ToolbarColorSelection["moleculePart"] {
  return part?.kind === "ring" || part?.kind === "rings" ? undefined : part;
}

function nativeTransformableSelectionPart(
  part: NativeMoleculeSelectionPart | undefined
): NativeMoleculeTransformableSelectionPart | undefined {
  return part?.kind === "ring" || part?.kind === "rings" ? undefined : part;
}

export function bondDepthRefsFromNativeSelection(
  part: NativeMoleculeSelectionPart | undefined,
  document?: ChemDraftDocument
): BondRef[] {
  const molecule = part && document
    ? nativeMoleculeForSelectionPart(document, part)
    : undefined;
  const atomIds = new Set(nativeSelectionAtomIds(part));
  const explicitBondIds = nativeSelectionBondIds(part);
  const incidentBondIds = molecule
    ? molecule.bonds
        .filter((bond) => atomIds.has(bond.fromAtomId) || atomIds.has(bond.toAtomId))
        .map((bond) => bond.id)
    : [];

  return uniqueBondRefs([...explicitBondIds, ...incidentBondIds].map((bondId) => ({
    objectId: part?.objectId ?? "",
    bondId
  })).filter((ref) => ref.objectId.length > 0));
}

export function bondDepthContextFromNativeSelection(
  part: NativeMoleculeSelectionPart | undefined,
  crossings: readonly ResolvedBondCrossing[],
  document?: ChemDraftDocument
): BondDepthContext | undefined {
  const targetBondRefs = uniqueBondRefs(bondDepthRefsFromNativeSelection(part, document));
  if (targetBondRefs.length === 0) {
    return undefined;
  }

  const relevantCrossings = crossings
    .filter((crossing) => crossing.bonds.some((ref) => bondRefInSet(ref, targetBondRefs)))
    .map(menuCrossingFromResolved);
  if (relevantCrossings.length === 0) {
    return undefined;
  }

  return {
    targetBondRefs,
    relevantCrossings,
    hasOverrides: relevantCrossings.some((crossing) => crossing.hasOverride)
  };
}

export function applyLayerCommandToDocumentSelection(
  document: ChemDraftDocument,
  commandId: string,
  options: {
    selectedNativeMoleculePart?: NativeMoleculeSelectionPart;
    crossings?: readonly ResolvedBondCrossing[];
  } = {}
): LayerCommandSelectionResult {
  const placement = objectLayerPlacementForCommandId(commandId);
  if (!placement) {
    return { document };
  }

  const bondDepthCommandId = bondDepthCommandIdForObjectLayerCommand(commandId);
  if (options.selectedNativeMoleculePart && bondDepthCommandId) {
    const page = document.pages[0];
    const crossings = options.crossings ?? planPageSvgRender(page).crossings;
    const bondDepthContext = bondDepthContextFromNativeSelection(
      options.selectedNativeMoleculePart,
      crossings,
      document
    );
    const patches = planBondDepthPatches(page.id, bondDepthContext, bondDepthCommandId);
    return {
      document: patches.length > 0 ? applyPatches(document, patches) : document,
      placement,
      bondDepthCommandId,
      bondDepthContext
    };
  }

  return {
    document: reorderSelectedDocumentObjectWithCrossingDefaults(document, placement),
    placement
  };
}

export function bondDepthCommandIdForObjectLayerCommand(commandId: string): BondDepthCommandId | undefined {
  if (commandId === "layout.bringToFront" || commandId === "layout.bringForward") {
    return "bondDepth.bringInFront";
  }

  if (commandId === "layout.sendToBack" || commandId === "layout.sendBackward") {
    return "bondDepth.sendBehind";
  }

  return undefined;
}

function objectLayerPlacementForCommandId(commandId: string): ObjectReorderPlacement | undefined {
  if (commandId === "layout.bringToFront") {
    return "front";
  }

  if (commandId === "layout.bringForward") {
    return "forward";
  }

  if (commandId === "layout.sendToBack") {
    return "back";
  }

  if (commandId === "layout.sendBackward") {
    return "backward";
  }

  return undefined;
}

function nativeMoleculeForSelectionPart(
  document: ChemDraftDocument,
  part: NativeMoleculeSelectionPart
): MoleculeObject | undefined {
  return document.pages
    .flatMap((page) => page.objects)
    .find((object): object is MoleculeObject =>
      object.type === "molecule" && object.id === part.objectId
    );
}

export function planBondDepthPatches(
  pageId: string,
  context: BondDepthContext | undefined,
  commandId: BondDepthCommandId
): DocumentPatch[] {
  if (!context) {
    return [];
  }

  if (commandId === "bondDepth.useDefault") {
    return context.relevantCrossings
      .filter((crossing) => crossing.hasOverride)
      .map((crossing) => ({
        op: "clearCrossingOverride",
        pageId,
        bonds: crossing.bonds
      }));
  }

  return context.relevantCrossings.flatMap((crossing) => {
    const crossingTargets = crossing.bonds.filter((ref) => bondRefInSet(ref, context.targetBondRefs));
    if (crossingTargets.length !== 1) {
      return [];
    }

    const target = crossingTargets[0];
    if (commandId === "bondDepth.bringInFront") {
      return sameBondRef(crossing.front, target)
        ? []
        : [{
            op: "setCrossingOverride",
            pageId,
            crossing: { bonds: crossing.bonds, front: target }
          }];
    }

    const other = crossing.bonds.find((ref) => !sameBondRef(ref, target));
    return other && sameBondRef(crossing.front, target)
      ? [{
          op: "setCrossingOverride",
          pageId,
          crossing: { bonds: crossing.bonds, front: other }
        }]
      : [];
  });
}

function isBondDepthCommandId(commandId: string): commandId is BondDepthCommandId {
  return commandId === "bondDepth.bringInFront" ||
    commandId === "bondDepth.sendBehind" ||
    commandId === "bondDepth.useDefault";
}

export function crossingClearPatchesForObjectLayerPlacement(
  page: ChemDraftDocument["pages"][number],
  objectIds: string | readonly string[],
  placement: ObjectReorderPlacement
): DocumentPatch[] {
  const selectedObjectIds = Array.isArray(objectIds) ? objectIds : [objectIds];
  const affectedObjectIds = objectLayerPlacementAffectedObjectIds(page.objects, selectedObjectIds, placement);
  if (affectedObjectIds.length === 0) {
    return [];
  }

  const selected = new Set(selectedObjectIds);
  const affected = new Set(affectedObjectIds);
  return page.crossings
    .filter((crossing) => crossingTouchesSelectedAndAffectedObject(crossing.bonds, selected, affected))
    .map((crossing) => ({
      op: "clearCrossingOverride",
      pageId: page.id,
      bonds: crossing.bonds
    }));
}

export function reorderSelectedDocumentObjectWithCrossingDefaults(
  document: ChemDraftDocument,
  placement: ObjectReorderPlacement
): ChemDraftDocument {
  const objectIds = selectedLayerObjectIds(document);
  if (objectIds.length === 0) {
    return document;
  }

  const page = document.pages.find((candidate) => objectIds.some((objectId) =>
    candidate.objects.some((object) => object.id === objectId)
  ));
  if (!page) {
    return document;
  }

  const crossingPatches = crossingClearPatchesForObjectLayerPlacement(page, objectIds, placement);
  const reordered = reorderSelectedDocumentObject(document, placement);
  return crossingPatches.length > 0 ? applyPatches(reordered, crossingPatches) : reordered;
}

function objectLayerPlacementAffectedObjectIds(
  objects: readonly DocumentObject[],
  objectIds: string | readonly string[],
  placement: ObjectReorderPlacement
): string[] {
  const currentOrder = objects.map((object) => object.id);
  const candidateObjectIds = Array.isArray(objectIds) ? objectIds : [objectIds];
  const selected = new Set(candidateObjectIds.filter((objectId) => currentOrder.includes(objectId)));
  if (selected.size === 0) {
    return [];
  }

  if (placement === "front" || placement === "back") {
    return currentOrder.filter((objectId) => !selected.has(objectId));
  }

  const nextOrder = reorderedLayerObjectIds(currentOrder, candidateObjectIds, placement);
  return currentOrder.filter((objectId, index) =>
    !selected.has(objectId) && nextOrder[index] !== objectId
  );
}

function crossingTouchesSelectedAndAffectedObject(
  bonds: readonly [BondRef, BondRef],
  selectedObjectIds: ReadonlySet<string>,
  affectedObjectIds: ReadonlySet<string>
): boolean {
  const [first, second] = bonds;
  return (selectedObjectIds.has(first.objectId) && affectedObjectIds.has(second.objectId)) ||
    (selectedObjectIds.has(second.objectId) && affectedObjectIds.has(first.objectId));
}

function bondDepthStatusForCommand(commandId: BondDepthCommandId): string {
  if (commandId === "bondDepth.bringInFront") {
    return "Brought bond depth forward";
  }
  if (commandId === "bondDepth.sendBehind") {
    return "Sent bond depth behind";
  }
  return "Restored default bond depth";
}

function menuCrossingFromResolved(crossing: ResolvedBondCrossing): BondDepthMenuCrossing {
  return {
    key: crossing.key,
    bonds: crossing.bonds,
    front: crossing.front,
    back: crossing.back,
    hasOverride: crossing.hasOverride
  };
}

function uniqueBondRefs(refs: readonly BondRef[]): BondRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = bondRefKey(ref);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function bondRefInSet(ref: BondRef, refs: readonly BondRef[]): boolean {
  return refs.some((candidate) => sameBondRef(candidate, ref));
}

function toggledSelectionIds(ids: readonly string[], id: string): string[] {
  return ids.includes(id)
    ? ids.filter((candidate) => candidate !== id)
    : [...ids, id];
}

function nativeSelectionFromIds(
  objectId: string,
  atomIds: readonly string[],
  bondIds: readonly string[]
): NativeMoleculeSelectionPart | undefined {
  if (atomIds.length === 0 && bondIds.length === 0) {
    return undefined;
  }

  if (atomIds.length === 1 && bondIds.length === 0) {
    return { objectId, kind: "atom", atomId: atomIds[0] };
  }

  if (atomIds.length === 0 && bondIds.length === 1) {
    return { objectId, kind: "bond", bondId: bondIds[0] };
  }

  return { objectId, kind: "parts", atomIds: [...atomIds], bondIds: [...bondIds] };
}

export function nativeSelectionWithHitToggled(
  currentPart: NativeMoleculeSelectionPart | undefined,
  objectId: string,
  hit: NativeMoleculeDeleteHit
): NativeMoleculeSelectionPart | undefined {
  const compatibleCurrentPart = currentPart?.objectId === objectId ? currentPart : undefined;
  const atomIds = nativeSelectionAtomIds(compatibleCurrentPart);
  const bondIds = nativeSelectionBondIds(compatibleCurrentPart);

  return hit.kind === "atom"
    ? nativeSelectionFromIds(objectId, toggledSelectionIds(atomIds, hit.atomId), bondIds)
    : nativeSelectionFromIds(objectId, atomIds, toggledSelectionIds(bondIds, hit.bondId));
}

export function nativeMoleculeSelectionDragIntent(
  document: ChemDraftDocument,
  objectId: string,
  selectedPart: NativeMoleculeSelectionPart | undefined,
  hit: NativeMoleculeDeleteHit | undefined
): NativeMoleculeSelectionDragIntent {
  if (!hit) {
    return { kind: "none" };
  }

  const selectableObjectId = promoteDocumentObjectIdsToSelectableGroups(
    document.pages[0]?.objects ?? [],
    [objectId]
  )[0] ?? objectId;
  if (selectableObjectId !== objectId) {
    return { kind: "whole-object" };
  }

  if (isWholeNativeMoleculeSelected(document, objectId, selectedPart)) {
    return { kind: "whole-object" };
  }

  const currentPart = selectedPart?.objectId === objectId ? selectedPart : undefined;
  const molecule = nativeMoleculeById(document, objectId);
  // Dragging from an endpoint atom of a selected bond should move the whole selected fragment,
  // matching the visible selection — so use the same context-aware containment as right-click.
  const withinSelection = currentPart !== undefined && (
    molecule
      ? nativeSelectionContextContainsHit(molecule, currentPart, hit)
      : nativeSelectionContainsHit(currentPart, hit)
  );
  if (withinSelection && currentPart && currentPart.kind !== "ring" && currentPart.kind !== "rings") {
    return { kind: "native-part", target: currentPart };
  }

  if (hit.kind === "atom") {
    return { kind: "native-part", target: nativeSelectionFromHit(objectId, hit) };
  }

  return { kind: "none" };
}

function nativeSelectionIncludesAtom(part: NativeMoleculeSelectionPart | undefined, atomId: string): boolean {
  if (part?.kind === "atom") {
    return part.atomId === atomId;
  }

  return part?.kind === "parts" && part.atomIds.includes(atomId);
}

function nativeSelectionIncludesBond(part: NativeMoleculeSelectionPart | undefined, bondId: string): boolean {
  if (part?.kind === "bond") {
    return part.bondId === bondId;
  }

  return part?.kind === "parts" && part.bondIds.includes(bondId);
}

function nativeSelectionRenderKey(part: NativeMoleculeSelectionPart | undefined): string {
  if (!part) {
    return "none";
  }

  if (part.kind === "atom") {
    return `atom:${part.atomId}`;
  }

  if (part.kind === "bond") {
    return `bond:${part.bondId}`;
  }

  if (part.kind === "ring") {
    return `ring:${part.ringKey}`;
  }

  if (part.kind === "rings") {
    return `rings:${part.rings.map((ring) => ring.ringKey).join(",")}`;
  }

  return `parts:a=${part.atomIds.join(",")};b=${part.bondIds.join(",")}`;
}

export function nativeMoleculeSelectionHasVisibleTargets(
  object: MoleculeObject,
  selected: boolean,
  selectedPart: NativeMoleculeSelectionPart | undefined
): boolean {
  if (selected && selectedPart?.objectId !== object.id) {
    return object.atoms.length > 0 || object.bonds.length > 0;
  }

  if (!selectedPart || selectedPart.objectId !== object.id) {
    return false;
  }

  return (
    object.atoms.some((atom) => nativeSelectionIncludesAtom(selectedPart, atom.id)) ||
    object.bonds.some((bond) => nativeSelectionIncludesBond(selectedPart, bond.id))
  );
}

function nativeSelectionContainsHit(
  part: NativeMoleculeSelectionPart,
  hit: NativeMoleculeDeleteHit
): boolean {
  if (hit.kind === "atom") {
    return nativeSelectionIncludesAtom(part, hit.atomId);
  }

  return nativeSelectionIncludesBond(part, hit.bondId);
}

/**
 * Whether a hit belongs to the *visible* selected fragment, not just the raw primitive list.
 * The selection blob draws each selected bond's endpoint atoms as selected (see the
 * `selectedAtomIds.add(bond.fromAtomId/.toAtomId)` expansion in the molecule renderer), so a
 * right-click or drag that lands on such an endpoint atom should be treated as inside the
 * selection — even though the atom id is not explicitly stored in `part.atomIds`. The strict
 * `nativeSelectionContainsHit` stays for primitive-identity callers (e.g. delete).
 */
function nativeSelectionContextContainsHit(
  molecule: MoleculeObject,
  part: NativeMoleculeSelectionPart,
  hit: NativeMoleculeDeleteHit
): boolean {
  if (nativeSelectionContainsHit(part, hit)) {
    return true;
  }

  if (hit.kind === "atom") {
    return molecule.bonds.some(
      (bond) =>
        nativeSelectionIncludesBond(part, bond.id) &&
        (bond.fromAtomId === hit.atomId || bond.toAtomId === hit.atomId)
    );
  }

  return false;
}

/** The molecule object for `objectId`, or undefined when it is not an editable molecule. */
function nativeMoleculeById(document: ChemDraftDocument, objectId: string): MoleculeObject | undefined {
  const object = findDocumentObject(document, objectId);
  return object?.type === "molecule" ? object : undefined;
}

function isWholeNativeMoleculeSelected(
  document: ChemDraftDocument,
  objectId: string,
  selectedPart: NativeMoleculeSelectionPart | undefined
): boolean {
  const selectedObjectIds = resolveGroupedDocumentObjectIds(
    document.pages[0]?.objects ?? [],
    document.selection.objectIds
  );
  return selectedObjectIds.includes(objectId) && selectedPart?.objectId !== objectId;
}

function selectionStatusLabel(selection: {
  objectIds: readonly string[];
  nativeSelection?: NativeMoleculeSelectionPart;
  /** Phase 7: when a selection spans several molecules, the aggregate drives the label. */
  nativeSelections?: readonly NativeMoleculeSelectionPart[];
}): string {
  if (selection.nativeSelections && selection.nativeSelections.length > 1) {
    let atoms = 0;
    let bonds = 0;
    let rings = 0;
    for (const part of selection.nativeSelections) {
      if (part.kind === "atom") {
        atoms += 1;
      } else if (part.kind === "bond") {
        bonds += 1;
      } else if (part.kind === "ring") {
        rings += 1;
      } else if (part.kind === "rings") {
        rings += part.rings.length;
      } else {
        atoms += part.atomIds.length;
        bonds += part.bondIds.length;
      }
    }
    if (rings > 0 && atoms === 0 && bonds === 0) {
      return `Selected ${rings} rings`;
    }
    if (rings === 0) {
      return `Selected ${atoms + bonds} molecule parts`;
    }
    return `Selected ${atoms + bonds + rings} molecule parts`;
  }

  if (selection.nativeSelection?.kind === "atom") {
    return "Selected atom";
  }

  if (selection.nativeSelection?.kind === "bond") {
    return "Selected bond";
  }

  if (selection.nativeSelection?.kind === "ring") {
    return "Selected ring";
  }

  if (selection.nativeSelection?.kind === "rings") {
    return `Selected ${selection.nativeSelection.rings.length} rings`;
  }

  if (selection.nativeSelection?.kind === "parts") {
    const count = selection.nativeSelection.atomIds.length + selection.nativeSelection.bondIds.length;
    return count === 1 ? "Selected molecule part" : `Selected ${count} molecule parts`;
  }

  if (selection.objectIds.length === 1) {
    return "Selected object";
  }

  if (selection.objectIds.length > 1) {
    return `Selected ${selection.objectIds.length} objects`;
  }

  return "No selection";
}

function PageSvgSurface({
  ariaLabel,
  pageHeight,
  pageWidth,
  plan,
  spinningObjectId,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onContextMenu
}: {
  ariaLabel: string;
  pageHeight: number;
  pageWidth: number;
  plan: PageSvgRenderPlan;
  /** The id of the molecule being spun in 3D; its drawn structure fades to a faint ghost. */
  spinningObjectId?: string;
  onPointerDown(objectId: string, event: ObjectPointerEvent): void;
  onPointerMove(objectId: string, event: ObjectPointerEvent): void;
  onPointerUp(objectId: string, event: ObjectPointerEvent): void;
  onPointerCancel(event: ObjectPointerEvent): void;
  onPointerLeave(objectId: string): void;
  onContextMenu(objectId: string, event: ObjectMouseEvent): void;
}) {
  return (
    <svg
      aria-label={`${ariaLabel} page drawing`}
      className="page-svg-surface"
      data-page-svg-surface="true"
      viewBox={`0 0 ${pageWidth} ${pageHeight}`}
    >
      {plan.fragments.map((fragment) => {
        const rendered = renderPageSvgFragment(fragment, {
          onContextMenu,
          onPointerCancel,
          onPointerDown,
          onPointerLeave,
          onPointerMove,
          onPointerUp
        });
        // The spun molecule's drawn structure fades to a faint ghost (the live 3D overlay
        // paints on top); pointer events off so the overlay owns the drag.
        const isSpinning = spinningObjectId !== undefined &&
          fragment.attrs["data-object-id"] === spinningObjectId;
        return isSpinning
          ? <g key={`spin-${fragment.key}`} opacity={0.1} style={{ pointerEvents: "none" }}>{rendered}</g>
          : rendered;
      })}
    </svg>
  );
}

/** Object types in the current selection, for routing a command to a surface that can edit them. */
export function selectedDocumentObjectTypes(document: ChemDraftDocument): ReadonlySet<DocumentObject["type"]> {
  const selectedIds = new Set(document.selection.objectIds);
  const types = new Set<DocumentObject["type"]>();
  if (selectedIds.size === 0) {
    return types;
  }
  for (const page of document.pages) {
    for (const object of page.objects) {
      if (selectedIds.has(object.id)) {
        types.add(object.type);
      }
    }
  }
  return types;
}

export function editorPageSvgSurfaceIncludesObject(object: DocumentObject): boolean {
  // Types the interactive overlay draws in full are excluded here, or the surface and the overlay
  // both paint them — visibly, since the surface strokes #172026 while the overlay's CSS strokes
  // #111111. Export is unaffected: it plans the page directly and never applies this filter.
  if (object.type === "graphic" || object.type === "bracket" || object.type === "reaction-arrow") {
    return false;
  }

  return object.type !== "molecule" || !isNativeMoleculeGraph(object);
}

function nativeMoleculeOverlayFragmentsByObjectId(page: DocumentPage): ReadonlyMap<string, readonly PageSvgElementFragment[]> {
  const nativeMoleculeIds = new Set(page.objects
    .filter((object): object is MoleculeObject => object.type === "molecule" && isNativeMoleculeGraph(object))
    .map((object) => object.id));
  if (nativeMoleculeIds.size === 0) {
    return new Map();
  }

  const byObjectId = new Map<string, PageSvgElementFragment[]>();
  planPageSvgRender(page).fragments.forEach((fragment) => {
    const objectId = typeof fragment.attrs["data-object-id"] === "string"
      ? fragment.attrs["data-object-id"]
      : undefined;
    if (!objectId || !nativeMoleculeIds.has(objectId)) {
      return;
    }

    const fragments = byObjectId.get(objectId) ?? [];
    fragments.push(fragment);
    byObjectId.set(objectId, fragments);
  });

  return byObjectId;
}

function renderPageSvgFragment(
  fragment: PageSvgFragment,
  handlers: {
    onPointerDown(objectId: string, event: ObjectPointerEvent): void;
    onPointerMove(objectId: string, event: ObjectPointerEvent): void;
    onPointerUp(objectId: string, event: ObjectPointerEvent): void;
    onPointerCancel(event: ObjectPointerEvent): void;
    onPointerLeave(objectId: string): void;
    onContextMenu(objectId: string, event: ObjectMouseEvent): void;
  }
): ReturnType<typeof createElement> | string {
  if (fragment.kind === "text") {
    return fragment.text;
  }

  const objectId = typeof fragment.attrs["data-object-id"] === "string"
    ? fragment.attrs["data-object-id"]
    : undefined;
  const props = reactSvgProps(fragment.attrs);
  if (objectId) {
    Object.assign(props, {
      onContextMenu: (event: ObjectMouseEvent) => handlers.onContextMenu(objectId, event),
      onPointerCancel: (event: ObjectPointerEvent) => handlers.onPointerCancel(event),
      onPointerDown: (event: ObjectPointerEvent) => handlers.onPointerDown(objectId, event),
      onPointerLeave: () => handlers.onPointerLeave(objectId),
      onPointerMove: (event: ObjectPointerEvent) => handlers.onPointerMove(objectId, event),
      onPointerUp: (event: ObjectPointerEvent) => handlers.onPointerUp(objectId, event)
    });
  }

  return createElement(
    fragment.tag,
    { ...props, key: fragment.key },
    ...fragment.children.map((child) => renderPageSvgFragment(child, handlers))
  );
}

function renderStaticPageSvgFragment(
  fragment: PageSvgFragment
): ReturnType<typeof createElement> | string {
  if (fragment.kind === "text") {
    return fragment.text;
  }

  return createElement(
    fragment.tag,
    { ...staticSvgProps(fragment.attrs), key: fragment.key },
    ...fragment.children.map((child) => renderStaticPageSvgFragment(child))
  );
}

function staticSvgProps(attrs: Record<string, PageSvgAttributeValue>): Record<string, unknown> {
  const props = reactSvgProps(attrs);
  delete props["data-object-id"];
  delete props["data-layer-index"];
  delete props["data-object-type"];
  return props;
}

function reactSvgProps(attrs: Record<string, PageSvgAttributeValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attrs)
      .filter(([, value]) => value !== undefined && value !== false && value !== "")
      .map(([key, value]) => [reactSvgAttributeName(key), value])
  );
}

function reactSvgAttributeName(name: string): string {
  return {
    class: "className",
    "baseline-shift": "baselineShift",
    "clip-path": "clipPath",
    "color-interpolation-filters": "colorInterpolationFilters",
    "dominant-baseline": "dominantBaseline",
    "fill-opacity": "fillOpacity",
    "flood-color": "floodColor",
    "flood-opacity": "floodOpacity",
    "font-family": "fontFamily",
    "font-size": "fontSize",
    "font-style": "fontStyle",
    "font-weight": "fontWeight",
    "letter-spacing": "letterSpacing",
    "marker-end": "markerEnd",
    "marker-start": "markerStart",
    "paint-order": "paintOrder",
    "pointer-events": "pointerEvents",
    "stop-color": "stopColor",
    "stop-opacity": "stopOpacity",
    "stroke-dasharray": "strokeDasharray",
    "stroke-dashoffset": "strokeDashoffset",
    "stroke-linecap": "strokeLinecap",
    "stroke-linejoin": "strokeLinejoin",
    "stroke-miterlimit": "strokeMiterlimit",
    "stroke-opacity": "strokeOpacity",
    "stroke-width": "strokeWidth",
    "text-anchor": "textAnchor",
    "text-decoration": "textDecoration",
    "vector-effect": "vectorEffect"
  }[name] ?? name;
}

function DocumentObjectView({
  object,
  layerIndex,
  pageWidth,
  pageHeight,
  spinning = false,
  selected,
  inGroupSelection,
  graphicTransformActive,
  graphicDirectEditActive,
  graphicPathFeedbackActive,
  graphicSegmentEraseActive,
  graphicEyedropperTargetActive,
  activeArtPaintTarget,
  selectedGraphicPathNodeIndex,
  selectedPart,
  transformHandlesEnabled,
  editingText,
  editingAtomLabel,
  chargeByAtomId,
  growthPreview,
  deleteTarget,
  hoverDestructive,
  freeformPreview,
  doubleBondSidePreview,
  nativeMoleculeSvgFragments,
  rotateReadout,
  projectedPlaneTiltReadout,
  rotationInput,
  rotationHandlesVisible,
  resizeReadout,
  resizeInput,
  objectTransformPreview,
  graphicCornerRadiusReadout,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onRotatePointerDown,
  onRotateDoubleClick,
  onProjectedPlaneTiltPointerDown,
  onProjectedPlaneTiltDoubleClick,
  onGraphicCornerRadiusPointerDown,
  onGraphicCornerRadiusDoubleClick,
  onGraphicPathEditPointerDown,
  onGraphicMarkerPointerDown,
  onGraphicGradientPointerDown,
  onRotationInputChange,
  onRotationInputKeep,
  onRotationInputHome,
  onRotationInputCancel,
  onObjectResizePointerDown,
  onObjectResizeDoubleClick,
  onObjectResizeInputChange,
  onObjectResizeInputKeep,
  onObjectResizeInputHome,
  onObjectResizeInputCancel,
  onContextMenu,
  onTextChange,
  onTextEditStart,
  onTextEditFinish,
  onTextSelectionChange,
  onTextResizeStart,
  onAtomLabelChange,
  onAtomLabelCancel,
  onAtomLabelFinish
}: {
  object: DocumentObject;
  layerIndex: number;
  pageWidth: number;
  pageHeight: number;
  spinning?: boolean;
  selected: boolean;
  inGroupSelection: boolean;
  graphicTransformActive: boolean;
  graphicDirectEditActive: boolean;
  graphicPathFeedbackActive: boolean;
  graphicSegmentEraseActive: boolean;
  graphicEyedropperTargetActive: boolean;
  activeArtPaintTarget: GraphicStylePaintTarget;
  selectedGraphicPathNodeIndex?: number;
  selectedPart?: NativeMoleculeSelectionPart;
  transformHandlesEnabled: boolean;
  editingText: boolean;
  editingAtomLabel?: AtomLabelEditState;
  chargeByAtomId?: ReadonlyMap<string, number>;
  growthPreview?: HoveredNativeAtom;
  deleteTarget?: NativeMoleculeDeleteTarget;
  hoverDestructive: boolean;
  freeformPreview?: FreeformNativeBondPreview;
  doubleBondSidePreview?: NativeDoubleBondSidePreview;
  nativeMoleculeSvgFragments?: readonly PageSvgElementFragment[];
  rotateReadout?: ObjectRotateReadoutState;
  projectedPlaneTiltReadout?: ProjectedPlaneTiltReadoutState;
  rotationInput?: RotationInputState;
  rotationHandlesVisible: boolean;
  resizeReadout?: ObjectResizeReadoutState;
  resizeInput?: ObjectResizeInputState;
  objectTransformPreview?: ObjectTransformPreviewState;
  graphicCornerRadiusReadout?: GraphicCornerRadiusReadoutState;
  onPointerDown(objectId: string, event: ObjectPointerEvent): void;
  onPointerMove(objectId: string, event: ObjectPointerEvent): void;
  onPointerUp(objectId: string, event: ObjectPointerEvent): void;
  onPointerCancel(event: ObjectPointerEvent): void;
  onPointerLeave(objectId: string): void;
  onRotatePointerDown(objectId: string, event: PointerEvent<HTMLButtonElement>): void;
  onRotateDoubleClick(objectId: string, event: ReactMouseEvent<HTMLButtonElement>): void;
  onProjectedPlaneTiltPointerDown(objectId: string, event: PointerEvent<HTMLButtonElement>): void;
  onProjectedPlaneTiltDoubleClick(objectId: string, event: ReactMouseEvent<HTMLButtonElement>): void;
  onGraphicCornerRadiusPointerDown(objectId: string, event: PointerEvent<HTMLButtonElement>): void;
  onGraphicCornerRadiusDoubleClick(objectId: string, event: ReactMouseEvent<HTMLButtonElement>): void;
  onGraphicPathEditPointerDown(objectId: string, handle: NativeGraphicPathEditHandle, event: PointerEvent<Element>): void;
  onGraphicMarkerPointerDown(objectId: string, markerId: NativeGraphicMarkerHandleId, event: PointerEvent<HTMLButtonElement>): void;
  onGraphicGradientPointerDown(objectId: string, target: GraphicStylePaintTarget, handle: NativeGraphicGradientHandleId, event: PointerEvent<HTMLButtonElement>): void;
  onRotationInputChange(nextInput: RotationInputState): void;
  onRotationInputKeep(input: RotationInputState): void;
  onRotationInputHome(input: RotationInputState): void;
  onRotationInputCancel(input: RotationInputState): void;
  onObjectResizePointerDown(objectId: string, corner: ObjectResizeCorner, event: PointerEvent<HTMLButtonElement>): void;
  onObjectResizeDoubleClick(objectId: string, corner: ObjectResizeCorner, event: ReactMouseEvent<HTMLButtonElement>): void;
  onObjectResizeInputChange(nextInput: ObjectResizeInputState): void;
  onObjectResizeInputKeep(input: ObjectResizeInputState): void;
  onObjectResizeInputHome(input: ObjectResizeInputState): void;
  onObjectResizeInputCancel(input: ObjectResizeInputState): void;
  onContextMenu(objectId: string, event: ObjectMouseEvent): void;
  onTextChange(objectId: string, text: string): void;
  onTextEditStart(objectId: string): void;
  onTextEditFinish(): void;
  onTextSelectionChange(objectId: string, range: NativeTextSelectionRange): void;
  onTextResizeStart(objectId: string, edge: TextResizeEdge, event: PointerEvent<HTMLButtonElement>): void;
  onAtomLabelChange(state: AtomLabelEditState, text: string): void;
  onAtomLabelCancel(state: AtomLabelEditState): void;
  onAtomLabelFinish(): void;
}) {
  const textEditorRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editingText || object.type !== "text") {
      return;
    }

    const editor = textEditorRef.current;
    if (!editor) {
      return;
    }

    editor.focus();
    if (object.text === "Text") {
      editor.select();
    }
  }, [editingText, object]);

  if (object.type === "group") {
    return null;
  }

  const handleObjectPointerDown = (event: ObjectPointerEvent) => {
    onPointerDown(object.id, event);
  };
  const handleObjectPointerMove = (event: ObjectPointerEvent) => {
    onPointerMove(object.id, event);
  };
  const handleObjectPointerUp = (event: ObjectPointerEvent) => {
    onPointerUp(object.id, event);
  };
  const handleObjectPointerCancel = (event: ObjectPointerEvent) => {
    onPointerCancel(event);
  };
  const handleObjectPointerLeave = () => {
    onPointerLeave(object.id);
  };
  const handleObjectContextMenu = (event: ObjectMouseEvent) => {
    onContextMenu(object.id, event);
  };
  const handleRotatePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    onRotatePointerDown(object.id, event);
  };
  const handleRotateDoubleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onRotateDoubleClick(object.id, event);
  };
  const handleProjectedPlaneTiltPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    onProjectedPlaneTiltPointerDown(object.id, event);
  };
  const handleProjectedPlaneTiltDoubleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onProjectedPlaneTiltDoubleClick(object.id, event);
  };
  const handleGraphicCornerRadiusPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    onGraphicCornerRadiusPointerDown(object.id, event);
  };
  const handleGraphicCornerRadiusDoubleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onGraphicCornerRadiusDoubleClick(object.id, event);
  };
  const handleGraphicPathEditPointerDown = (handle: NativeGraphicPathEditHandle) => (event: PointerEvent<Element>) => {
    onGraphicPathEditPointerDown(object.id, handle, event);
  };
  const handleGraphicMarkerPointerDown = (markerId: NativeGraphicMarkerHandleId) => (event: PointerEvent<HTMLButtonElement>) => {
    onGraphicMarkerPointerDown(object.id, markerId, event);
  };
  const handleGraphicGradientPointerDown = (
    target: GraphicStylePaintTarget,
    handle: NativeGraphicGradientHandleId
  ) => (event: PointerEvent<HTMLButtonElement>) => {
    onGraphicGradientPointerDown(object.id, target, handle, event);
  };
  const handleObjectResizePointerDown = (corner: ObjectResizeCorner) => (event: PointerEvent<HTMLButtonElement>) => {
    onObjectResizePointerDown(object.id, corner, event);
  };
  const handleObjectResizeDoubleClick = (corner: ObjectResizeCorner) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    onObjectResizeDoubleClick(object.id, corner, event);
  };
  const handleTextChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    recordTextEditorSelection(event.currentTarget);
    onTextChange(object.id, event.currentTarget.value);
  };
  const recordTextEditorSelection = (editor: HTMLTextAreaElement) => {
    onTextSelectionChange(object.id, {
      start: editor.selectionStart,
      end: editor.selectionEnd
    });
  };
  const insertTextAtEditorSelection = (editor: HTMLTextAreaElement, text: string) => {
    if (object.type !== "text" || text.length === 0) {
      return;
    }

    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const currentValue = editor.value;
    const nextValue = `${currentValue.slice(0, start)}${text}${currentValue.slice(end)}`;
    const cursor = start + text.length;
    onTextChange(object.id, nextValue);
    window.requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(cursor, cursor);
      recordTextEditorSelection(editor);
    });
  };
  const handleTextPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (text.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    insertTextAtEditorSelection(event.currentTarget, text);
  };
  const handleTextKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onTextEditFinish();
      return;
    }

    const commandKeyPressed = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (commandKeyPressed && key === "a") {
      event.preventDefault();
      event.currentTarget.select();
      recordTextEditorSelection(event.currentTarget);
      return;
    }

    // Cmd/Ctrl+V is intentionally not intercepted here: preventing the default action would also
    // cancel the native `paste` event that handleTextPaste relies on. Let it through so the editor's
    // onPaste handler inserts clipboard text synchronously, without needing async-read permission.
  };
  const handleTextDoubleClick = (event: ObjectMouseEvent) => {
    if (object.type !== "text") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onTextEditStart(object.id);
  };
  const handleTextResizeStart = (edge: TextResizeEdge) => (event: PointerEvent<HTMLButtonElement>) => {
    onTextResizeStart(object.id, edge, event);
  };
  const handleAtomLabelKeyDown = (state: AtomLabelEditState, event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      onAtomLabelFinish();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onAtomLabelCancel(state);
    }
  };
  const artObjectProjection = documentObjectSupportsArtTransform(object)
    ? documentObjectProjectedPlaneProjection(object)
    : undefined;
  const style = {
    left: `${(object.x / pageWidth) * 100}%`,
    top: `${(object.y / pageHeight) * 100}%`,
    width: `${(object.width / pageWidth) * 100}%`,
    height: `${(object.height / pageHeight) * 100}%`,
    zIndex: layerIndex + 20,
    transform: documentObjectOuterCssTransform(object, artObjectProjection, objectTransformPreview),
    transformOrigin: documentObjectOuterCssTransformOrigin(object, objectTransformPreview)
  } as CSSProperties;
  const artObjectTransformFrameStyle = documentObjectSupportsArtTransform(object)
    ? documentObjectArtTransformFrameStyle(object, artObjectProjection, objectTransformPreview)
    : undefined;
  const graphicPathEditPoints = object.type === "graphic" ? nativeGraphicPathEditPoints(object) : undefined;
  const graphicPathNodeEditPoints = object.type === "graphic" ? nativeGraphicPathNodeEditPoints(object) : undefined;
  const graphicCornerRadiusEditPoint = object.type === "graphic" ? nativeGraphicCornerRadiusEditPoint(object) : undefined;
  const gradientPaintObject = object.type === "graphic" || object.type === "molecule" ? object : undefined;
  const graphicLinearGradientHandlePoints = gradientPaintObject
    ? nativeGraphicLinearGradientHandlePoints(gradientPaintObject, activeArtPaintTarget)
    : undefined;
  const graphicRadialGradientHandlePoints = gradientPaintObject
    ? nativeGraphicRadialGradientHandlePoints(gradientPaintObject, activeArtPaintTarget)
    : undefined;
  const hasGraphicGradientHandles = graphicLinearGradientHandlePoints !== undefined ||
    graphicRadialGradientHandlePoints !== undefined;
  const wholeGradientPaintObjectSelected = object.type !== "molecule" || selectedPart?.objectId !== object.id;
  const graphicEditHandlesActive = graphicDirectEditActive || !graphicTransformActive;
  const showGraphicGradientHandles = selected &&
    gradientPaintObject !== undefined &&
    wholeGradientPaintObjectSelected &&
    hasGraphicGradientHandles &&
    !inGroupSelection &&
    graphicEditHandlesActive &&
    !editingText &&
    !editingAtomLabel &&
    !rotateReadout &&
    !projectedPlaneTiltReadout &&
    !rotationInput &&
    !resizeReadout &&
    !resizeInput &&
    !objectTransformPreview;
  const pathGraphicInEditMode = (selected || graphicPathFeedbackActive) &&
    object.type === "graphic" &&
    (graphicPathEditPoints !== undefined || graphicPathNodeEditPoints !== undefined) &&
    graphicEditHandlesActive &&
    !showGraphicGradientHandles;
  const showGraphicCornerRadiusHandle = selected &&
    object.type === "graphic" &&
    graphicCornerRadiusEditPoint !== undefined &&
    !inGroupSelection &&
    graphicEditHandlesActive &&
    !pathGraphicInEditMode &&
    !editingText &&
    !editingAtomLabel &&
    !rotateReadout &&
    !projectedPlaneTiltReadout &&
    !rotationInput &&
    !resizeReadout &&
    !resizeInput;
  const graphicDirectEditChromeActive = pathGraphicInEditMode ||
    showGraphicGradientHandles;
  const showArtObjectTransformFrame = selected &&
    !inGroupSelection &&
    documentObjectSupportsArtTransform(object) &&
    !graphicDirectEditChromeActive;
  const zRotationHandleVisible = rotationHandlesVisible || rotateReadout !== undefined;
  const projectedPlaneTiltHandleVisible = rotationHandlesVisible || projectedPlaneTiltReadout !== undefined;
  const artObjectTransformFrame = showArtObjectTransformFrame ? (
    <ArtObjectTransformFrame
      frameStyle={artObjectTransformFrameStyle}
      targetLabel="selected art object"
      canProjectedPlaneTilt={object.type !== "graphic" || !graphicObjectIsFreehandPath(object)}
      rotationHandlesVisible={rotationHandlesVisible}
      rotateReadout={rotateReadout}
      projectedPlaneTiltReadout={projectedPlaneTiltReadout}
      rotationInput={rotationInput}
      resizeReadout={resizeReadout}
      resizeInput={resizeInput}
      onRotatePointerDown={handleRotatePointerDown}
      onRotateDoubleClick={handleRotateDoubleClick}
      onProjectedPlaneTiltPointerDown={handleProjectedPlaneTiltPointerDown}
      onProjectedPlaneTiltDoubleClick={handleProjectedPlaneTiltDoubleClick}
      onRotationInputChange={onRotationInputChange}
      onRotationInputKeep={onRotationInputKeep}
      onRotationInputHome={onRotationInputHome}
      onRotationInputCancel={onRotationInputCancel}
      onResizePointerDown={handleObjectResizePointerDown}
      onResizeDoubleClick={handleObjectResizeDoubleClick}
      onResizeInputChange={onObjectResizeInputChange}
      onResizeInputKeep={onObjectResizeInputKeep}
      onResizeInputHome={onObjectResizeInputHome}
      onResizeInputCancel={onObjectResizeInputCancel}
    />
  ) : null;

  if (object.type === "molecule") {
    if (isNativeMoleculeGraph(object)) {
      const drawingStyle = nativeDrawingStyleFromObjectStyle(object.style);
      const atomLabelPlanByAtomId = new Map(planMoleculeAtomLabels(object).map((plan) => [plan.atom.id, plan]));
      const invalidAtomStates = nativeMoleculeInvalidAtomStates(object, chargeByAtomId);
      const invalidAtomIds = new Set(invalidAtomStates.map((state) => state.atomId));
      const resolvedChargeAtomIds = [...(chargeByAtomId?.entries() ?? [])]
        .filter(([, charge]) => charge !== 0)
        .map(([atomId]) => atomId);
      const wholeNativeMoleculeSelected = selected && selectedPart?.objectId !== object.id;
      const selectedBondIds = new Set(
        wholeNativeMoleculeSelected
          ? object.bonds.map((bond) => bond.id)
          : object.bonds
              .filter((bond) => nativeSelectionIncludesBond(selectedPart, bond.id))
              .map((bond) => bond.id)
      );
      const selectedAtomIds = new Set(
        wholeNativeMoleculeSelected
          ? object.atoms.map((atom) => atom.id)
          : object.atoms
              .filter((atom) => nativeSelectionIncludesAtom(selectedPart, atom.id))
              .map((atom) => atom.id)
      );
      object.bonds
        .filter((bond) => selectedBondIds.has(bond.id))
        .forEach((bond) => {
          selectedAtomIds.add(bond.fromAtomId);
          selectedAtomIds.add(bond.toAtomId);
        });
      const transformableSelectedPart = nativeTransformableSelectionPart(
        selectedPart?.objectId === object.id ? selectedPart : undefined
      );
      const hasVisibleSelectionTargets = nativeMoleculeSelectionHasVisibleTargets(object, selected, transformableSelectedPart);
      const moleculeRings = nativeMoleculeRings(object);
      const selectedRingKeys = selectedPart?.objectId === object.id
        ? nativeRingSelectionItems(selectedPart).map((ring) => ring.ringKey)
        : [];
      const selectedRingKeySet = new Set(selectedRingKeys);
      const selectedRings = moleculeRings.filter((ring) => selectedRingKeySet.has(ring.ringKey));
      const selectedFragmentBounds = transformableSelectedPart && hasVisibleSelectionTargets
        ? nativeMoleculePartBounds(object, transformableSelectedPart)
        : undefined;
      const transformFrame = transformHandlesEnabled && !showGraphicGradientHandles && hasVisibleSelectionTargets && !inGroupSelection && (selected || selectedFragmentBounds)
        ? moleculeTransformFrameForSelection(object, selectedFragmentBounds)
        : undefined;
      const transformTargetLabel = selectedFragmentBounds ? "selected molecule fragment" : "selected molecule";
      const canProjectedPlaneTilt = transformFrame !== undefined;
      const transformFrameStyle = transformFrame ? {
        left: `calc(${transformFrame.x}px * var(--page-scale))`,
        top: `calc(${transformFrame.y}px * var(--page-scale))`,
        width: `calc(${transformFrame.width}px * var(--page-scale))`,
        height: `calc(${transformFrame.height}px * var(--page-scale))`
      } as CSSProperties : undefined;
      const selectionBlob = selectedBondIds.size > 0 || selectedAtomIds.size > 0 ? (
        <g
          className={[
            "native-molecule-selection-blob",
            selectedBondIds.size > 0 ? "native-bond-selection-connectors" : "",
            wholeNativeMoleculeSelected ? "native-whole-selection" : ""
          ].filter(Boolean).join(" ")}
          data-selection-blob="true"
          data-bond-selection-connectors={selectedBondIds.size > 0 ? "true" : undefined}
          data-whole-molecule-selection={wholeNativeMoleculeSelected ? "true" : undefined}
        >
          {object.bonds.flatMap((bond) => {
            if (!selectedBondIds.has(bond.id)) {
              return [];
            }

            const fromAtom = object.atoms.find((atom) => atom.id === bond.fromAtomId);
            const toAtom = object.atoms.find((atom) => atom.id === bond.toAtomId);
            if (!fromAtom || !toAtom) {
              return [];
            }

            return [
              <line
                className={[
                  "native-selection-blob-bond",
                  "native-bond-selection-connector",
                  wholeNativeMoleculeSelected ? "native-whole-selection-bond" : ""
                ].filter(Boolean).join(" ")}
                data-selected-bond-id={bond.id}
                key={`selection-blob-bond-${bond.id}`}
                x1={fromAtom.x - object.x}
                y1={fromAtom.y - object.y}
                x2={toAtom.x - object.x}
                y2={toAtom.y - object.y}
              />
            ];
          })}
          {object.atoms
            .filter((atom) => selectedAtomIds.has(atom.id))
            .map((atom) => (
              <circle
                className={[
                  "native-selection-blob-atom",
                  wholeNativeMoleculeSelected ? "native-whole-selection-atom" : "native-atom-selected"
                ].filter(Boolean).join(" ")}
                data-selected-atom-id={atom.id}
                cx={atom.x - object.x}
                cy={atom.y - object.y}
                key={`selection-blob-atom-${atom.id}`}
                r="8.8"
              />
          ))}
        </g>
      ) : null;
      const selectedRingBlobs = selectedRings.map((ring) => (
        <path
          className="native-molecule-selected-ring"
          data-selected-ring-key={ring.ringKey}
          d={ring.pathD}
          key={`selected-ring-${ring.ringKey}`}
          transform={`translate(${formatSvgNumber(-object.x)} ${formatSvgNumber(-object.y)})`}
        />
      ));
      const moleculeGradientHandles = showGraphicGradientHandles ? (
        <>
          <GraphicLinearGradientHandles
            object={object}
            target={activeArtPaintTarget}
            onPointerDown={handleGraphicGradientPointerDown}
          />
          <GraphicRadialGradientHandles
            object={object}
            target={activeArtPaintTarget}
            onPointerDown={handleGraphicGradientPointerDown}
          />
        </>
      ) : null;
      return (
        <div
          className={[
            "document-object",
            "document-object-overlay",
            "molecule-object",
            "native-molecule-object",
            moleculeDrawingPrimitive(object) === "single-bond" ? "native-single-bond" : "native-carbon-chain",
            selected ? "native-molecule-selected" : ""
          ].filter(Boolean).join(" ")}
          style={style}
          data-object-id={object.id}
          data-layer-index={layerIndex}
          data-structure={object.structure}
          data-atom-count={object.atoms.length}
          data-bond-count={object.bonds.length}
          data-bond-orders={object.bonds.map((bond) => `${bond.id}:${bond.order}`).join(",")}
          data-style-preset-id={drawingStyle.stylePresetId}
          data-invalid-atom-ids={invalidAtomStates.map((state) => state.atomId).join(",") || undefined}
          data-resolved-charge-atom-ids={resolvedChargeAtomIds.join(",") || undefined}
          data-hovered-atom-id={growthPreview?.atomId}
          data-growth-preview-atom-id={growthPreview?.atomId}
          data-delete-hover-kind={deleteTarget?.kind}
          data-delete-hover-atom-id={deleteTarget?.kind === "atom" ? deleteTarget.atomId : undefined}
          data-delete-hover-bond-id={deleteTarget?.kind === "bond" ? deleteTarget.bondId : undefined}
          data-selected-native-kind={selectedPart?.kind}
          data-selected-native-atom-id={selectedPart?.kind === "atom" ? selectedPart.atomId : undefined}
          data-selected-native-bond-id={selectedPart?.kind === "bond" ? selectedPart.bondId : undefined}
          data-selected-native-ring-key={selectedPart?.kind === "ring" ? selectedPart.ringKey : undefined}
          data-selected-native-ring-keys={selectedRingKeys.length > 0 ? selectedRingKeys.join(",") : undefined}
          data-freeform-preview-atom-id={freeformPreview?.atomId}
          data-freeform-preview-target-atom-id={freeformPreview?.targetAtomId}
          data-freeform-preview-custom-length={freeformPreview?.customLength}
          data-freeform-preview-length-angstrom={freeformPreview?.lengthAngstrom}
          data-double-bond-preview-bond-id={doubleBondSidePreview?.bondId}
          data-double-bond-preview-side={doubleBondSidePreview?.side}
          data-graphic-interaction-mode={showGraphicGradientHandles ? "gradient-edit" : undefined}
          aria-label={moleculeAriaLabel(object)}
          onPointerDown={handleObjectPointerDown}
          onPointerMove={handleObjectPointerMove}
          onPointerUp={handleObjectPointerUp}
          onPointerCancel={handleObjectPointerCancel}
          onPointerLeave={handleObjectPointerLeave}
          onContextMenu={handleObjectContextMenu}
        >
          <svg
            className="native-molecule-overlay"
            viewBox={`0 0 ${object.width} ${object.height}`}
            aria-hidden="true"
            // While spinning, fade the selection blob/overlays so only the faint structure
            // and the live 3D overlay read; the transform frame (sibling) stays full opacity.
            style={spinning ? { opacity: 0.1 } : undefined}
          >
            {nativeMoleculeSvgFragments && nativeMoleculeSvgFragments.length > 0 ? (
              <g
                className="native-molecule-overlay-visual"
                data-native-molecule-overlay-visual="true"
                transform={`translate(${formatSvgNumber(-object.x)} ${formatSvgNumber(-object.y)})`}
              >
                {nativeMoleculeSvgFragments.map((fragment) => renderStaticPageSvgFragment(fragment))}
              </g>
            ) : null}
            {selectionBlob}
            {selectedRingBlobs}
            {object.atoms
              .filter((atom) => invalidAtomIds.has(atom.id))
              .map((atom) => (
                <g
                  className="native-atom-invalid-marker"
                  data-invalid-atom-id={atom.id}
                  key={`invalid-${atom.id}`}
                >
                  <circle
                    className="native-atom-invalid-ring"
                    cx={atom.x - object.x + 9}
                    cy={atom.y - object.y - 9}
                    r="6"
                  />
                  <text
                    className="native-atom-invalid-exclamation"
                    x={atom.x - object.x + 9}
                    y={atom.y - object.y - 9}
                  >
                    !
                  </text>
                </g>
              ))}
            {object.atoms
              .filter((atom) => deleteTarget?.kind === "atom" && atom.id === deleteTarget.atomId)
              .map((atom) => (
                <circle
                  className={hoverDestructive ? "native-atom-delete-hover" : "native-atom-hover"}
                  cx={atom.x - object.x}
                  cy={atom.y - object.y}
                  key={`hover-${atom.id}`}
                  r="8"
                />
              ))}
            {/* Bond hover, drawn from the resolver result so it matches the click target
                (invariant #2) instead of the old CSS :hover decorator. */}
            {deleteTarget?.kind === "bond"
              ? [deleteTarget].flatMap((target) => {
                  const from = object.atoms.find((atom) => atom.id === target.fromAtomId);
                  const to = object.atoms.find((atom) => atom.id === target.toAtomId);
                  return from && to
                    ? [
                        <line
                          className={hoverDestructive ? "native-bond-delete-hover" : "native-bond-hover"}
                          key={`hover-${target.bondId}`}
                          x1={from.x - object.x}
                          y1={from.y - object.y}
                          x2={to.x - object.x}
                          y2={to.y - object.y}
                        />
                      ]
                    : [];
                })
              : null}
            {object.atoms
              .filter((atom) => atom.id === growthPreview?.atomId && atom.id !== freeformPreview?.atomId)
              .map((atom) => (
                <NativeBondGrowthPreview
                  atom={atom}
                  candidateDirections={growthPreview?.candidateDirections ?? [growthPreview?.direction ?? { x: 1, y: 0 }]}
                  direction={growthPreview?.direction ?? { x: 1, y: 0 }}
                  key={atom.id}
                  object={object}
                />
              ))}
            {object.atoms
              .filter((atom) => atom.id === freeformPreview?.atomId)
              .map((atom) => (
                <NativeFreeformBondPreview
                  atom={atom}
                  key={atom.id}
                  newAtomPoint={freeformPreview?.newAtomPoint ?? atom}
                  object={object}
                  targetAtom={object.atoms.find((candidate) => candidate.id === freeformPreview?.targetAtomId)}
              />
            ))}
          </svg>
          {moleculeGradientHandles}
          {transformFrame ? (
            <div
              className="object-transform-frame"
              data-molecule-transform-frame={selectedFragmentBounds ? "fragment" : "whole"}
              data-has-tilt3d={canProjectedPlaneTilt ? "true" : undefined}
              style={transformFrameStyle}
            >
              <ObjectResizeHandles
                targetLabel={transformTargetLabel}
                onResizeDoubleClick={handleObjectResizeDoubleClick}
                onResizeStart={handleObjectResizePointerDown}
              />
              {resizeReadout && !resizeInput ? (
                <ObjectResizeReadout
                  scaleXPercent={resizeReadout.scaleXPercent}
                  scaleYPercent={resizeReadout.scaleYPercent}
                />
              ) : null}
              {zRotationHandleVisible ? (
                <button
                  type="button"
                  className="object-rotate-handle"
                  aria-label={`Rotate ${transformTargetLabel}`}
                  data-selection-rotate-handle="true"
                  title={`Rotate ${transformTargetLabel}`}
                  onPointerDown={handleRotatePointerDown}
                  onDoubleClick={handleRotateDoubleClick}
                >
                  <RotateSelectionIcon />
                  {rotateReadout ? (
                    <RotateSelectionReadout degrees={rotateReadout.degrees} />
                  ) : null}
                </button>
              ) : null}
              {canProjectedPlaneTilt && projectedPlaneTiltHandleVisible ? (
                <button
                  type="button"
                  className="object-tilt3d-handle"
                  aria-label={`3D rotate ${transformTargetLabel}`}
                  data-selection-tilt3d-handle="true"
                  title={`3D rotate ${transformTargetLabel}`}
                  onPointerDown={handleProjectedPlaneTiltPointerDown}
                  onDoubleClick={handleProjectedPlaneTiltDoubleClick}
                >
                  <ProjectedPlaneTiltIcon />
                  {projectedPlaneTiltReadout ? (
                    <ProjectedPlaneTiltReadout
                      label={projectedPlaneTiltReadout.label}
                      limited={projectedPlaneTiltReadout.limited}
                    />
                  ) : null}
                </button>
              ) : null}
              {rotationInput ? (
                <RotationInputPopover
                  input={rotationInput}
                  onKeep={onRotationInputKeep}
                  onHome={onRotationInputHome}
                  onCancel={onRotationInputCancel}
                  onChange={onRotationInputChange}
                />
              ) : null}
              {resizeInput ? (
                <ObjectResizeInputPopover
                  input={resizeInput}
                  onKeep={onObjectResizeInputKeep}
                  onHome={onObjectResizeInputHome}
                  onCancel={onObjectResizeInputCancel}
                  onChange={onObjectResizeInputChange}
                />
              ) : null}
            </div>
          ) : null}
          {editingAtomLabel ? object.atoms
            .filter((atom) => atom.id === editingAtomLabel.atomId)
            .map((atom) => {
              const editorLabel = editingAtomLabel.draft.trim() || atom.element || "C";
              const labelStyle = atomLabelPlanByAtomId.get(atom.id)?.drawingStyle ?? drawingStyle;
              const anchorOffset = atomLabelAnchorOffset(atom, editorLabel, labelStyle);
              return (
                <input
                  aria-label="Atom label"
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  autoFocus
                  className="native-atom-label-editor"
                  data-atom-label-editor="true"
                  data-atom-label-draft-empty={editingAtomLabel.draft.length === 0 ? "true" : undefined}
                  data-atom-id={atom.id}
                  key={`atom-label-editor-${atom.id}`}
                  spellCheck={false}
                  style={{
                    left: `calc(${atom.x + anchorOffset.x - object.x}px * var(--page-scale))`,
                    top: `calc(${atom.y + anchorOffset.y - object.y}px * var(--page-scale))`,
                    width: `${Math.max(1, editingAtomLabel.draft.length + 0.6)}ch`,
                    fontFamily: labelStyle.atomLabelFontFamily,
                    fontSize: `calc(${labelStyle.atomLabelFontSizePx}px * var(--page-scale))`,
                    fontWeight: labelStyle.atomLabelFontWeight,
                    fontStyle: labelStyle.atomLabelFontStyle
                  }}
                  value={editingAtomLabel.draft}
                  onBlur={onAtomLabelFinish}
                  onChange={(event) => onAtomLabelChange(editingAtomLabel, event.currentTarget.value)}
                  onKeyDown={(event) => handleAtomLabelKeyDown(editingAtomLabel, event)}
                  onPointerDown={(event) => event.stopPropagation()}
                />
              );
            }) : null}
        </div>
      );
    }

    return (
      <div
        className={["document-object", "document-object-overlay", "molecule-object", selected ? "selected" : ""].filter(Boolean).join(" ")}
        style={style}
        data-object-id={object.id}
        data-layer-index={layerIndex}
        aria-label={moleculeAriaLabel(object)}
        onPointerDown={handleObjectPointerDown}
        onPointerMove={handleObjectPointerMove}
        onPointerUp={handleObjectPointerUp}
        onPointerCancel={handleObjectPointerCancel}
        onPointerLeave={handleObjectPointerLeave}
        onDoubleClick={handleTextDoubleClick}
      />
    );
  }

  if (object.type === "electron-mark" && object.markKind === "charge") {
    const charge = object.charge === -1 ? -1 : 1;
    return (
      <div
        className={["document-object", "document-object-overlay", "charge-mark-object", selected ? "selected" : ""].filter(Boolean).join(" ")}
        style={style}
        data-object-id={object.id}
        data-layer-index={layerIndex}
        data-charge={charge}
        aria-label={charge > 0 ? "Positive charge" : "Negative charge"}
        onPointerDown={handleObjectPointerDown}
        onPointerMove={handleObjectPointerMove}
        onPointerUp={handleObjectPointerUp}
        onPointerCancel={handleObjectPointerCancel}
        onPointerLeave={handleObjectPointerLeave}
      />
    );
  }

  if (object.type === "text") {
    const textStyle = nativeTextStyleFromObjectStyle(object.style);
    const objectTextScript = textScriptForTextObject(object);
    const textCss = {
      color: textStyle.color,
      fontFamily: textStyle.fontFamily,
      fontWeight: textStyle.fontWeight,
      fontSize: `calc(${textStyle.fontSizePx}px * var(--page-scale))`,
      lineHeight: textStyle.lineHeight,
      letterSpacing: `calc(${textStyle.letterSpacingPx}px * var(--page-scale))`,
      textAlign: textStyle.textAlign,
      fontStyle: textStyle.fontStyle,
      textDecoration: textStyle.textDecoration
    } as CSSProperties;
    const textEditorCss = {
      ...textCss,
      color: "transparent",
      caretColor: textStyle.color,
      ...(objectTextScript === "normal" ? {} : {
        fontSize: `calc(${textStyle.fontSizePx * 0.72}px * var(--page-scale))`,
        lineHeight: Math.max(1, textStyle.lineHeight),
        paddingTop: objectTextScript === "subscript" ? `calc(${textStyle.fontSizePx * 0.3}px * var(--page-scale))` : 0,
        paddingBottom: objectTextScript === "superscript" ? `calc(${textStyle.fontSizePx * 0.28}px * var(--page-scale))` : 0
      })
    } as CSSProperties;

    return (
      <div
        className={["document-object", "document-object-overlay", "text-object", editingText ? "editing" : "", selected ? "selected" : ""].filter(Boolean).join(" ")}
        style={{ ...style, ...textCss }}
        data-object-id={object.id}
        data-layer-index={layerIndex}
        data-text-align={textStyle.textAlign}
        data-text-script={objectTextScript}
        data-text-sizing-mode={String(object.style.textBoxSizingMode ?? "auto")}
        onPointerDown={handleObjectPointerDown}
        onPointerMove={handleObjectPointerMove}
        onPointerUp={handleObjectPointerUp}
        onPointerCancel={handleObjectPointerCancel}
        onPointerLeave={handleObjectPointerLeave}
      >
        {(selected && !inGroupSelection) || editingText ? (
          <>
            <button
              type="button"
              className="text-resize-handle text-resize-handle-left"
              aria-label="Resize text box left"
              data-text-resize-edge="left"
              onPointerDown={handleTextResizeStart("left")}
            />
            <button
              type="button"
              className="text-resize-handle text-resize-handle-right"
              aria-label="Resize text box right"
              data-text-resize-edge="right"
              onPointerDown={handleTextResizeStart("right")}
            />
            <button
              type="button"
              className="text-resize-handle text-resize-handle-top"
              aria-label="Resize text box top"
              data-text-resize-edge="top"
              onPointerDown={handleTextResizeStart("top")}
            />
            <button
              type="button"
              className="text-resize-handle text-resize-handle-bottom"
              aria-label="Resize text box bottom"
              data-text-resize-edge="bottom"
              onPointerDown={handleTextResizeStart("bottom")}
            />
          </>
        ) : null}
        {selected && !inGroupSelection && !editingText && zRotationHandleVisible ? (
          <button
            type="button"
            className="object-rotate-handle text-rotate-handle"
            aria-label="Rotate selected text box"
            data-selection-rotate-handle="true"
            title="Rotate selected text box"
            onPointerDown={handleRotatePointerDown}
          >
            <RotateSelectionIcon />
            {rotateReadout ? (
              <RotateSelectionReadout degrees={rotateReadout.degrees} />
            ) : null}
          </button>
        ) : null}
        {editingText ? (
          <>
            <TextObjectContent object={object} editing />
            <textarea
              aria-label="Text object"
              autoFocus
              className="text-object-editor rich-text-object-editor"
              ref={textEditorRef}
              spellCheck={false}
              data-text-script={objectTextScript}
              style={textEditorCss}
              value={object.text}
              onChange={handleTextChange}
              onPaste={handleTextPaste}
              onFocus={(event) => {
                if (object.text === "Text") {
                  event.currentTarget.select();
                }
                recordTextEditorSelection(event.currentTarget);
              }}
              onKeyDown={handleTextKeyDown}
              onKeyUp={(event) => recordTextEditorSelection(event.currentTarget)}
              onSelect={(event) => recordTextEditorSelection(event.currentTarget)}
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => {
                event.stopPropagation();
                recordTextEditorSelection(event.currentTarget);
              }}
            />
          </>
        ) : null}
      </div>
    );
  }

  if (object.type === "reaction-arrow") {
    const width = Math.max(object.width, 1);
    const height = Math.max(object.height, 1);
    const start = arrowAnchorPointRelativeToObject(object, object.start, { x: 0, y: height / 2 });
    const end = arrowAnchorPointRelativeToObject(object, object.end, { x: width, y: height / 2 });
    // Same geometry plan as SVG export (layout-engine), projected per point for Spin 3D parity.
    const geometry = planReactionArrowGeometry(object.arrowKind, start, end);
    const project = (point: { x: number; y: number }) =>
      projectArtPoint(point, width, height, artObjectProjection?.matrix);
    return (
      <div
        className={["document-object", "document-object-overlay", "reaction-arrow-object"].join(" ")}
        style={style}
        data-object-id={object.id}
        data-layer-index={layerIndex}
        data-arrow-kind={object.arrowKind}
        aria-label={`${nativeReactionArrowAriaLabel(object.arrowKind)}`}
        onPointerDown={handleObjectPointerDown}
        onPointerMove={handleObjectPointerMove}
        onPointerUp={handleObjectPointerUp}
        onPointerCancel={handleObjectPointerCancel}
        onPointerLeave={handleObjectPointerLeave}
        onContextMenu={handleObjectContextMenu}
      >
        <svg
          className="reaction-arrow-glyph"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {geometry.lines.map((line, index) => {
            const lineStart = project(line.start);
            const lineEnd = project(line.end);
            return (
              <line
                key={`line-${index}`}
                className="reaction-arrow-line"
                x1={formatSvgNumber(lineStart.x)}
                y1={formatSvgNumber(lineStart.y)}
                x2={formatSvgNumber(lineEnd.x)}
                y2={formatSvgNumber(lineEnd.y)}
              />
            );
          })}
          {geometry.heads.map((head, index) => (
            <polygon
              key={`head-${index}`}
              className={head.filled ? "reaction-arrow-head" : "reaction-arrow-head reaction-arrow-head-open"}
              points={head.points
                .map((point) => {
                  const projected = project(point);
                  return `${formatSvgNumber(projected.x)},${formatSvgNumber(projected.y)}`;
                })
                .join(" ")}
            />
          ))}
        </svg>
        {artObjectTransformFrame}
      </div>
    );
  }

  if (object.type === "bracket") {
    return (
      <div
        className={["document-object", "document-object-overlay", "bracket-object"].join(" ")}
        style={style}
        data-object-id={object.id}
        data-layer-index={layerIndex}
        data-bracket-kind={object.bracketKind}
        data-contained-object-ids={object.containedObjectIds.join(",") || undefined}
        aria-label={`${object.bracketKind} bracket`}
        onPointerDown={handleObjectPointerDown}
        onPointerMove={handleObjectPointerMove}
        onPointerUp={handleObjectPointerUp}
        onPointerCancel={handleObjectPointerCancel}
        onPointerLeave={handleObjectPointerLeave}
        onContextMenu={handleObjectContextMenu}
      >
        <BracketGlyph object={object} projection={artObjectProjection} />
        {artObjectTransformFrame}
      </div>
    );
  }

  if (object.type === "graphic") {
    const artTransformProxy = objectTransformPreview?.artPreviewProxies?.[object.id];
    const graphicVisualRotationDegrees = graphicVisualCssRotationDegrees(
      object,
      objectTransformPreview
    );
    const graphicVisualStyle = graphicVisualCssStyle(graphicVisualRotationDegrees);
    const graphicPathEditHandles = pathGraphicInEditMode && !inGroupSelection ? (
      <GraphicPathEditHandles
        object={object}
        nodeEditPoints={graphicPathNodeEditPoints}
        selectedNodeIndex={selectedGraphicPathNodeIndex}
        segmentHitTargetsActive={graphicSegmentEraseActive}
        counterRotationDegrees={graphicVisualRotationDegrees}
        onMarkerPointerDown={handleGraphicMarkerPointerDown}
        onPointerDown={handleGraphicPathEditPointerDown}
      />
    ) : null;
    const graphicCornerRadiusHandle = showGraphicCornerRadiusHandle ? (
      <GraphicCornerRadiusHandle
        object={object}
        readout={graphicCornerRadiusReadout}
        counterRotationDegrees={graphicVisualRotationDegrees}
        onDoubleClick={handleGraphicCornerRadiusDoubleClick}
        onPointerDown={handleGraphicCornerRadiusPointerDown}
      />
    ) : null;
    const graphicGradientHandles = showGraphicGradientHandles ? (
      <>
        <GraphicLinearGradientHandles
          object={object}
          target={activeArtPaintTarget}
          onPointerDown={handleGraphicGradientPointerDown}
        />
        <GraphicRadialGradientHandles
          object={object}
          target={activeArtPaintTarget}
          onPointerDown={handleGraphicGradientPointerDown}
        />
      </>
    ) : null;
    const graphicEyedropperTargetOverlay = graphicEyedropperTargetActive ? (
      <GraphicEyedropperTargetOverlay
        target={activeArtPaintTarget}
        frameStyle={artObjectTransformFrameStyle}
        counterRotationDegrees={graphicVisualRotationDegrees}
      />
    ) : null;
    return (
      <div
        className={["document-object", "document-object-overlay", "graphic-object"].join(" ")}
        style={style}
        data-object-id={object.id}
        data-layer-index={layerIndex}
        data-graphic-kind={object.graphicKind}
        data-art-transform-preview={objectTransformPreview ? "true" : undefined}
        data-art-transform-preview-mode={objectTransformPreview?.mode}
        data-art-transform-preview-proxy={artTransformProxy?.kind}
        data-graphic-interaction-mode={(selected || graphicPathFeedbackActive) && !inGroupSelection
          ? pathGraphicInEditMode ? "path-edit"
            : showGraphicGradientHandles ? "gradient-edit"
              : showGraphicCornerRadiusHandle ? "corner-radius-edit"
                : showArtObjectTransformFrame ? "object-transform" : undefined
          : undefined}
        aria-label={`${object.graphicKind} graphic`}
        onPointerDown={handleObjectPointerDown}
        onPointerMove={handleObjectPointerMove}
        onPointerUp={handleObjectPointerUp}
        onPointerCancel={handleObjectPointerCancel}
        onPointerLeave={handleObjectPointerLeave}
        onContextMenu={handleObjectContextMenu}
      >
        <div
          className="graphic-visual-shell"
          data-art-z-rotation={graphicVisualStyle ? formatCssNumber(graphicVisualRotationDegrees) : undefined}
          style={graphicVisualStyle}
        >
          <div
            className="graphic-glyph-shell"
            data-art-vector-hidden={artTransformProxy ? "true" : undefined}
          >
            {artTransformProxy ? null : <GraphicGlyph object={object} />}
          </div>
          {artTransformProxy ? <ArtTransformDragPreviewProxy proxy={artTransformProxy} /> : null}
          {graphicCornerRadiusHandle}
          {graphicGradientHandles}
          {graphicPathEditHandles}
        </div>
        {graphicEyedropperTargetOverlay}
        {artObjectTransformFrame}
      </div>
    );
  }

  return (
    <div
      className={["document-object", "document-object-overlay", "generic-object", selected ? "selected" : ""].filter(Boolean).join(" ")}
      style={style}
      data-object-id={object.id}
      data-layer-index={layerIndex}
      onPointerDown={handleObjectPointerDown}
      onPointerMove={handleObjectPointerMove}
      onPointerUp={handleObjectPointerUp}
      onPointerCancel={handleObjectPointerCancel}
      onPointerLeave={handleObjectPointerLeave}
    >
      {artObjectTransformFrame}
    </div>
  );
}

function ArtTransformDragPreviewProxy({ proxy }: { proxy: ArtTransformDragPreviewProxy }) {
  const [rasterImageUrl, setRasterImageUrl] = useState<string | undefined>();

  useEffect(() => {
    setRasterImageUrl(undefined);
    if (proxy.kind !== "svg-image" || !proxy.imageUrl) {
      return;
    }

    let active = true;
    void rasterizeSvgPreviewImage(proxy).then((nextImageUrl) => {
      if (active && nextImageUrl) {
        setRasterImageUrl(nextImageUrl);
      }
    });

    return () => {
      active = false;
    };
  }, [proxy]);

  if (proxy.kind === "svg-image" && proxy.imageUrl) {
    const imageUrl = rasterImageUrl ?? proxy.imageUrl;
    return (
      <img
        alt=""
        aria-hidden="true"
        className="art-transform-drag-preview art-transform-drag-preview-image"
        data-art-transform-drag-preview="image"
        data-art-transform-drag-preview-source={rasterImageUrl ? "raster" : "svg"}
        decoding="async"
        draggable={false}
        src={imageUrl}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className="art-transform-drag-preview art-transform-drag-preview-bounds"
      data-art-transform-drag-preview="bounds"
    />
  );
}

function GraphicEyedropperTargetOverlay({
  target,
  frameStyle,
  counterRotationDegrees
}: {
  target: GraphicStylePaintTarget;
  frameStyle?: CSSProperties;
  counterRotationDegrees: number;
}) {
  const label = target === "fill" ? "Fill target" : "Stroke target";
  return (
    <div
      aria-hidden="true"
      className="graphic-eyedropper-target"
      data-graphic-eyedropper-target={target}
      style={frameStyle ?? { inset: 0 }}
    >
      <span className="graphic-eyedropper-target-badge" style={{
        transform: graphicSystemReadoutTransform(counterRotationDegrees, "eyedropper-target")
      }}>
        {label}
      </span>
    </div>
  );
}

async function rasterizeSvgPreviewImage(proxy: ArtTransformDragPreviewProxy): Promise<string | undefined> {
  if (proxy.kind !== "svg-image" || !proxy.imageUrl || typeof window === "undefined" || typeof document === "undefined") {
    return undefined;
  }

  const ImageConstructor = window.Image;
  if (!ImageConstructor) {
    return undefined;
  }

  return new Promise((resolve) => {
    const image = new ImageConstructor();
    image.decoding = "async";
    image.onload = () => {
      try {
        const size = artPreviewRasterPixelSize(proxy);
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(undefined);
          return;
        }

        context.clearRect(0, 0, size.width, size.height);
        context.drawImage(image, 0, 0, size.width, size.height);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(undefined);
      }
    };
    image.onerror = () => resolve(undefined);
    image.src = proxy.imageUrl!;
  });
}

function artPreviewRasterPixelSize(proxy: ArtTransformDragPreviewProxy): { width: number; height: number } {
  const deviceScale = typeof window !== "undefined" && Number.isFinite(window.devicePixelRatio)
    ? Math.max(1, window.devicePixelRatio)
    : 1;
  const scale = Math.max(0.25, proxy.rasterScale) * deviceScale;
  const rawWidth = Math.max(1, Math.ceil(proxy.width * scale));
  const rawHeight = Math.max(1, Math.ceil(proxy.height * scale));
  const largestSide = Math.max(rawWidth, rawHeight);
  if (largestSide <= ART_TRANSFORM_DRAG_PREVIEW_MAX_RASTER_PX) {
    return { width: rawWidth, height: rawHeight };
  }

  const reduction = ART_TRANSFORM_DRAG_PREVIEW_MAX_RASTER_PX / largestSide;
  return {
    width: Math.max(1, Math.ceil(rawWidth * reduction)),
    height: Math.max(1, Math.ceil(rawHeight * reduction))
  };
}

function ArtObjectTransformFrame({
  frameStyle,
  targetLabel,
  canProjectedPlaneTilt,
  rotationHandlesVisible,
  rotateReadout,
  projectedPlaneTiltReadout,
  rotationInput,
  resizeReadout,
  resizeInput,
  onRotatePointerDown,
  onRotateDoubleClick,
  onProjectedPlaneTiltPointerDown,
  onProjectedPlaneTiltDoubleClick,
  onRotationInputChange,
  onRotationInputKeep,
  onRotationInputHome,
  onRotationInputCancel,
  onResizePointerDown,
  onResizeDoubleClick,
  onResizeInputChange,
  onResizeInputKeep,
  onResizeInputHome,
  onResizeInputCancel
}: {
  frameStyle?: CSSProperties;
  targetLabel: string;
  canProjectedPlaneTilt: boolean;
  rotationHandlesVisible: boolean;
  rotateReadout?: ObjectRotateReadoutState;
  projectedPlaneTiltReadout?: ProjectedPlaneTiltReadoutState;
  rotationInput?: RotationInputState;
  resizeReadout?: ObjectResizeReadoutState;
  resizeInput?: ObjectResizeInputState;
  onRotatePointerDown(event: PointerEvent<HTMLButtonElement>): void;
  onRotateDoubleClick(event: ReactMouseEvent<HTMLButtonElement>): void;
  onProjectedPlaneTiltPointerDown(event: PointerEvent<HTMLButtonElement>): void;
  onProjectedPlaneTiltDoubleClick(event: ReactMouseEvent<HTMLButtonElement>): void;
  onRotationInputChange(nextInput: RotationInputState): void;
  onRotationInputKeep(input: RotationInputState): void;
  onRotationInputHome(input: RotationInputState): void;
  onRotationInputCancel(input: RotationInputState): void;
  onResizePointerDown(corner: ObjectResizeCorner): (event: PointerEvent<HTMLButtonElement>) => void;
  onResizeDoubleClick(corner: ObjectResizeCorner): (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onResizeInputChange(nextInput: ObjectResizeInputState): void;
  onResizeInputKeep(input: ObjectResizeInputState): void;
  onResizeInputHome(input: ObjectResizeInputState): void;
  onResizeInputCancel(input: ObjectResizeInputState): void;
}) {
  const zRotationHandleVisible = rotationHandlesVisible || rotateReadout !== undefined;
  const projectedPlaneTiltHandleVisible = rotationHandlesVisible || projectedPlaneTiltReadout !== undefined;
  return (
    <div
      className="object-transform-frame"
      data-art-transform-frame="true"
      data-has-tilt3d={canProjectedPlaneTilt ? "true" : undefined}
      style={frameStyle ?? { inset: 0 }}
    >
      <ObjectResizeHandles
        targetLabel={targetLabel}
        onResizeDoubleClick={onResizeDoubleClick}
        onResizeStart={onResizePointerDown}
      />
      {resizeReadout && !resizeInput ? (
        <ObjectResizeReadout
          scaleXPercent={resizeReadout.scaleXPercent}
          scaleYPercent={resizeReadout.scaleYPercent}
        />
      ) : null}
      {zRotationHandleVisible ? (
        <button
          type="button"
          className="object-rotate-handle"
          aria-label={`Rotate ${targetLabel}`}
          data-selection-rotate-handle="true"
          title={`Rotate ${targetLabel}`}
          onPointerDown={onRotatePointerDown}
          onDoubleClick={onRotateDoubleClick}
        >
          <RotateSelectionIcon />
          {rotateReadout ? (
            <RotateSelectionReadout degrees={rotateReadout.degrees} />
          ) : null}
        </button>
      ) : null}
      {canProjectedPlaneTilt && projectedPlaneTiltHandleVisible ? (
        <button
          type="button"
          className="object-tilt3d-handle"
          aria-label={`X/Y rotate ${targetLabel}`}
          data-selection-tilt3d-handle="true"
          title={`X/Y rotate ${targetLabel}`}
          onPointerDown={onProjectedPlaneTiltPointerDown}
          onDoubleClick={onProjectedPlaneTiltDoubleClick}
        >
          <ProjectedPlaneTiltIcon />
          {projectedPlaneTiltReadout ? (
            <ProjectedPlaneTiltReadout
              label={projectedPlaneTiltReadout.label}
              limited={projectedPlaneTiltReadout.limited}
            />
          ) : null}
        </button>
      ) : null}
      {rotationInput ? (
        <RotationInputPopover
          input={rotationInput}
          onKeep={onRotationInputKeep}
          onHome={onRotationInputHome}
          onCancel={onRotationInputCancel}
          onChange={onRotationInputChange}
        />
      ) : null}
      {resizeInput ? (
        <ObjectResizeInputPopover
          input={resizeInput}
          onKeep={onResizeInputKeep}
          onHome={onResizeInputHome}
          onCancel={onResizeInputCancel}
          onChange={onResizeInputChange}
        />
      ) : null}
    </div>
  );
}

function arrowAnchorPointRelativeToObject(
  object: ArrowObject,
  anchor: ArrowObject["start"] | ArrowObject["end"],
  fallback: { x: number; y: number }
): { x: number; y: number } {
  if (anchor.kind === "point" && anchor.point) {
    return {
      x: anchor.point.x - object.x,
      y: anchor.point.y - object.y
    };
  }

  return fallback;
}

function BracketGlyph({ object, projection }: { object: BracketObject; projection?: DocumentObjectProjection }) {
  const width = Math.max(object.width, 1);
  const height = Math.max(object.height, 1);
  // Shared generator with SVG export (layout-engine) so canvas and export cannot drift.
  const pathD = bracketGlyphPathD(object.bracketKind, width, height);
  return (
    <svg
      className="bracket-glyph"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        className="bracket-glyph-path"
        d={pathD}
        transform={projection?.matrix ? artProjectionSvgTransform(width, height, projection.matrix) : undefined}
      />
    </svg>
  );
}

function reactSvgPaintAttrs(
  attribute: "fill" | "stroke",
  paint: NativeArtPaintPlan,
  id: string
): Record<string, string | number | undefined> {
  const value = reactSvgPaintValue(paint, id);
  if (paint.kind === "solid") {
    return {
      [attribute]: value,
      [`${attribute}Opacity`]: paint.opacity === 1 ? undefined : paint.opacity
    };
  }
  return { [attribute]: value };
}

function reactSvgPaintValue(paint: NativeArtPaintPlan, id: string): string {
  if (paint.kind === "none") {
    return "none";
  }
  if (paint.kind === "solid") {
    return paint.color;
  }
  return `url(#${id})`;
}

function reactSvgPaintDefinitions(paint: NativeArtPaintPlan, id: string) {
  if (paint.kind === "linear-gradient") {
    return (
      <defs key={`${id}-defs`}>
        <linearGradient
          id={id}
          x1={paint.x1}
          y1={paint.y1}
          x2={paint.x2}
          y2={paint.y2}
          gradientTransform={paint.gradientTransform}
          gradientUnits="userSpaceOnUse"
        >
          {paint.stops.map((stop, index) => (
            <stop
              key={`${id}-stop-${index}`}
              offset={`${Number((stop.offset * 100).toFixed(4))}%`}
              stopColor={stop.color}
              stopOpacity={stop.opacity === 1 ? undefined : stop.opacity}
            />
          ))}
        </linearGradient>
      </defs>
    );
  }

  if (paint.kind === "radial-gradient") {
    return (
      <defs key={`${id}-defs`}>
        <radialGradient
          id={id}
          cx={paint.cx}
          cy={paint.cy}
          r={paint.r}
          fx={paint.fx}
          fy={paint.fy}
          gradientTransform={paint.gradientTransform}
          gradientUnits="userSpaceOnUse"
        >
          {paint.stops.map((stop, index) => (
            <stop
              key={`${id}-stop-${index}`}
              offset={`${Number((stop.offset * 100).toFixed(4))}%`}
              stopColor={stop.color}
              stopOpacity={stop.opacity === 1 ? undefined : stop.opacity}
            />
          ))}
        </radialGradient>
      </defs>
    );
  }

  return null;
}

function reactSvgFlattenedMarker(
  marker: NonNullable<NativeArtVisualPlan["markerEnd"]>,
  terminal: NonNullable<NativeArtVisualPlan["markerEndTerminal"]>,
  id: string,
  placement: "start" | "end",
  color: string,
  opacity: number
) {
  const size = Math.max(2, marker.sizePx);
  const half = size / 2;
  const direction = marker.angleDegrees === 0
    ? markerTerminalDirection(terminal)
    : { x: Math.cos(marker.angleDegrees * Math.PI / 180), y: Math.sin(marker.angleDegrees * Math.PI / 180) };
  const normal = { x: -direction.y, y: direction.x };
  const tip = terminal.point;
  const markerPoint = (back: number, offset: number) => ({
    x: tip.x - direction.x * back + normal.x * offset,
    y: tip.y - direction.y * back + normal.y * offset
  });
  const markerPath = (points: ReadonlyArray<{ x: number; y: number }>, closed = true) => [
    `M ${points[0]?.x ?? tip.x} ${points[0]?.y ?? tip.y}`,
    ...points.slice(1).map((point) => `L ${point.x} ${point.y}`),
    closed ? "Z" : ""
  ].filter(Boolean).join(" ");
  const sharedStroke = {
    stroke: color,
    strokeOpacity: opacity === 1 ? undefined : opacity,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };
  const sharedProps = {
    id,
    "data-graphic-marker": placement
  };

  if (marker.kind === "filled-arrow") {
    return <path key={id} {...sharedProps} d={markerPath([tip, markerPoint(size, -half), markerPoint(size, half)])} fill={color} fillOpacity={opacity === 1 ? undefined : opacity} stroke="none" />;
  }
  if (marker.kind === "open-arrow") {
    return <path key={id} {...sharedProps} d={[
      `M ${tip.x} ${tip.y}`,
      `L ${markerPoint(size, -half).x} ${markerPoint(size, -half).y}`,
      `M ${tip.x} ${tip.y}`,
      `L ${markerPoint(size, half).x} ${markerPoint(size, half).y}`
    ].join(" ")} fill="none" strokeWidth={Math.max(1.4, size * 0.16)} {...sharedStroke} />;
  }
  if (marker.kind === "chevron") {
    return <path key={id} {...sharedProps} d={markerPath([
      tip,
      markerPoint(size * 0.82, -half),
      markerPoint(size * 0.52, 0),
      markerPoint(size * 0.82, half)
    ])} fill={color} fillOpacity={opacity === 1 ? undefined : opacity} stroke="none" />;
  }
  if (marker.kind === "diamond") {
    return <path key={id} {...sharedProps} d={markerPath([
      tip,
      markerPoint(size * 0.5, -half),
      markerPoint(size, 0),
      markerPoint(size * 0.5, half)
    ])} fill={color} fillOpacity={opacity === 1 ? undefined : opacity} stroke="none" />;
  }
  if (marker.kind === "dot") {
    const center = markerPoint(half, 0);
    return <circle key={id} {...sharedProps} cx={center.x} cy={center.y} r={Math.max(1, size * 0.38)} fill={color} fillOpacity={opacity === 1 ? undefined : opacity} />;
  }

  const barStart = markerPoint(0, -half);
  const barEnd = markerPoint(0, half);
  return <path key={id} {...sharedProps} d={`M ${barStart.x} ${barStart.y} L ${barEnd.x} ${barEnd.y}`} fill="none" strokeWidth={Math.max(1.4, size * 0.16)} {...sharedStroke} />;
}

function markerTerminalDirection(terminal: NonNullable<NativeArtVisualPlan["markerEndTerminal"]>) {
  const length = Math.hypot(terminal.direction.x, terminal.direction.y);
  return Number.isFinite(length) && length > 0.001
    ? { x: terminal.direction.x / length, y: terminal.direction.y / length }
    : { x: 1, y: 0 };
}

function reactSvgEffectDefinitions(plan: NativeArtVisualPlan, id: string) {
  const effects = plan.effects.filter((effect): effect is Extract<NativeArtVisualPlan["effects"][number], { kind: "shadow" | "glow" }> =>
    effect.kind === "shadow" || effect.kind === "glow"
  );
  if (effects.length === 0) {
    return null;
  }

  const filterChildren: ReturnType<typeof createElement>[] = [];
  const mergeInputs: string[] = [];
  effects.forEach((effect) => {
    if (effect.kind === "shadow") {
      const blurResult = `${id}-shadow-blur`;
      const offsetResult = `${id}-shadow-offset`;
      const floodResult = `${id}-shadow-color`;
      const result = `${id}-shadow`;
      filterChildren.push(
        <feGaussianBlur key={blurResult} in="SourceAlpha" stdDeviation={effect.blurPx} result={blurResult} />,
        <feOffset
          key={offsetResult}
          in={blurResult}
          dx={effect.offsetX}
          dy={effect.offsetY}
          result={offsetResult}
        />,
        <feFlood key={floodResult} floodColor={effect.color} floodOpacity={effect.opacity} result={floodResult} />,
        <feComposite key={result} in={floodResult} in2={offsetResult} operator="in" result={result} />
      );
      mergeInputs.push(result);
      return;
    }

    const spreadResult = `${id}-glow-spread`;
    const blurInput = effect.spreadPx > 0 ? spreadResult : "SourceAlpha";
    const blurResult = `${id}-glow-blur`;
    const floodResult = `${id}-glow-color`;
    const compositeResult = `${id}-glow`;
    if (effect.spreadPx > 0) {
      filterChildren.push(
        <feMorphology
          key={spreadResult}
          in="SourceAlpha"
          operator="dilate"
          radius={effect.spreadPx}
          result={spreadResult}
        />
      );
    }
    filterChildren.push(
      <feGaussianBlur key={blurResult} in={blurInput} stdDeviation={effect.blurPx} result={blurResult} />,
      <feFlood key={floodResult} floodColor={effect.color} floodOpacity={effect.opacity} result={floodResult} />,
      <feComposite key={compositeResult} in={floodResult} in2={blurResult} operator="in" result={compositeResult} />
    );
    mergeInputs.push(compositeResult);
  });
  const region = svgEffectFilterRegionForPlan(plan);

  return (
    <defs>
      <filter
        id={id}
        filterUnits="userSpaceOnUse"
        x={region.x}
        y={region.y}
        width={region.width}
        height={region.height}
        colorInterpolationFilters="sRGB"
      >
        {filterChildren}
        <feMerge>
          {mergeInputs.map((input, index) => <feMergeNode key={`${id}-merge-${index}`} in={input} />)}
        </feMerge>
      </filter>
    </defs>
  );
}

function reactSvgEffectSourceProps(plan: NativeArtVisualPlan, effectFilterId: string, includeFill: boolean) {
  const hasFilter = plan.effects.some((candidate) => candidate.kind === "shadow" || candidate.kind === "glow");
  if (!hasFilter) {
    return undefined;
  }

  const sourceFill = includeFill && plan.fill.paint.kind !== "none" ? "#000000" : "none";
  const sourceStroke = plan.capabilities.supportsStroke && plan.stroke.paint.kind !== "none" ? "#000000" : "none";
  return {
    className: "graphic-glyph-effect-source",
    "data-graphic-effect-source": "true",
    fill: sourceFill,
    stroke: sourceStroke,
    strokeWidth: plan.stroke.width,
    strokeDasharray: plan.stroke.dasharray,
    strokeLinecap: plan.stroke.lineCap,
    strokeLinejoin: plan.stroke.lineJoin,
    strokeMiterlimit: plan.stroke.miterLimit,
    vectorEffect: "non-scaling-stroke" as const,
    pointerEvents: "none" as const,
    filter: `url(#${effectFilterId})`
  };
}

function reactSvgSketchEffectPaths(plan: NativeArtVisualPlan, objectId: string) {
  const sketch = plan.effects.find((effect) => effect.kind === "sketch");
  if (!sketch) {
    return null;
  }

  return sketch.paths.map((path, index) => (
    <path
      key={`graphic-sketch-${objectId}-${index}`}
      className="graphic-glyph-sketch"
      d={path.d}
      fill={path.fill ?? "none"}
      stroke={path.stroke}
      strokeWidth={path.strokeWidth}
      strokeOpacity={sketch.opacity === 1 ? undefined : sketch.opacity}
      strokeLinecap="round"
      strokeLinejoin="round"
      pointerEvents="none"
    />
  ));
}

function reactSvgSketchEffectSourcePaths(plan: NativeArtVisualPlan, objectId: string, effectFilterId: string) {
  const hasFilter = plan.effects.some((effect) => effect.kind === "shadow" || effect.kind === "glow");
  const sketch = plan.effects.find((effect) => effect.kind === "sketch");
  if (!hasFilter || !sketch) {
    return null;
  }

  return sketch.paths.map((path, index) => (
    <path
      key={`graphic-sketch-effect-source-${objectId}-${index}`}
      className="graphic-glyph-effect-source"
      data-graphic-effect-source="true"
      d={path.d}
      fill={path.fill && path.fill !== "none" ? "#000000" : "none"}
      stroke="#000000"
      strokeWidth={path.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      filter={`url(#${effectFilterId})`}
      pointerEvents="none"
    />
  ));
}

function GraphicGlyph({ object }: { object: GraphicObject }) {
  const plan = markFrame("render art object", () => planNativeArtVisual(object, { coordinateSpace: "local" }));
  const freehandPath = graphicObjectIsFreehandPath(object);
  const width = plan.width;
  const height = plan.height;
  const line = plan.line;
  const visibleLine = plan.visibleLine ?? plan.line;
  const strokeColor = plan.stroke.color;
  const strokeWidth = plan.stroke.width;
  const strokeDasharray = plan.stroke.dasharray;
  const cornerRadius = plan.cornerRadius;
  const fillMode = plan.fill.mode;
  const gradientId = `graphic-gloss-${object.id}`;
  const effectFilterId = `graphic-effects-${object.id}`;
  const fillPaintId = `graphic-fill-${object.id}`;
  const strokePaintId = `graphic-stroke-${object.id}`;
  const markerStartId = `graphic-marker-start-${object.id}`;
  const markerEndId = `graphic-marker-end-${object.id}`;
  const pathD = plan.pathD;
  const visiblePathD = plan.visiblePathD ?? pathD;
  const projectionTransform = plan.projectionTransform;
  const glossGradient = plan.glossGradient;
  const hitStrokeWidth = Math.max(strokeWidth + 10, 14);
  const closedFillHitTarget = plan.capabilities.supportsFill && !plan.capabilities.isOpenStroke;
  const pathFillHitTarget = freehandPath || closedFillHitTarget || !plan.capabilities.supportsStroke;
  const hasSketchEffect = plan.effects.some((effect) => effect.kind === "sketch");
  const sketchPaths = reactSvgSketchEffectPaths(plan, object.id);
  const sketchEffectSourcePaths = reactSvgSketchEffectSourcePaths(plan, object.id, effectFilterId);
  const shapeEffectSourceProps = hasSketchEffect ? undefined : reactSvgEffectSourceProps(plan, effectFilterId, closedFillHitTarget);
  const strokeEffectSourceProps = hasSketchEffect ? undefined : reactSvgEffectSourceProps(plan, effectFilterId, false);
  const pathEffectSourceProps = hasSketchEffect ? undefined : reactSvgEffectSourceProps(plan, effectFilterId, pathFillHitTarget);
  const fillPaintProps = fillMode === "gloss"
    ? { fill: `url(#${gradientId})`, fillOpacity: plan.fill.opacity === 1 ? undefined : plan.fill.opacity }
    : reactSvgPaintAttrs("fill", plan.fill.paint, fillPaintId);
  const sharedStrokeProps = {
    ...reactSvgPaintAttrs("stroke", plan.stroke.paint, strokePaintId),
    strokeWidth,
    strokeDasharray,
    strokeLinecap: plan.stroke.lineCap,
    strokeLinejoin: plan.stroke.lineJoin,
    strokeMiterlimit: plan.stroke.miterLimit,
    vectorEffect: "non-scaling-stroke" as const
  };
  const cleanStrokeProps = hasSketchEffect
    ? { ...sharedStrokeProps, stroke: "none" }
    : sharedStrokeProps;
  const markerStart = plan.markerStart && plan.markerStartTerminal
    ? reactSvgFlattenedMarker(plan.markerStart, plan.markerStartTerminal, markerStartId, "start", strokeColor, plan.stroke.opacity)
    : null;
  const markerEnd = plan.markerEnd && plan.markerEndTerminal
    ? reactSvgFlattenedMarker(plan.markerEnd, plan.markerEndTerminal, markerEndId, "end", strokeColor, plan.stroke.opacity)
    : null;
  return (
    <svg
      className="graphic-glyph"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      opacity={plan.opacity === 1 ? undefined : plan.opacity}
      aria-hidden="true"
    >
      {reactSvgPaintDefinitions(plan.fill.paint, fillPaintId)}
      {reactSvgPaintDefinitions(plan.stroke.paint, strokePaintId)}
      {reactSvgEffectDefinitions(plan, effectFilterId)}
      {fillMode === "gloss" ? (
        <defs>
          <radialGradient
            id={gradientId}
            cx={glossGradient?.cx}
            cy={glossGradient?.cy}
            r={glossGradient?.r}
            gradientTransform={glossGradient?.gradientTransform}
            gradientUnits="userSpaceOnUse"
          >
            {glossGradient?.stops.map((stop, index) => (
              <stop
                key={`gloss-stop-${index}`}
                offset={`${Number((stop.offset * 100).toFixed(4))}%`}
                stopColor={stop.color}
                stopOpacity={stop.opacity === 1 ? undefined : stop.opacity}
              />
            ))}
          </radialGradient>
        </defs>
      ) : null}
      {plan.projectedShapePathD ? (
        <>
          {closedFillHitTarget ? (
            <path
              className="graphic-glyph-hit-target"
              data-graphic-hit-fill="true"
              d={plan.projectedShapePathD}
              fill="transparent"
              stroke="transparent"
              strokeWidth={hitStrokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents="all"
            />
          ) : null}
          {shapeEffectSourceProps ? (
            <path
              d={plan.projectedShapePathD}
              {...shapeEffectSourceProps}
            />
          ) : null}
          {sketchEffectSourcePaths}
          <path
            className="graphic-glyph-stroke graphic-glyph-projected-shape"
            d={plan.projectedShapePathD}
            {...fillPaintProps}
            {...cleanStrokeProps}
          />
          {sketchPaths}
        </>
      ) : (
        <g className={projectionTransform ? "graphic-glyph-transform" : undefined} transform={projectionTransform}>
          {object.graphicKind === "ellipse" ? (
            <>
              <ellipse
                className="graphic-glyph-hit-target"
                data-graphic-hit-fill="true"
                cx={width / 2}
                cy={height / 2}
                rx={Math.max(width / 2 - strokeWidth / 2, 0.5)}
                ry={Math.max(height / 2 - strokeWidth / 2, 0.5)}
                fill="transparent"
                stroke="transparent"
                strokeWidth={hitStrokeWidth}
                vectorEffect="non-scaling-stroke"
                pointerEvents="all"
              />
              {shapeEffectSourceProps ? (
                <ellipse
                  cx={width / 2}
                  cy={height / 2}
                  rx={Math.max(width / 2 - strokeWidth / 2, 0.5)}
                  ry={Math.max(height / 2 - strokeWidth / 2, 0.5)}
                  {...shapeEffectSourceProps}
                />
              ) : null}
              {sketchEffectSourcePaths}
              <ellipse
                className="graphic-glyph-stroke graphic-glyph-shape"
                cx={width / 2}
                cy={height / 2}
                rx={Math.max(width / 2 - strokeWidth / 2, 0.5)}
                ry={Math.max(height / 2 - strokeWidth / 2, 0.5)}
                {...fillPaintProps}
                {...cleanStrokeProps}
              />
              {sketchPaths}
            </>
          ) : object.graphicKind === "rect" ? (
            <>
              <rect
                className="graphic-glyph-hit-target"
                data-graphic-hit-fill="true"
                x={strokeWidth / 2}
                y={strokeWidth / 2}
                width={Math.max(width - strokeWidth, 0.5)}
                height={Math.max(height - strokeWidth, 0.5)}
                rx={cornerRadius}
                ry={cornerRadius}
                fill="transparent"
                stroke="transparent"
                strokeWidth={hitStrokeWidth}
                vectorEffect="non-scaling-stroke"
                pointerEvents="all"
              />
              {shapeEffectSourceProps ? (
                <rect
                  x={strokeWidth / 2}
                  y={strokeWidth / 2}
                  width={Math.max(width - strokeWidth, 0.5)}
                  height={Math.max(height - strokeWidth, 0.5)}
                  rx={cornerRadius}
                  ry={cornerRadius}
                  {...shapeEffectSourceProps}
                />
              ) : null}
              {sketchEffectSourcePaths}
              <rect
                className="graphic-glyph-stroke graphic-glyph-shape"
                x={strokeWidth / 2}
                y={strokeWidth / 2}
                width={Math.max(width - strokeWidth, 0.5)}
                height={Math.max(height - strokeWidth, 0.5)}
                rx={cornerRadius}
                ry={cornerRadius}
                {...fillPaintProps}
                {...cleanStrokeProps}
              />
              {sketchPaths}
            </>
          ) : object.graphicKind === "path" && pathD ? (
          <>
            <path
              className="graphic-glyph-hit-target"
              data-graphic-hit-fill={pathFillHitTarget ? "true" : undefined}
              d={pathD}
              fill={pathFillHitTarget ? "transparent" : "none"}
              stroke="transparent"
              strokeWidth={hitStrokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents={pathFillHitTarget ? "all" : "stroke"}
            />
            {pathEffectSourceProps ? (
              <path
                d={visiblePathD}
                {...pathEffectSourceProps}
              />
            ) : null}
            {sketchEffectSourcePaths}
            <path
              className="graphic-glyph-stroke graphic-glyph-path"
              d={visiblePathD}
              {...(freehandPath || plan.capabilities.supportsFill ? fillPaintProps : { fill: "none" })}
              {...cleanStrokeProps}
            />
            {sketchPaths}
            {markerStart}
            {markerEnd}
          </>
        ) : line && visibleLine ? (
          <>
            <line
              className="graphic-glyph-hit-target"
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke="transparent"
              strokeWidth={hitStrokeWidth}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents="stroke"
            />
            {strokeEffectSourceProps ? (
              <line
                x1={visibleLine.x1}
                y1={visibleLine.y1}
                x2={visibleLine.x2}
                y2={visibleLine.y2}
                {...strokeEffectSourceProps}
              />
            ) : null}
            {sketchEffectSourcePaths}
            <line
              className="graphic-glyph-stroke"
              x1={visibleLine.x1}
              y1={visibleLine.y1}
              x2={visibleLine.x2}
              y2={visibleLine.y2}
              {...cleanStrokeProps}
            />
            {sketchPaths}
            {markerStart}
            {markerEnd}
          </>
        ) : (
          <line className="graphic-glyph-stroke" x1="0" y1="0" x2={width} y2={height} {...sharedStrokeProps} />
        )}
        </g>
      )}
    </svg>
  );
}

function graphicObjectIsFreehandPath(object: GraphicObject): boolean {
  return object.graphicKind === "path" && object.data.artPathKind === "freehand";
}

function graphicObjectHasDirectEditChrome(object: GraphicObject, target: GraphicStylePaintTarget): boolean {
  return nativeGraphicPathEditPoints(object) !== undefined ||
    nativeGraphicPathNodeEditPoints(object) !== undefined ||
    nativeGraphicCornerRadiusEditPoint(object) !== undefined ||
    nativeGraphicLinearGradientHandlePoints(object, target) !== undefined ||
    nativeGraphicRadialGradientHandlePoints(object, target) !== undefined;
}

function isLinearGradientHandleId(handle: NativeGraphicGradientHandleId): handle is NativeGraphicLinearGradientHandleId {
  return handle === "start" || handle === "end";
}

function graphicGradientHandleStatusName(
  target: GraphicStylePaintTarget,
  handle: NativeGraphicGradientHandleId
): string {
  if (isLinearGradientHandleId(handle)) {
    return `${target} linear gradient ${handle}`;
  }
  return `${target} radial gradient ${handle}`;
}

function GraphicCornerRadiusHandle({
  object,
  readout,
  counterRotationDegrees,
  onPointerDown,
  onDoubleClick
}: {
  object: GraphicObject;
  readout?: GraphicCornerRadiusReadoutState;
  counterRotationDegrees: number;
  onPointerDown(event: PointerEvent<HTMLButtonElement>): void;
  onDoubleClick(event: ReactMouseEvent<HTMLButtonElement>): void;
}) {
  const point = nativeGraphicCornerRadiusEditPoint(object);
  if (!point) {
    return null;
  }

  const radius = readout?.radius ?? graphicCornerRadiusReadoutValue(object);
  const projectedPoint = projectGraphicObjectPoint(object, point, { coordinateSpace: "local" });
  const label = `Radius: ${Math.round(radius)} px`;

  return (
    <>
      <button
        type="button"
        className="graphic-corner-radius-handle"
        aria-label="Adjust corner radius"
        data-graphic-corner-radius-handle="true"
        data-graphic-corner-radius-value={String(Math.round(radius))}
        style={{
          left: pageScaledCssPx(projectedPoint.x),
          top: pageScaledCssPx(projectedPoint.y)
        }}
        title="Adjust corner radius"
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
      />
      <div
        className="graphic-corner-radius-readout"
        data-graphic-corner-radius-readout="true"
        style={{
          left: pageScaledCssPx(projectedPoint.x),
          top: pageScaledCssPx(projectedPoint.y),
          transform: graphicSystemReadoutTransform(counterRotationDegrees, "corner-radius")
        }}
      >
        {label}
      </div>
    </>
  );
}

type GraphicGradientHandleObject = GraphicObject | MoleculeObject;

function projectGraphicGradientHandlePoint(
  object: GraphicGradientHandleObject,
  point: NativeArtPoint,
  options: { coordinateSpace?: "local" | "page" } = {}
): NativeArtPoint {
  if (object.type === "graphic") {
    return projectGraphicObjectPoint(object, point, options);
  }

  return options.coordinateSpace === "page"
    ? { x: point.x - object.x, y: point.y - object.y }
    : point;
}

function GraphicLinearGradientHandles({
  object,
  target,
  onPointerDown
}: {
  object: GraphicGradientHandleObject;
  target: GraphicStylePaintTarget;
  onPointerDown(target: GraphicStylePaintTarget, handle: NativeGraphicGradientHandleId): (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const points = nativeGraphicLinearGradientHandlePoints(object, target);
  if (!points) {
    return null;
  }

  const start = projectGraphicGradientHandlePoint(object, points.start, { coordinateSpace: "local" });
  const end = projectGraphicGradientHandlePoint(object, points.end, { coordinateSpace: "local" });
  const width = Math.max(object.width, 1);
  const height = Math.max(object.height, 1);
  const handles: Array<{ id: NativeGraphicLinearGradientHandleId; point: NativeArtPoint; label: string }> = [
    { id: "start", point: start, label: `Move ${target} linear gradient start` },
    { id: "end", point: end, label: `Move ${target} linear gradient end` }
  ];

  return (
    <>
      <svg
        className="graphic-gradient-control-layer"
        viewBox={`0 0 ${formatSvgNumber(width)} ${formatSvgNumber(height)}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
        data-graphic-gradient-control-layer={target}
      >
        <line
          className="graphic-gradient-control-line"
          data-graphic-gradient-control-line={target}
          x1={formatSvgNumber(start.x)}
          y1={formatSvgNumber(start.y)}
          x2={formatSvgNumber(end.x)}
          y2={formatSvgNumber(end.y)}
        />
      </svg>
      {handles.map(({ id, point, label }) => (
        <button
          type="button"
          className={[
            "graphic-gradient-handle",
            `graphic-gradient-handle-${id}`
          ].join(" ")}
          aria-label={label}
          data-graphic-gradient-handle={id}
          data-graphic-gradient-target={target}
          key={id}
          style={{
            left: pageScaledCssPx(point.x),
            top: pageScaledCssPx(point.y)
          }}
          title={label}
          onPointerDown={onPointerDown(target, id)}
        />
      ))}
    </>
  );
}

function GraphicRadialGradientHandles({
  object,
  target,
  onPointerDown
}: {
  object: GraphicGradientHandleObject;
  target: GraphicStylePaintTarget;
  onPointerDown(target: GraphicStylePaintTarget, handle: NativeGraphicGradientHandleId): (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const points = nativeGraphicRadialGradientHandlePoints(object, target);
  if (!points) {
    return null;
  }

  const center = projectGraphicGradientHandlePoint(object, points.center, { coordinateSpace: "local" });
  const radius = projectGraphicGradientHandlePoint(object, points.radius, { coordinateSpace: "local" });
  const focus = points.focus
    ? projectGraphicGradientHandlePoint(object, points.focus, { coordinateSpace: "local" })
    : undefined;
  const width = Math.max(object.width, 1);
  const height = Math.max(object.height, 1);
  const projectedRadius = Math.max(0, Math.hypot(radius.x - center.x, radius.y - center.y));
  const handles: Array<{ id: NativeGraphicRadialGradientHandleId; point: NativeArtPoint; label: string }> = [
    { id: "center", point: center, label: `Move ${target} radial gradient center` },
    { id: "radius", point: radius, label: `Resize ${target} radial gradient radius` },
    ...(focus ? [{ id: "focus" as const, point: focus, label: `Move ${target} radial gradient focus` }] : [])
  ];

  return (
    <>
      <svg
        className="graphic-gradient-control-layer"
        viewBox={`0 0 ${formatSvgNumber(width)} ${formatSvgNumber(height)}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
        data-graphic-gradient-control-layer={target}
      >
        <circle
          className="graphic-gradient-radius-ring"
          data-graphic-gradient-radius-ring={target}
          cx={formatSvgNumber(center.x)}
          cy={formatSvgNumber(center.y)}
          r={formatSvgNumber(projectedRadius)}
        />
        <line
          className="graphic-gradient-control-line graphic-gradient-radius-line"
          data-graphic-gradient-radius-line={target}
          x1={formatSvgNumber(center.x)}
          y1={formatSvgNumber(center.y)}
          x2={formatSvgNumber(radius.x)}
          y2={formatSvgNumber(radius.y)}
        />
        {focus ? (
          <line
            className="graphic-gradient-control-line graphic-gradient-focus-line"
            data-graphic-gradient-focus-line={target}
            x1={formatSvgNumber(center.x)}
            y1={formatSvgNumber(center.y)}
            x2={formatSvgNumber(focus.x)}
            y2={formatSvgNumber(focus.y)}
          />
        ) : null}
      </svg>
      {handles.map(({ id, point, label }) => (
        <button
          type="button"
          className={[
            "graphic-gradient-handle",
            `graphic-gradient-handle-${id}`
          ].join(" ")}
          aria-label={label}
          data-graphic-gradient-handle={id}
          data-graphic-gradient-target={target}
          key={id}
          style={{
            left: pageScaledCssPx(point.x),
            top: pageScaledCssPx(point.y)
          }}
          title={label}
          onPointerDown={onPointerDown(target, id)}
        />
      ))}
    </>
  );
}

function GraphicPathEditHandles({
  object,
  nodeEditPoints,
  selectedNodeIndex,
  segmentHitTargetsActive,
  counterRotationDegrees,
  onMarkerPointerDown,
  onPointerDown
}: {
  object: GraphicObject;
  nodeEditPoints?: NativeGraphicPathNodeEditPoints;
  selectedNodeIndex?: number;
  segmentHitTargetsActive: boolean;
  counterRotationDegrees: number;
  onMarkerPointerDown(markerId: NativeGraphicMarkerHandleId): (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerDown(handle: NativeGraphicPathEditHandle): (event: PointerEvent<Element>) => void;
}) {
  const points = nativeGraphicPathEditPoints(object);
  if (!points && !nodeEditPoints) {
    return null;
  }

  const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
  const markerHandles = plan.markerHandles.map((handle) => ({
    ...handle,
    point: projectGraphicObjectPoint(object, handle.point, { coordinateSpace: "local" })
  }));
  if (nodeEditPoints) {
    const bezierControlHandles = nodeEditPoints.pathKind === "bezier" && selectedNodeIndex !== undefined
      ? bezierControlHandlePlans(nodeEditPoints, selectedNodeIndex)
      : [];
    const segmentHitPlans = segmentHitTargetsActive
      ? graphicPathSegmentHitPlans(object, nodeEditPoints)
      : [];
    const controlLayerWidth = Math.max(object.width, 1);
    const controlLayerHeight = Math.max(object.height, 1);
    return (
      <>
        {segmentHitPlans.length > 0 ? (
          <svg
            className="graphic-path-segment-hit-layer"
            viewBox={`0 0 ${formatSvgNumber(controlLayerWidth)} ${formatSvgNumber(controlLayerHeight)}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {segmentHitPlans.map((segment) => (
              <path
                className="graphic-path-segment-hit-target"
                data-graphic-path-handle={segment.handle}
                data-graphic-path-segment-index={segment.index}
                d={segment.d}
                key={segment.handle}
                onPointerDown={onPointerDown(segment.handle)}
              />
            ))}
          </svg>
        ) : null}
        {bezierControlHandles.length > 0 ? (
          <svg
            className="graphic-bezier-control-layer"
            viewBox={`0 0 ${formatSvgNumber(controlLayerWidth)} ${formatSvgNumber(controlLayerHeight)}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {bezierControlHandles.map((control) => {
              const anchor = projectGraphicObjectPoint(object, control.anchor);
              const point = projectGraphicObjectPoint(object, control.point);
              return (
                <line
                  className="graphic-bezier-control-line"
                  data-graphic-path-control-line={control.handle}
                  key={`${control.handle}:line`}
                  x1={formatSvgNumber(anchor.x - object.x)}
                  y1={formatSvgNumber(anchor.y - object.y)}
                  x2={formatSvgNumber(point.x - object.x)}
                  y2={formatSvgNumber(point.y - object.y)}
                />
              );
            })}
          </svg>
        ) : null}
        {bezierControlHandles.map((control) => {
          const point = projectGraphicObjectPoint(object, control.point);
          const label = `${control.kind === "in" ? "Adjust incoming" : "Adjust outgoing"} Bezier handle ${control.index + 1}`;
          return (
            <button
              type="button"
              className="graphic-path-edit-handle graphic-bezier-control-handle"
              aria-label={label}
              data-graphic-path-control={control.kind}
              data-graphic-path-control-index={control.index}
              data-graphic-path-handle={control.handle}
              key={control.handle}
              style={{
                left: pageScaledCssPx(point.x - object.x),
                top: pageScaledCssPx(point.y - object.y)
              }}
              title={label}
              onPointerDown={onPointerDown(control.handle)}
            />
          );
        })}
        {nodeEditPoints.nodes.map((node) => {
          const point = projectGraphicObjectPoint(object, node.point);
          const handle = `node:${node.index}` as const;
          const selected = node.index === selectedNodeIndex;
          const label = `Move path node ${node.index + 1}`;
          return (
            <button
              type="button"
              className={[
                "graphic-path-edit-handle",
                "graphic-path-edit-handle-node",
                selected ? "graphic-path-edit-handle-node-selected" : undefined
              ].filter(Boolean).join(" ")}
              aria-label={label}
              data-graphic-path-handle={handle}
              data-graphic-path-node-index={node.index}
              data-graphic-path-node-selected={selected ? "true" : undefined}
              key={handle}
              style={{
                left: pageScaledCssPx(point.x - object.x),
                top: pageScaledCssPx(point.y - object.y)
              }}
              title={label}
              onPointerDown={onPointerDown(handle)}
            />
          );
        })}
        {markerHandles.map((handle) => (
          <button
            type="button"
            className={[
              "graphic-path-edit-handle",
              "graphic-marker-edit-handle",
              `graphic-marker-edit-handle-${handle.id === "markerStart" ? "start" : "end"}`
            ].join(" ")}
            aria-label={handle.id === "markerStart" ? "Adjust start arrowhead size" : "Adjust end arrowhead size"}
            data-graphic-marker-handle={handle.id}
            data-graphic-marker-size={String(Math.round(handle.marker.sizePx))}
            key={handle.id}
            style={{
              left: pageScaledCssPx(handle.point.x),
              top: pageScaledCssPx(handle.point.y)
            }}
            title={handle.id === "markerStart" ? "Adjust start arrowhead size" : "Adjust end arrowhead size"}
            onPointerDown={onMarkerPointerDown(handle.id)}
          />
        ))}
      </>
    );
  }

  if (!points) {
    return null;
  }

  const circularArc = isSemanticCircularGraphicArc(object, points);
  const projectedPoints = {
    start: projectGraphicObjectPoint(object, points.start),
    middle: projectGraphicObjectPoint(object, points.middle),
    end: projectGraphicObjectPoint(object, points.end)
  };
  const arcRadianReadout = circularArc ? graphicArcSweepRadiansLabel(object) : undefined;
  const handles: Array<{ handle: NativeGraphicPathEditHandle; point: NativeArtPoint; label: string }> = circularArc
    ? [
        { handle: "start", point: projectedPoints.start, label: "Adjust arc start" },
        { handle: "middle", point: projectedPoints.middle, label: "Adjust arc radius" },
        { handle: "end", point: projectedPoints.end, label: "Adjust arc sweep" }
      ]
    : [
        { handle: "start", point: projectedPoints.start, label: "Adjust line start" },
        { handle: "middle", point: projectedPoints.middle, label: "Bend line into curve" },
        { handle: "end", point: projectedPoints.end, label: "Adjust line end" }
      ];

  return (
    <>
      {handles.map(({ handle, point, label }) => (
        <button
          type="button"
          className={[
            "graphic-path-edit-handle",
            `graphic-path-edit-handle-${handle}`,
            circularArc && handle === "middle" ? "graphic-path-edit-handle-arc-middle" : undefined
          ].filter(Boolean).join(" ")}
          aria-label={label}
          data-graphic-path-handle={handle}
          key={handle}
          style={{
            left: pageScaledCssPx(point.x - object.x),
            top: pageScaledCssPx(point.y - object.y)
          }}
          title={label}
          onPointerDown={onPointerDown(handle)}
        />
      ))}
      {markerHandles.map((handle) => (
        <button
          type="button"
          className={[
            "graphic-path-edit-handle",
            "graphic-marker-edit-handle",
            `graphic-marker-edit-handle-${handle.id === "markerStart" ? "start" : "end"}`
          ].join(" ")}
          aria-label={handle.id === "markerStart" ? "Adjust start arrowhead size" : "Adjust end arrowhead size"}
          data-graphic-marker-handle={handle.id}
          data-graphic-marker-size={String(Math.round(handle.marker.sizePx))}
          key={handle.id}
          style={{
            left: pageScaledCssPx(handle.point.x),
            top: pageScaledCssPx(handle.point.y)
          }}
          title={handle.id === "markerStart" ? "Adjust start arrowhead size" : "Adjust end arrowhead size"}
          onPointerDown={onMarkerPointerDown(handle.id)}
        />
      ))}
      {arcRadianReadout ? (
        <div
          className="graphic-path-radian-readout"
          data-graphic-path-readout="true"
          style={{
            left: pageScaledCssPx(projectedPoints.middle.x - object.x),
            top: pageScaledCssPx(projectedPoints.middle.y - object.y),
            transform: graphicSystemReadoutTransform(counterRotationDegrees, "path-radian")
          }}
        >
          {arcRadianReadout}
        </div>
      ) : null}
    </>
  );
}

function graphicSystemReadoutTransform(
  counterRotationDegrees: number,
  kind: "corner-radius" | "path-radian" | "eyedropper-target"
): string {
  const base = kind === "corner-radius"
    ? "translate(-50%, calc(-100% - 10px))"
    : kind === "path-radian"
      ? "translate(-50%, calc(-100% - 12px))"
      : "translate(-50%, calc(-100% - 8px))";
  return Math.abs(counterRotationDegrees) > 0.001
    ? `${base} rotate(${formatSvgNumber(-counterRotationDegrees)}deg)`
    : base;
}

type GraphicPathSegmentHitPlan = {
  d: string;
  handle: Extract<NativeGraphicPathEditHandle, `segment:${number}`>;
  index: number;
};

function graphicPathSegmentHitPlans(
  object: GraphicObject,
  editPoints: NativeGraphicPathNodeEditPoints
): GraphicPathSegmentHitPlan[] {
  const nodes = editPoints.nodes;
  const segmentCount = editPoints.pathClosed ? nodes.length : nodes.length - 1;
  if (segmentCount <= 0) {
    return [];
  }

  const plans: GraphicPathSegmentHitPlan[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const start = nodes[index];
    const end = nodes[(index + 1) % nodes.length];
    if (!start || !end) {
      continue;
    }
    plans.push({
      d: graphicPathSegmentHitPathD(object, start, end, editPoints.pathKind),
      handle: `segment:${index}`,
      index
    });
  }

  return plans;
}

function graphicPathSegmentHitPathD(
  object: GraphicObject,
  start: NativeGraphicPathNodeEditPoints["nodes"][number],
  end: NativeGraphicPathNodeEditPoints["nodes"][number],
  pathKind: NativeGraphicPathNodeEditPoints["pathKind"]
): string {
  const startPoint = projectGraphicObjectPoint(object, start.point);
  const endPoint = projectGraphicObjectPoint(object, end.point);
  const move = `M ${formatSvgNumber(startPoint.x - object.x)} ${formatSvgNumber(startPoint.y - object.y)}`;
  const endCommand = `${formatSvgNumber(endPoint.x - object.x)} ${formatSvgNumber(endPoint.y - object.y)}`;
  if (pathKind === "bezier" && (start.outControl || end.inControl)) {
    const outControl = projectGraphicObjectPoint(object, start.outControl ?? start.point);
    const inControl = projectGraphicObjectPoint(object, end.inControl ?? end.point);
    return [
      move,
      "C",
      `${formatSvgNumber(outControl.x - object.x)} ${formatSvgNumber(outControl.y - object.y)}`,
      `${formatSvgNumber(inControl.x - object.x)} ${formatSvgNumber(inControl.y - object.y)}`,
      endCommand
    ].join(" ");
  }

  return `${move} L ${endCommand}`;
}

function bezierControlHandlePlans(
  editPoints: NativeGraphicPathNodeEditPoints,
  selectedNodeIndex: number
): Array<{
  anchor: NativeArtPoint;
  handle: Extract<NativeGraphicPathEditHandle, `node:${number}:in` | `node:${number}:out`>;
  index: number;
  kind: "in" | "out";
  point: NativeArtPoint;
}> {
  const nodes = editPoints.nodes;
  const node = nodes[selectedNodeIndex];
  if (!node) {
    return [];
  }

  const previous = selectedNodeIndex > 0
    ? nodes[selectedNodeIndex - 1]
    : editPoints.pathClosed ? nodes[nodes.length - 1] : undefined;
  const next = selectedNodeIndex < nodes.length - 1
    ? nodes[selectedNodeIndex + 1]
    : editPoints.pathClosed ? nodes[0] : undefined;
  const controls: Array<{
    anchor: NativeArtPoint;
    handle: Extract<NativeGraphicPathEditHandle, `node:${number}:in` | `node:${number}:out`>;
    index: number;
    kind: "in" | "out";
    point: NativeArtPoint;
  }> = [];

  if (previous) {
    controls.push({
      anchor: node.point,
      handle: `node:${selectedNodeIndex}:in`,
      index: selectedNodeIndex,
      kind: "in",
      point: node.inControl ?? defaultBezierControlPoint(node.point, previous.point)
    });
  }
  if (next) {
    controls.push({
      anchor: node.point,
      handle: `node:${selectedNodeIndex}:out`,
      index: selectedNodeIndex,
      kind: "out",
      point: node.outControl ?? defaultBezierControlPoint(node.point, next.point)
    });
  }

  return controls;
}

function graphicPathNodeIndexFromEditHandle(handle: NativeGraphicPathEditHandle): number | undefined {
  const match = /^node:(\d+)(?::(?:in|out))?$/.exec(handle);
  if (!match) {
    return undefined;
  }

  return Number.parseInt(match[1], 10);
}

function defaultBezierControlPoint(anchor: NativeArtPoint, target: NativeArtPoint): NativeArtPoint {
  const dx = target.x - anchor.x;
  const dy = target.y - anchor.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.001) {
    return anchor;
  }

  const length = Math.min(26, Math.max(10, distance / 4));
  return {
    x: anchor.x + dx / distance * length,
    y: anchor.y + dy / distance * length
  };
}

function ArtShapePrimitive({
  kind,
  width,
  height,
  rx,
  className,
  fill,
  stroke,
  transform
}: {
  kind: GraphicObject["graphicKind"];
  width: number;
  height: number;
  rx: number;
  className: string;
  fill: string;
  stroke: string;
  transform?: string;
}) {
  return kind === "ellipse" ? (
    <ellipse
      className={className}
      cx={width / 2}
      cy={height / 2}
      rx={Math.max(width / 2, 0.5)}
      ry={Math.max(height / 2, 0.5)}
      fill={fill}
      stroke={stroke}
      transform={transform}
    />
  ) : (
    <rect
      className={className}
      x="0"
      y="0"
      width={width}
      height={height}
      rx={rx}
      ry={rx}
      fill={fill}
      stroke={stroke}
      transform={transform}
    />
  );
}

type DocumentObjectProjectionMatrix = { a: number; b: number; c: number; d: number };

interface DocumentObjectProjection {
  frameStyle?: CSSProperties;
  matrix?: DocumentObjectProjectionMatrix;
}

function documentObjectSupportsArtTransform(object: DocumentObject): boolean {
  return object.type === "graphic" || object.type === "bracket" || object.type === "reaction-arrow";
}

function documentObjectOuterCssTransform(
  object: DocumentObject,
  projection: DocumentObjectProjection | undefined,
  preview: ObjectTransformPreviewState | undefined
): string | undefined {
  if (preview) {
    return object.type === "graphic"
      ? objectTransformPreviewCssTransform(preview, { includeRotation: false })
      : objectTransformPreviewCssTransform(preview);
  }

  if (object.type === "graphic" || projection?.matrix || Math.abs(object.rotation) < 0.001) {
    return undefined;
  }

  return `rotate(${object.rotation}deg)`;
}

function documentObjectOuterCssTransformOrigin(
  object: DocumentObject,
  preview: ObjectTransformPreviewState | undefined
): string | undefined {
  if (!preview || (object.type === "graphic" && preview.mode === "rotate")) {
    return undefined;
  }

  return objectTransformPreviewCssOrigin(object, preview);
}

function pageScaledCssPx(value: number): string {
  return `calc(${value}px * var(--page-scale))`;
}

function objectTransformPreviewCssTransform(
  preview: ObjectTransformPreviewState,
  options: { includeRotation?: boolean } = {}
): string {
  const includeRotation = options.includeRotation ?? true;
  const transforms: string[] = [];
  if (Math.abs(preview.translateX) > 0.001 || Math.abs(preview.translateY) > 0.001) {
    transforms.push(`translate(${pageScaledCssPx(formatSvgNumber(preview.translateX))}, ${pageScaledCssPx(formatSvgNumber(preview.translateY))})`);
  }
  if (includeRotation && Math.abs(preview.rotationDegrees) > 0.001) {
    transforms.push(`rotate(${formatSvgNumber(preview.rotationDegrees)}deg)`);
  }
  if (Math.abs(preview.scaleX - 1) > 0.001 || Math.abs(preview.scaleY - 1) > 0.001) {
    transforms.push(`scale(${formatSvgNumber(preview.scaleX)}, ${formatSvgNumber(preview.scaleY)})`);
  }
  return transforms.join(" ");
}

function graphicVisualCssRotationDegrees(
  object: GraphicObject,
  preview: ObjectTransformPreviewState | undefined
): number {
  const committedRotation = object.rotation;
  const previewRotation = preview?.mode === "rotate" ? preview.rotationDegrees : 0;
  return committedRotation + previewRotation;
}

function graphicVisualCssStyle(rotationDegrees: number): CSSProperties | undefined {
  if (Math.abs(rotationDegrees) < 0.001) {
    return undefined;
  }

  return {
    transform: `rotate(${formatSvgNumber(rotationDegrees)}deg)`
  };
}

function objectTransformPreviewCssOrigin(
  object: Pick<DocumentObject, "x" | "y" | "width" | "height">,
  preview: ObjectTransformPreviewState
): string | undefined {
  if (preview.mode === "move") {
    return undefined;
  }

  const originX = object.width > 0.001
    ? ((preview.origin.x - object.x) / object.width) * 100
    : 50;
  const originY = object.height > 0.001
    ? ((preview.origin.y - object.y) / object.height) * 100
    : 50;
  return `${formatSvgNumber(originX)}% ${formatSvgNumber(originY)}%`;
}

function documentObjectProjectedPlaneProjection(object: DocumentObject): DocumentObjectProjection | undefined {
  const tilt = documentObjectProjectedPlaneTilt(object);
  if (
    Math.abs(tilt.tiltXDegrees) < 0.001 &&
    Math.abs(tilt.tiltYDegrees) < 0.001 &&
    Math.abs(object.rotation) < 0.001
  ) {
    return undefined;
  }

  if (object.type === "graphic") {
    const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
    if (!plan.projectionMatrix) {
      return undefined;
    }

    return {
      frameStyle: {
        left: pageScaledCssPx(plan.frameBounds.x),
        top: pageScaledCssPx(plan.frameBounds.y),
        width: pageScaledCssPx(plan.frameBounds.width),
        height: pageScaledCssPx(plan.frameBounds.height)
      },
      matrix: plan.projectionMatrix
    };
  }

  const matrix = documentObjectProjectedPlaneMatrix(tilt.tiltXDegrees, tilt.tiltYDegrees, object.rotation);
  const bounds = documentObjectProjectedPlaneBounds(object.width, object.height, matrix);
  return {
    frameStyle: {
      left: pageScaledCssPx(bounds.x),
      top: pageScaledCssPx(bounds.y),
      width: pageScaledCssPx(bounds.width),
      height: pageScaledCssPx(bounds.height)
    },
    matrix
  };
}

function documentObjectArtTransformFrameStyle(
  object: DocumentObject,
  projection: DocumentObjectProjection | undefined,
  preview: ObjectTransformPreviewState | undefined
): CSSProperties | undefined {
  if (object.type !== "graphic") {
    return projection?.frameStyle;
  }

  const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
  const bounds = rotatedGraphicLocalBounds(
    object,
    plan.frameBounds,
    graphicVisualCssRotationDegrees(object, preview)
  );
  return {
    left: pageScaledCssPx(bounds.x),
    top: pageScaledCssPx(bounds.y),
    width: pageScaledCssPx(bounds.width),
    height: pageScaledCssPx(bounds.height)
  };
}

function rotatedGraphicLocalBounds(
  object: GraphicObject,
  bounds: { x: number; y: number; width: number; height: number },
  rotationDegrees: number
): { x: number; y: number; width: number; height: number } {
  if (Math.abs(rotationDegrees) < 0.001) {
    return bounds;
  }
  if (
    object.graphicKind === "ellipse" &&
    Math.abs(Math.max(object.width, 1) - Math.max(object.height, 1)) < 0.001
  ) {
    return bounds;
  }

  const center = {
    x: Math.max(object.width, 1) / 2,
    y: Math.max(object.height, 1) / 2
  };
  const rotationRad = degreesToRadians(rotationDegrees);
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height }
  ].map((point) => rotatePointAroundCenter(point, center, cos, sin));

  const minX = Math.min(...corners.map((point) => point.x));
  const maxX = Math.max(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y));
  const maxY = Math.max(...corners.map((point) => point.y));
  return {
    x: roundCssCoordinate(minX),
    y: roundCssCoordinate(minY),
    width: roundCssCoordinate(maxX - minX),
    height: roundCssCoordinate(maxY - minY)
  };
}

function unrotateGraphicVisualPagePoint(object: GraphicObject, point: ClientPoint): ClientPoint {
  if (Math.abs(object.rotation) < 0.001) {
    return point;
  }

  const center = {
    x: object.x + Math.max(object.width, 1) / 2,
    y: object.y + Math.max(object.height, 1) / 2
  };
  const rotationRad = degreesToRadians(-object.rotation);
  return rotatePointAroundCenter(point, center, Math.cos(rotationRad), Math.sin(rotationRad));
}

function projectGraphicVisualPagePoint(object: GraphicObject, point: ClientPoint): ClientPoint {
  const projected = projectGraphicObjectPoint(object, point);
  if (Math.abs(object.rotation) < 0.001) {
    return projected;
  }

  const center = {
    x: object.x + Math.max(object.width, 1) / 2,
    y: object.y + Math.max(object.height, 1) / 2
  };
  const rotationRad = degreesToRadians(object.rotation);
  return rotatePointAroundCenter(projected, center, Math.cos(rotationRad), Math.sin(rotationRad));
}

function rotatePointAroundCenter(
  point: { x: number; y: number },
  center: { x: number; y: number },
  cos: number,
  sin: number
): { x: number; y: number } {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos
  };
}

function documentObjectProjectedPlaneMatrix(
  tiltXDegrees: number,
  tiltYDegrees: number,
  rotationDegrees: number
): DocumentObjectProjectionMatrix {
  const tiltXRad = degreesToRadians(tiltXDegrees);
  const tiltYRad = degreesToRadians(tiltYDegrees);
  const cx = Math.cos(tiltXRad);
  const sx = Math.sin(tiltXRad);
  const cy = Math.cos(tiltYRad);
  const sy = Math.sin(tiltYRad);
  const zRad = degreesToRadians(rotationDegrees);
  const cz = Math.cos(zRad);
  const sz = Math.sin(zRad);

  // Same screen-space projected-plane basis used by native molecule X/Y tilt
  // for local z=0 points, expressed as a 2D affine CSS matrix. The in-plane
  // Z rotation is applied first, then the screen-space Y and X tilts.
  return {
    a: cy * cz,
    b: cx * sz + sx * sy * cz,
    c: -cy * sz,
    d: cx * cz - sx * sy * sz
  };
}

function documentObjectProjectedPlaneBounds(
  width: number,
  height: number,
  matrix: DocumentObjectProjectionMatrix
): { x: number; y: number; width: number; height: number } {
  const halfWidth = Math.max(width, 1) / 2;
  const halfHeight = Math.max(height, 1) / 2;
  const corners = [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight }
  ].map((point) => ({
    x: matrix.a * point.x + matrix.c * point.y,
    y: matrix.b * point.x + matrix.d * point.y
  }));
  const minX = Math.min(...corners.map((point) => point.x));
  const maxX = Math.max(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y));
  const maxY = Math.max(...corners.map((point) => point.y));

  return {
    x: roundCssCoordinate(halfWidth + minX),
    y: roundCssCoordinate(halfHeight + minY),
    width: roundCssCoordinate(maxX - minX),
    height: roundCssCoordinate(maxY - minY)
  };
}

function roundCssCoordinate(value: number): number {
  return Number(value.toFixed(4));
}

function formatCssNumber(value: number): string {
  return `${roundCssCoordinate(value)}`;
}

function projectArtPoint(
  point: { x: number; y: number },
  width: number,
  height: number,
  matrix: DocumentObjectProjectionMatrix | undefined
): { x: number; y: number } {
  if (!matrix) {
    return point;
  }

  const halfWidth = Math.max(width, 1) / 2;
  const halfHeight = Math.max(height, 1) / 2;
  const dx = point.x - halfWidth;
  const dy = point.y - halfHeight;
  return {
    x: halfWidth + matrix.a * dx + matrix.c * dy,
    y: halfHeight + matrix.b * dx + matrix.d * dy
  };
}

function artProjectionSvgTransform(
  width: number,
  height: number,
  matrix: DocumentObjectProjectionMatrix
): string {
  const halfWidth = Math.max(width, 1) / 2;
  const halfHeight = Math.max(height, 1) / 2;
  const e = halfWidth - matrix.a * halfWidth - matrix.c * halfHeight;
  const f = halfHeight - matrix.b * halfWidth - matrix.d * halfHeight;
  return [
    "matrix(",
    formatCssNumber(matrix.a),
    " ",
    formatCssNumber(matrix.b),
    " ",
    formatCssNumber(matrix.c),
    " ",
    formatCssNumber(matrix.d),
    " ",
    formatCssNumber(e),
    " ",
    formatCssNumber(f),
    ")"
  ].join("");
}

function projectedArtShapePathD(
  kind: GraphicObject["graphicKind"],
  width: number,
  height: number,
  rx: number,
  matrix: DocumentObjectProjectionMatrix,
  offset: { x: number; y: number } = { x: 0, y: 0 },
  strokeWidth = 0
): string {
  const points = kind === "ellipse"
    ? ellipsePathPoints(width, height, strokeWidth, offset)
    : roundedRectPathPoints(width, height, rx, strokeWidth, offset);
  return projectedPointsPathD(points, true, width, height, matrix);
}

function roundedRectPathPoints(
  width: number,
  height: number,
  rx: number,
  strokeWidth: number,
  offset: { x: number; y: number }
): Array<{ x: number; y: number }> {
  const inset = Math.max(strokeWidth / 2, 0);
  const x0 = inset + offset.x;
  const y0 = inset + offset.y;
  const x1 = Math.max(width - inset + offset.x, x0 + 0.5);
  const y1 = Math.max(height - inset + offset.y, y0 + 0.5);
  const radius = Math.max(0, Math.min(rx, (x1 - x0) / 2, (y1 - y0) / 2));
  if (radius <= 0.001) {
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 }
    ];
  }

  return [
    ...arcSamplePoints({ x: x1 - radius, y: y0 + radius }, radius, radius, -90, 0, 8),
    ...arcSamplePoints({ x: x1 - radius, y: y1 - radius }, radius, radius, 0, 90, 8).slice(1),
    ...arcSamplePoints({ x: x0 + radius, y: y1 - radius }, radius, radius, 90, 180, 8).slice(1),
    ...arcSamplePoints({ x: x0 + radius, y: y0 + radius }, radius, radius, 180, 270, 8).slice(1)
  ];
}

function ellipsePathPoints(
  width: number,
  height: number,
  strokeWidth: number,
  offset: { x: number; y: number }
): Array<{ x: number; y: number }> {
  const inset = Math.max(strokeWidth / 2, 0);
  return arcSamplePoints(
    { x: width / 2 + offset.x, y: height / 2 + offset.y },
    Math.max(width / 2 - inset, 0.5),
    Math.max(height / 2 - inset, 0.5),
    0,
    360,
    72
  );
}

function arcSamplePoints(
  center: { x: number; y: number },
  rx: number,
  ry: number,
  startDegrees: number,
  endDegrees: number,
  steps: number
): Array<{ x: number; y: number }> {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = steps <= 0 ? 1 : index / steps;
    return ellipsePointAtDegrees(center, rx, ry, startDegrees + (endDegrees - startDegrees) * t);
  });
}

function ellipsePointAtDegrees(
  center: { x: number; y: number },
  rx: number,
  ry: number,
  degrees: number
): { x: number; y: number } {
  const radians = degreesToRadians(degrees);
  return {
    x: center.x + Math.cos(radians) * rx,
    y: center.y + Math.sin(radians) * ry
  };
}

function projectedPointsPathD(
  points: Array<{ x: number; y: number }>,
  closed: boolean,
  width: number,
  height: number,
  matrix: DocumentObjectProjectionMatrix
): string {
  const projected = points.map((point) => projectArtPoint(point, width, height, matrix));
  if (projected.length === 0) {
    return "";
  }

  return [
    `M ${formatSvgNumber(projected[0].x)} ${formatSvgNumber(projected[0].y)}`,
    ...projected.slice(1).map((point) => `L ${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`),
    closed ? "Z" : ""
  ].filter(Boolean).join(" ");
}

function artTransformQaProjectedCorners(object: GraphicObject): Array<{ x: number; y: number }> {
  const projection = documentObjectProjectedPlaneProjection(object);
  const corners = [
    { x: 0, y: 0 },
    { x: object.width, y: 0 },
    { x: object.width, y: object.height },
    { x: 0, y: object.height }
  ];
  return corners.map((corner) => {
    const point = projectArtPoint(corner, object.width, object.height, projection?.matrix);
    return {
      x: object.x + point.x,
      y: object.y + point.y
    };
  });
}

function artTransformQaSceneDocument(document: ChemDraftDocument, draft: ArtTransformQaDraft): ChemDraftDocument {
  const page = document.pages[0];
  if (!page) {
    return document;
  }

  const rotationDegrees = artTransformQaDegrees(draft.rotationDegrees, 28);
  const tiltXDegrees = artTransformQaDegrees(draft.tiltXDegrees, 35);
  const tiltYDegrees = artTransformQaDegrees(draft.tiltYDegrees, -20);
  const objects = [
    artTransformQaObject({
      id: ART_TRANSFORM_QA_OBJECT_IDS[0],
      kind: "rect",
      x: Math.min(page.width - 112, Math.max(page.margin.left + 238, 190)),
      y: Math.min(page.height - 120, Math.max(page.margin.top + 520, 430)),
      width: 96,
      height: 56,
      rotationDegrees,
      tiltXDegrees,
      tiltYDegrees
    }),
    artTransformQaObject({
      id: ART_TRANSFORM_QA_OBJECT_IDS[1],
      kind: "ellipse",
      x: Math.min(page.width - 92, Math.max(page.margin.left + 100, 120)),
      y: Math.min(page.height - 120, Math.max(page.margin.top + 515, 430)),
      width: 72,
      height: 72,
      rotationDegrees,
      tiltXDegrees,
      tiltYDegrees
    })
  ];
  const patches: DocumentPatch[] = objects.flatMap((object): DocumentPatch[] => {
    const existing = page.objects.find((candidate) => candidate.id === object.id);
    if (!existing) {
      return [{ op: "addObject", pageId: page.id, object }];
    }
    if (existing.type !== "graphic") {
      return [
        { op: "removeObject", objectId: object.id },
        { op: "addObject", pageId: page.id, object }
      ];
    }
    return [{ op: "updateObject", objectId: object.id, changes: object }];
  });

  return applyPatches(
    document,
    [
      ...patches,
      { op: "setSelection", pageId: page.id, objectIds: [ART_TRANSFORM_QA_OBJECT_IDS[0]] }
    ]
  );
}

function artTransformQaSelectionDocument(document: ChemDraftDocument, draft: ArtTransformQaDraft): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.id === document.selection.pageId) ?? document.pages[0];
  if (!page) {
    return document;
  }

  const selectedGraphics = page.objects.filter((object): object is GraphicObject =>
    object.type === "graphic" && document.selection.objectIds.includes(object.id)
  );
  if (selectedGraphics.length === 0) {
    return document;
  }

  return applyPatches(
    document,
    selectedGraphics.map((object) => {
      const currentTiltX = typeof object.style.tiltXDegrees === "number" ? object.style.tiltXDegrees : 0;
      const currentTiltY = typeof object.style.tiltYDegrees === "number" ? object.style.tiltYDegrees : 0;
      return {
        op: "updateObject",
        objectId: object.id,
        changes: {
          rotation: artTransformQaDegrees(draft.rotationDegrees, object.rotation),
          style: {
            ...object.style,
            tiltXDegrees: artTransformQaDegrees(draft.tiltXDegrees, currentTiltX),
            tiltYDegrees: artTransformQaDegrees(draft.tiltYDegrees, currentTiltY)
          }
        }
      };
    })
  );
}

function artStyleQaSceneDocument(document: ChemDraftDocument): ChemDraftDocument {
  const page = document.pages[0];
  if (!page) {
    return document;
  }

  const baseX = Math.min(page.width - 360, Math.max(page.margin.left + 145, 135));
  const baseY = Math.min(page.height - 250, Math.max(page.margin.top + 820, 560));
  const objects = [
    artStyleQaObject({
      id: ART_STYLE_QA_OBJECT_IDS[0],
      kind: "rect",
      x: baseX,
      y: baseY,
      width: 84,
      height: 48,
      fillColor: "#f8faf9",
      strokeColor: "#1d7f68",
      strokeWidth: 2,
      data: { cornerRadiusPx: 8, artToolId: "qa-style-rounded-rect" }
    }),
    artStyleQaObject({
      id: ART_STYLE_QA_OBJECT_IDS[1],
      kind: "ellipse",
      x: baseX + 120,
      y: baseY - 6,
      width: 58,
      height: 58,
      fillColor: "#1648ff",
      strokeColor: "#111111",
      strokeWidth: 2,
      data: { artToolId: "qa-style-ellipse" }
    }),
    artStyleQaObject({
      id: ART_STYLE_QA_OBJECT_IDS[2],
      kind: "line",
      x: baseX + 215,
      y: baseY + 12,
      width: 92,
      height: 30,
      fillColor: "none",
      strokeColor: "#b3261e",
      strokeWidth: 3,
      data: {
        lineStart: { x: baseX + 215, y: baseY + 42 },
        lineEnd: { x: baseX + 307, y: baseY + 12 },
        artToolId: "qa-style-line"
      }
    }),
    artStyleQaObject({
      id: ART_STYLE_QA_OBJECT_IDS[3],
      kind: "path",
      x: baseX + 90,
      y: baseY + 95,
      width: 64,
      height: 64,
      fillColor: "none",
      strokeColor: "#111111",
      strokeWidth: 3,
      data: {
        artPathKind: "arc",
        arcStartRadians: Math.PI * 0.15,
        arcSweepRadians: Math.PI * 1.45,
        artToolId: "qa-style-arc"
      }
    })
  ];
  const patches: DocumentPatch[] = objects.flatMap((object): DocumentPatch[] => {
    const existing = page.objects.find((candidate) => candidate.id === object.id);
    if (!existing) {
      return [{ op: "addObject", pageId: page.id, object }];
    }
    if (existing.type !== "graphic") {
      return [
        { op: "removeObject", objectId: object.id },
        { op: "addObject", pageId: page.id, object }
      ];
    }
    return [{ op: "updateObject", objectId: object.id, changes: object }];
  });

  return applyPatches(document, [
    ...patches,
    { op: "setSelection", pageId: page.id, objectIds: [ART_STYLE_QA_OBJECT_IDS[0]] }
  ]);
}

function artStyleQaStressDocument(document: ChemDraftDocument, runCount: number): ChemDraftDocument {
  const seededDocument = artStyleQaSceneDocument(document);
  const page = seededDocument.pages[0];
  if (!page) {
    return seededDocument;
  }

  const fillColors = ["#1d7f68", "#1648ff", "#b3261e", "#6cb155", "#f8faf9"];
  const strokeColors = ["#111111", "#1d7f68", "#b3261e", "#1648ff", "#4b5563"];
  const strokeWidths = [1, 1.5, 2, 3, 5];
  const strokeDasharrays: Array<string | undefined> = [undefined, "8 6", "14 7", "0 6", "8 5 0 5"];
  const strokeLineCaps: Array<NonNullable<GraphicObject["style"]["strokeLineCap"]>> = ["butt", "round", "square"];
  const strokeLineJoins: Array<NonNullable<GraphicObject["style"]["strokeLineJoin"]>> = ["miter", "round", "bevel"];
  const patches = ART_STYLE_QA_OBJECT_IDS.flatMap((objectId, index): DocumentPatch[] => {
    const object = page.objects.find((candidate): candidate is GraphicObject =>
      candidate.id === objectId && candidate.type === "graphic"
    );
    if (!object) {
      return [];
    }

    const step = runCount + index;
    const fillColor = object.graphicKind === "line" ||
      object.data.artPathKind === "arc" ||
      object.data.artPathKind === "quadratic" ||
      object.data.artPathKind === "wavy"
      ? "none"
      : fillColors[step % fillColors.length];
    const strokeColor = strokeColors[(step * 2) % strokeColors.length];
    const fillOpacity = Number((0.35 + (step % 5) * 0.13).toFixed(2));
    const strokeOpacity = Number((0.42 + (step % 4) * 0.15).toFixed(2));
    return [{
      op: "updateObject",
      objectId,
      changes: {
        style: {
          ...object.style,
          opacity: Number((0.68 + (step % 3) * 0.12).toFixed(2)),
          fillColor,
          strokeColor,
          fillOpacity,
          strokeOpacity,
          fillPaint: fillColor === "none"
            ? { kind: "none" }
            : { kind: "solid", color: fillColor, opacity: fillOpacity },
          strokePaint: { kind: "solid", color: strokeColor, opacity: strokeOpacity },
          strokeWidth: strokeWidths[step % strokeWidths.length],
          strokeDasharray: strokeDasharrays[step % strokeDasharrays.length],
          strokeLineCap: strokeLineCaps[step % strokeLineCaps.length],
          strokeLineJoin: strokeLineJoins[(step + 1) % strokeLineJoins.length],
          strokeMiterLimit: 4 + step % 5
        }
      }
    }];
  });

  return applyPatches(seededDocument, [
    ...patches,
    { op: "setSelection", pageId: page.id, objectIds: [ART_STYLE_QA_OBJECT_IDS[0]] }
  ]);
}

function artStyleQaObject({
  id,
  kind,
  x,
  y,
  width,
  height,
  fillColor,
  strokeColor,
  strokeWidth,
  data
}: {
  id: string;
  kind: GraphicObject["graphicKind"];
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  data: GraphicObject["data"];
}): GraphicObject {
  return {
    id,
    type: "graphic",
    x,
    y,
    width,
    height,
    rotation: 0,
    graphicKind: kind,
    style: {
      source: "chemdraft-art-style-qa",
      strokeColor,
      fillColor,
      strokeWidth,
      strokePaint: { kind: "solid", color: strokeColor, opacity: 1 },
      fillPaint: fillColor === "none" ? { kind: "none" } : { kind: "solid", color: fillColor, opacity: 1 }
    },
    data,
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    }
  };
}

function artTransformQaObject({
  id,
  kind,
  x,
  y,
  width,
  height,
  rotationDegrees,
  tiltXDegrees,
  tiltYDegrees
}: {
  id: string;
  kind: "ellipse" | "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDegrees: number;
  tiltXDegrees: number;
  tiltYDegrees: number;
}): GraphicObject {
  return {
    id,
    type: "graphic",
    x,
    y,
    width,
    height,
    rotation: rotationDegrees,
    graphicKind: kind,
    style: {
      source: "chemdraft-art-transform-qa",
      strokeColor: "#111111",
      fillColor: "none",
      strokeWidth: 3,
      tiltXDegrees,
      tiltYDegrees
    },
    data: kind === "rect" ? { cornerRadiusPx: 9, artToolId: "qa-rounded-rect" } : { artToolId: "qa-ellipse" },
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    }
  };
}

function artTransformQaDegrees(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function documentObjectToolbarColor(object: DocumentObject): string {
  if (object.type === "graphic") {
    const fillColor = metadataStringValue(object.style.fillColor);
    if (fillColor && fillColor.toLowerCase() !== "none") {
      return metadataColor(fillColor, object.style.strokeColor, object.style.color, "#111111");
    }
    return metadataColor(object.style.strokeColor, object.style.color, "#111111");
  }

  return metadataColor(object.style.color, object.style.strokeColor, object.style.fillColor, "#111111");
}

function documentObjectTransformLabel(object: DocumentObject | undefined): string {
  if (object?.type === "text") {
    return "text box";
  }
  if (object?.type === "molecule") {
    return "selected molecule";
  }
  if (object && documentObjectSupportsArtTransform(object)) {
    return "selected art object";
  }
  return "selected object";
}

function metadataColor(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0 && value.trim().toLowerCase() !== "none") {
      return value.trim();
    }
  }
  return "#111111";
}

function metadataStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function metadataNumberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatSvgNumber(value: number): number {
  return Number(value.toFixed(3));
}

function TextObjectContent({ editing = false, object }: { editing?: boolean; object: TextObject }) {
  return (
    <span className={["text-object-content", editing ? "text-object-edit-preview" : ""].filter(Boolean).join(" ")}>
      {textObjectSpansForRendering(object).map((span, index) => (
        <span
          className="text-object-run"
          data-text-script={span.script}
          style={textSpanCss(span)}
          key={`${span.script}-${index}-${span.text}`}
        >
          {span.text}
        </span>
      ))}
    </span>
  );
}

function textScriptForTextObject(object: TextObject): TextSpan["script"] {
  const scripts = new Set(
    textObjectSpansForRendering(object)
      .filter((span) => span.text.length > 0)
      .map((span) => span.script)
  );

  return scripts.size === 1 ? [...scripts][0] ?? "normal" : "normal";
}

function textScriptForTextRange(object: TextObject, range: NativeTextSelectionRange): TextSpan["script"] {
  const start = Math.max(0, Math.min(range.start, range.end, object.text.length));
  const end = Math.max(0, Math.min(Math.max(range.start, range.end), object.text.length));
  if (start === end) {
    return textScriptForTextObject(object);
  }

  let offset = 0;
  const scripts = new Set<TextSpan["script"]>();
  textObjectSpansForRendering(object).forEach((span) => {
    const spanStart = offset;
    const spanEnd = offset + span.text.length;
    offset = spanEnd;
    if (spanEnd > start && spanStart < end) {
      scripts.add(span.script);
    }
  });

  return scripts.size === 1 ? [...scripts][0] ?? "normal" : "normal";
}

function textStyleForTextRange(object: TextObject, range: NativeTextSelectionRange): Record<string, unknown> {
  const start = Math.max(0, Math.min(range.start, range.end, object.text.length));
  const end = Math.max(0, Math.min(Math.max(range.start, range.end), object.text.length));
  if (start === end) {
    return {};
  }

  let offset = 0;
  const values = new Map<string, Set<unknown>>();
  textObjectSpansForRendering(object).forEach((span) => {
    const spanStart = offset;
    const spanEnd = offset + span.text.length;
    offset = spanEnd;
    if (spanEnd <= start || spanStart >= end) {
      return;
    }

    Object.entries(span.style).forEach(([key, value]) => {
      const set = values.get(key) ?? new Set<unknown>();
      set.add(value);
      values.set(key, set);
    });
  });

  return Object.fromEntries(
    [...values.entries()]
      .filter(([, valueSet]) => valueSet.size === 1)
      .map(([key, valueSet]) => [key, [...valueSet][0]])
  );
}

function textSpanCss(span: TextSpan): CSSProperties | undefined {
  const style = span.style;
  const css: CSSProperties = {};
  const color = textSpanString(style.color);
  const fontFamily = textSpanString(style.fontFamily);
  const fontSizePx = textSpanNumber(style.fontSizePx);
  const letterSpacingPx = textSpanNumber(style.letterSpacingPx);
  const fontWeight = textSpanNumber(style.fontWeight);
  const fontStyle = textSpanString(style.fontStyle);
  const textDecoration = textSpanString(style.textDecoration);

  if (color) {
    css.color = color;
  }
  if (fontFamily) {
    css.fontFamily = fontFamily;
  }
  if (fontSizePx !== undefined) {
    css.fontSize = `calc(${fontSizePx}px * var(--page-scale))`;
  }
  if (letterSpacingPx !== undefined) {
    css.letterSpacing = `calc(${letterSpacingPx}px * var(--page-scale))`;
  }
  if (fontWeight !== undefined) {
    css.fontWeight = fontWeight;
  }
  if (fontStyle === "italic" || fontStyle === "normal") {
    css.fontStyle = fontStyle;
  }
  if (textDecoration) {
    css.textDecoration = textDecoration;
  }

  return Object.keys(css).length > 0 ? css : undefined;
}

function textSpanString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textSpanNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// BASE colors (the user's chosen per-part color, NO perspective depth tint) — used by
// the toolbar color reflection. The depth-cued renderer colors live in layout-engine
// (`nativeMoleculeBondColor` there) and intentionally do NOT share these names.
function nativeMoleculeBaseBondColor(
  object: MoleculeObject,
  bondId: string,
  drawingStyle: NativeDrawingStyle
): string {
  return styleColorMapValue(object.style.bondColors, bondId) ?? drawingStyle.bondColor;
}

function nativeMoleculeBaseAtomLabelColor(
  object: MoleculeObject,
  atomId: string,
  drawingStyle: NativeDrawingStyle
): string {
  return styleColorMapValue(object.style.atomLabelColors, atomId) ?? drawingStyle.atomLabelColor;
}

function nativeMoleculeSelectionColor(
  object: MoleculeObject,
  part: NativeMoleculeSelectionPart,
  drawingStyle: NativeDrawingStyle
): string {
  if (part.kind === "atom") {
    return nativeMoleculeBaseAtomLabelColor(object, part.atomId, drawingStyle);
  }

  if (part.kind === "bond") {
    return nativeMoleculeBaseBondColor(object, part.bondId, drawingStyle);
  }

  if (part.kind === "ring" || part.kind === "rings") {
    return drawingStyle.bondColor;
  }

  const firstBondId = part.bondIds[0];
  if (firstBondId) {
    return nativeMoleculeBaseBondColor(object, firstBondId, drawingStyle);
  }

  const firstAtomId = part.atomIds[0];
  return firstAtomId
    ? nativeMoleculeBaseAtomLabelColor(object, firstAtomId, drawingStyle)
    : drawingStyle.bondColor;
}

function ObjectResizeHandles({
  targetLabel,
  onResizeDoubleClick,
  onResizeStart
}: {
  targetLabel: string;
  onResizeDoubleClick(corner: ObjectResizeCorner): (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onResizeStart(corner: ObjectResizeCorner): (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const corners: ObjectResizeCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

  return (
    <>
      {corners.map((corner) => (
        <button
          aria-label={`Resize ${targetLabel} ${corner.replace("-", " ")}`}
          className={`object-resize-handle object-resize-${corner}`}
          data-object-resize-corner={corner}
          key={corner}
          title={`Resize ${targetLabel}`}
          type="button"
          onPointerDown={onResizeStart(corner)}
          onDoubleClick={onResizeDoubleClick(corner)}
        />
      ))}
    </>
  );
}

function RotationInputPopover({
  input,
  onKeep,
  onHome,
  onCancel,
  onChange
}: {
  input: RotationInputState;
  onKeep(input: RotationInputState): void;
  onHome(input: RotationInputState): void;
  onCancel(input: RotationInputState): void;
  onChange(input: RotationInputState): void;
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onKeep(input);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel(input);
    }
  };
  const stopPointerPropagation = (event: PointerEvent<HTMLFormElement>) => {
    event.stopPropagation();
  };

  return (
    <form
      aria-label={`${input.targetLabel} rotation entry`}
      className="object-rotation-input-popover"
      data-rotation-input-popover="true"
      data-rotation-input-kind={input.kind}
      onSubmit={handleSubmit}
      onPointerDown={stopPointerPropagation}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      {input.kind === "z" ? (
        <label className="object-rotation-input-field">
          <span>Z</span>
          <input
            aria-label="Z rotation degrees"
            autoFocus
            inputMode="decimal"
            type="text"
            value={input.draftZDegrees}
            onChange={(event) => onChange({ ...input, draftZDegrees: event.currentTarget.value })}
          />
        </label>
      ) : (
        <>
          <label className="object-rotation-input-field">
            <span>X</span>
            <input
              aria-label="X rotation degrees"
              autoFocus
              inputMode="decimal"
              type="text"
              value={input.draftXDegrees}
              onChange={(event) => onChange({ ...input, draftXDegrees: event.currentTarget.value })}
            />
          </label>
          <label className="object-rotation-input-field">
            <span>Y</span>
            <input
              aria-label="Y rotation degrees"
              inputMode="decimal"
              type="text"
              value={input.draftYDegrees}
              onChange={(event) => onChange({ ...input, draftYDegrees: event.currentTarget.value })}
            />
          </label>
        </>
      )}
      <span aria-hidden="true" className="object-rotation-input-unit">°</span>
      <button
        aria-label={input.kind === "z" ? "Set Z rotation to 0 degrees" : "Set X/Y rotation to 0 degrees"}
        className="object-rotation-input-action"
        title={input.kind === "z" ? "Set Z rotation to 0 degrees" : "Set X/Y rotation to 0 degrees"}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onHome(input);
        }}
      >
        <HomeInputIcon />
      </button>
      <button
        aria-label="Cancel rotation entry"
        className="object-rotation-input-action"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onCancel(input);
        }}
      >
        <CancelRotationInputIcon />
      </button>
    </form>
  );
}

function ObjectResizeInputPopover({
  input,
  onKeep,
  onHome,
  onCancel,
  onChange
}: {
  input: ObjectResizeInputState;
  onKeep(input: ObjectResizeInputState): void;
  onHome(input: ObjectResizeInputState): void;
  onCancel(input: ObjectResizeInputState): void;
  onChange(input: ObjectResizeInputState): void;
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onKeep(input);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel(input);
    }
  };
  const stopPointerPropagation = (event: PointerEvent<HTMLFormElement>) => {
    event.stopPropagation();
  };

  return (
    <form
      aria-label={`${input.targetLabel} stretch entry`}
      className="object-scale-input-popover"
      data-scale-input-popover="true"
      data-scale-input-corner={input.corner}
      onSubmit={handleSubmit}
      onPointerDown={stopPointerPropagation}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <label className="object-scale-input-field">
        <span>X</span>
        <input
          aria-label="X stretch percent"
          autoFocus
          inputMode="decimal"
          type="text"
          value={input.draftXPercent}
          onChange={(event) => onChange({ ...input, draftXPercent: event.currentTarget.value })}
        />
      </label>
      <label className="object-scale-input-field">
        <span>Y</span>
        <input
          aria-label="Y stretch percent"
          inputMode="decimal"
          type="text"
          value={input.draftYPercent}
          onChange={(event) => onChange({ ...input, draftYPercent: event.currentTarget.value })}
        />
      </label>
      <span aria-hidden="true" className="object-scale-input-unit">%</span>
      <button
        aria-label="Restore stretch home"
        className="object-scale-input-action"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onHome(input);
        }}
      >
        <HomeInputIcon />
      </button>
      <button
        aria-label="Cancel stretch entry"
        className="object-scale-input-action"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onCancel(input);
        }}
      >
        <CancelRotationInputIcon />
      </button>
    </form>
  );
}

function HomeInputIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.5 7.3L8 2.9l5.5 4.4" />
      <path d="M4.2 7.1v6h3V9.7h1.6v3.4h3v-6" />
    </svg>
  );
}

function CancelRotationInputIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

function ObjectResizeReadout({
  scaleXPercent,
  scaleYPercent
}: {
  scaleXPercent: number;
  scaleYPercent: number;
}) {
  return (
    <span
      className="object-resize-readout"
      data-object-resize-readout="true"
      aria-label={`Object scale X ${scaleXPercent} percent Y ${scaleYPercent} percent`}
    >
      X {scaleXPercent}% Y {scaleYPercent}%
    </span>
  );
}

function RotateSelectionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-rotate-icon="double-headed">
      <path
        className="object-rotate-arc"
        d="M7 8.9a6.9 6.9 0 0 1 10.2-1.3"
      />
      <path
        className="object-rotate-arrow"
        d="M17.4 4.6l0.4 4.1-4.1-0.3"
      />
      <path
        className="object-rotate-arc"
        d="M17 15.1a6.9 6.9 0 0 1-10.2 1.3"
      />
      <path
        className="object-rotate-arrow"
        d="M6.6 19.4l-0.4-4.1 4.1 0.3"
      />
    </svg>
  );
}

function RotateSelectionReadout({ degrees }: { degrees: number }) {
  return (
    <span
      className="object-rotate-readout"
      data-rotate-readout="true"
      aria-label={`Rotation ${degrees} degrees`}
    >
      {degrees}
      <span aria-hidden="true">°</span>
    </span>
  );
}

function ProjectedPlaneTiltIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-tilt3d-icon="circular-arrow">
      <path
        className="object-tilt3d-loop"
        d="M4.2 12.4c0-4.1 4-7.2 9-7.2 4.7 0 8.4 2.8 8.6 6.7"
      />
      <path
        className="object-tilt3d-return"
        d="M4.7 14.1c1.4 2.9 4.7 4.7 8.7 4.7"
      />
      <path
        className="object-tilt3d-arrowhead"
        d="M11.2 10.6l7.2 5.5-7.2 5.5v-3.7H7.9v-3.6h3.3z"
      />
    </svg>
  );
}

function ProjectedPlaneTiltReadout({ label, limited }: { label: string; limited: boolean }) {
  return (
    <span
      className="object-tilt3d-readout"
      data-tilt3d-readout="true"
      data-tilt3d-limited={limited ? "true" : undefined}
      aria-label={limited ? `3D rotate limited ${label}` : `3D rotate ${label}`}
    >
      {label}
    </span>
  );
}

function NativeBondGrowthPreview({
  atom,
  candidateDirections,
  direction,
  object
}: {
  atom: MoleculeObject["atoms"][number];
  candidateDirections: ClientPoint[];
  direction: ClientPoint;
  object: MoleculeObject;
}) {
  const start = {
    x: atom.x - object.x,
    y: atom.y - object.y
  };
  const previewLength = 30;
  const headLength = 7;
  const headWidth = 4.5;
  const arrows = candidateDirections.length > 0 ? candidateDirections : [direction];

  return (
    <g className="native-bond-growth-preview" data-preview-atom-id={atom.id}>
      {arrows.map((candidateDirection, index) => {
        const selected = directionsNearlyEqual(candidateDirection, direction);
        const end = {
          x: start.x + candidateDirection.x * previewLength,
          y: start.y + candidateDirection.y * previewLength
        };
        const headBase = {
          x: end.x - candidateDirection.x * headLength,
          y: end.y - candidateDirection.y * headLength
        };
        const normal = {
          x: -candidateDirection.y,
          y: candidateDirection.x
        };
        const headPoints = [
          end,
          {
            x: headBase.x + normal.x * headWidth,
            y: headBase.y + normal.y * headWidth
          },
          {
            x: headBase.x - normal.x * headWidth,
            y: headBase.y - normal.y * headWidth
          }
        ].map((point) => `${point.x},${point.y}`).join(" ");
        const suffix = selected ? "selected" : "alternate";

        return (
          <g
            className={`native-bond-preview-option native-bond-preview-option-${suffix}`}
            data-preview-option={suffix}
            key={`${candidateDirection.x.toFixed(3)}-${candidateDirection.y.toFixed(3)}-${index}`}
          >
            <line
              className={`native-bond-preview-arrow native-bond-preview-arrow-${suffix}`}
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
            />
            <polygon
              className={`native-bond-preview-arrow-head native-bond-preview-arrow-head-${suffix}`}
              points={headPoints}
            />
          </g>
        );
      })}
      <circle
        className="native-atom-hover"
        cx={start.x}
        cy={start.y}
        r="8"
      />
    </g>
  );
}

function directionsNearlyEqual(left: ClientPoint, right: ClientPoint): boolean {
  return Math.hypot(left.x - right.x, left.y - right.y) < 0.01;
}

function NativeFreeformBondPreview({
  atom,
  newAtomPoint,
  object,
  targetAtom
}: {
  atom: MoleculeObject["atoms"][number];
  newAtomPoint: ClientPoint;
  object: MoleculeObject;
  targetAtom?: MoleculeObject["atoms"][number];
}) {
  const start = {
    x: atom.x - object.x,
    y: atom.y - object.y
  };
  const end = {
    x: newAtomPoint.x - object.x,
    y: newAtomPoint.y - object.y
  };

  return (
    <g className="native-freeform-bond-preview" data-freeform-preview-atom-id={atom.id}>
      <line
        className="native-bond-freeform-line"
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
      />
      <circle
        className="native-atom-hover"
        cx={start.x}
        cy={start.y}
        r="8"
      />
      <circle
        className="native-freeform-endpoint"
        cx={end.x}
        cy={end.y}
        r="3.5"
      />
      {targetAtom ? (
        <circle
          className="native-freeform-target-atom"
          cx={targetAtom.x - object.x}
          cy={targetAtom.y - object.y}
          r="9.5"
        />
      ) : null}
    </g>
  );
}

function resolveOpenResultDocument(result: ReturnType<typeof openNativeDocument>): ResolvedOpenDocument | undefined {
  if (result.document) {
    return { document: result.document, source: result.source };
  }
  if (!result.conflict) {
    return undefined;
  }

  if (result.conflict.visibleDocument) {
    const importVisible = window.confirm(
      "This file's visible CDXML was modified outside ChemDraft. Import the edited visible CDXML subset? Choose Cancel to restore the embedded ChemDraft document instead."
    );
    return importVisible
      ? {
          document: result.conflict.visibleDocument,
          source: "external-cdxml",
          statusSourceLabel: "edited visible CDXML subset"
        }
      : {
          document: result.conflict.embeddedDocument,
          source: "native-payload",
          statusSourceLabel: "embedded ChemDraft document"
        };
  }

  const restoreEmbedded = window.confirm(
    "This file's visible CDXML was modified outside ChemDraft, but ChemDraft could not import a visible subset. Restore the embedded ChemDraft document?"
  );
  return restoreEmbedded
    ? {
        document: result.conflict.embeddedDocument,
        source: "native-payload",
        statusSourceLabel: "embedded ChemDraft document"
      }
    : undefined;
}

function shouldEnableAgentBridge(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("agentBridge") === "1" ||
      params.get("chemdraftAgentBridge") === "1" ||
      window.localStorage.getItem("chemdraft.agentBridge") === "enabled";
  } catch {
    return false;
  }
}

function shouldEnableArtTransformQaLayer(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("artQa") === "0" || params.get("chemdraftArtQa") === "0") {
      return false;
    }
    return params.get("artQa") === "1" ||
      params.get("chemdraftArtQa") === "1" ||
      params.get("agentBridge") === "1" ||
      params.get("chemdraftAgentBridge") === "1" ||
      window.localStorage.getItem("chemdraft.artTransformQa") === "enabled";
  } catch {
    return false;
  }
}

function shouldEnableArtStyleQaLayer(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("artStyleQa") === "0" || params.get("chemdraftArtStyleQa") === "0") {
      return false;
    }
    return params.get("artStyleQa") === "1" ||
      params.get("chemdraftArtStyleQa") === "1" ||
      window.localStorage.getItem("chemdraft.artStyleQa") === "enabled";
  } catch {
    return false;
  }
}

function openBrowserUtilityWindow(windowKind: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("window", windowKind);
  url.hash = "";
  const opened = window.open(
    url.toString(),
    `chemdraft-${windowKind}`,
    "popup,width=960,height=720"
  );
  return opened !== null;
}

function agentBridgeDocumentPayloadFromHash(): { contents: string; displayName: string; path?: string } | undefined {
  if (typeof window === "undefined" || window.location.hash.length <= 1) {
    return undefined;
  }

  try {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const text = params.get("openDocumentText");
    if (text) {
      return {
        contents: text,
        displayName: params.get("displayName") ?? "Agent document",
        path: params.get("path") ?? undefined
      };
    }

    const encoded = params.get("openDocumentBase64");
    if (!encoded) {
      return undefined;
    }

    return {
      contents: window.atob(encoded),
      displayName: params.get("displayName") ?? "Agent document",
      path: params.get("path") ?? undefined
    };
  } catch {
    return undefined;
  }
}

function formatSaveStatus(filename: string, warnings: readonly { code: string; message: string }[]): string {
  return warnings.length > 0
    ? `Saved ${filename} with ${warnings.length} compatibility warning(s)`
    : `Saved ${filename}`;
}

function formatExportStatus(label: string, warningCount: number): string {
  return warningCount > 0
    ? `Exported ${label} with ${warningCount} warning(s)`
    : `Exported ${label}`;
}

async function createDialogExportResult(
  document: ChemDraftDocument,
  state: ExportDialogState
): Promise<ExportResult> {
  const descriptor = getExportFormatDescriptor(state.format);

  if (state.format === "svg") {
    const result = exportPhase4Svg(document, {
      includeWarnings: state.svg.includeWarnings,
      includePageGuides: state.svg.includePageGuides
    });
    return {
      format: descriptor.id,
      kind: "text",
      contents: result.contents,
      mimeType: descriptor.mimeType,
      extension: descriptor.extensions[0] ?? "svg",
      warnings: result.warnings
    };
  }

  if (state.format === "pdf") {
    return exportPhase4Pdf(document, {
      compress: state.pdf.compress,
      includePageGuides: state.pdf.includePageGuides
    });
  }

  if (state.format === "cdxml") {
    return exportPhase4Cdxml(document, {
      creationProgram: state.cdxml.creationProgram.trim() || "ChemDraft"
    });
  }

  const rasterFormat = rasterExportFormatForDialogFormat(state.format);
  if (rasterFormat) {
    if (!isDesktopRuntime()) {
      throw new Error(`${descriptor.menuLabel} export requires the ChemDraft desktop app.`);
    }
    const transparent = rasterFormat === "png" && state.raster.background === "transparent";
    // The SVG must omit its white page rect for a transparent request, otherwise resvg
    // paints it over the (intentionally unfilled) pixmap and the PNG comes out opaque white.
    const svgResult = exportPhase4Svg(document, {
      includeWarnings: true,
      background: transparent ? "transparent" : "#ffffff"
    });
    const rasterResult = await rasterizeSvgNative(svgResult.contents, rasterFormat, {
      scale: sanitizedDialogNumber(state.raster.scale, 1, 1, 4),
      background: transparent ? "transparent" : "#ffffff",
      jpegQuality: sanitizedDialogNumber(state.raster.jpegQuality, 90, 1, 100),
      maxDimensionPx: sanitizedDialogNumber(state.raster.maxDimensionPx, 8192, 1, 8192)
    });

    return {
      format: descriptor.id,
      kind: "binary",
      bytes: rasterResult.bytes,
      mimeType: descriptor.mimeType,
      extension: descriptor.extensions[0] ?? rasterFormat,
      warnings: [
        ...svgResult.warnings,
        ...rasterResult.warnings
      ]
    };
  }

  throw new Error(`${descriptor.menuLabel} export is not implemented.`);
}

function downloadExportResult(filename: string, result: ExportResult): void {
  if (result.kind === "text") {
    downloadText(filename, result.contents, result.mimeType);
    return;
  }

  downloadBlob(filename, new Blob([arrayBufferFromBytes(result.bytes)], { type: result.mimeType }));
}

async function writeNativeExportResult(path: string, result: ExportResult): Promise<void> {
  if (result.kind === "text") {
    await writeNativeTextFile(path, result.contents);
    return;
  }

  await writeNativeBinaryFile(path, result.bytes);
}

function sanitizedDialogNumber(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function formatOpenStatus(
  filename: string,
  source: ReturnType<typeof openNativeDocument>["source"],
  warnings: readonly { code: string; message: string }[],
  statusSourceLabel?: string
): string {
  const sourceLabel = statusSourceLabel ?? (
    source === "legacy-json"
      ? "legacy ChemDraft JSON"
      : source === "external-cdxml"
        ? "external CDXML subset"
        : "ChemDraft CDXML envelope"
  );
  return warnings.length > 0
    ? `Opened ${filename} as ${sourceLabel} with ${warnings.length} warning(s)`
    : `Opened ${filename} as ${sourceLabel}`;
}

function formatOpenFailure(warnings: readonly { code: string; message: string }[]): string {
  if (warnings.length === 0) {
    return "Open failed without a compatibility warning.";
  }
  return warnings.map((warning) => warning.message).join(" ");
}

async function pickNativeOpenPath(): Promise<string | undefined> {
  const { open } = await loadTauriDialogModule();
  const selected = await open({
    title: "Open ChemDraft or CDXML Document",
    multiple: false,
    fileAccessMode: "scoped"
  });
  return typeof selected === "string" ? selected : undefined;
}

async function pickNativeSavePath(defaultPath: string): Promise<string | undefined> {
  const { save } = await loadTauriDialogModule();
  const selected = await save({
    title: "Save ChemDraft Document",
    defaultPath,
    filters: [{ name: "ChemDraft", extensions: ["chemdraft"] }]
  });
  return selected ?? undefined;
}

async function pickNativeExportPath(
  defaultPath: string,
  formatLabel: string,
  extensions: readonly string[]
): Promise<string | undefined> {
  const { save } = await loadTauriDialogModule();
  const selected = await save({
    title: `Export ${formatLabel}`,
    defaultPath,
    filters: [{ name: formatLabel, extensions: [...extensions] }]
  });
  return selected ? ensureExportFileExtension(selected, extensions) : undefined;
}

async function pickNativeMoleculeTemplateOpenPath(): Promise<string | undefined> {
  const { open } = await loadTauriDialogModule();
  const selected = await open({
    title: "Import Drawn Structure Settings Template",
    multiple: false,
    fileAccessMode: "scoped",
    filters: [
      { name: "Drawn Structure Settings Templates", extensions: ["template", "cds"] },
      { name: "ChemDraw Style Sheets", extensions: ["cds"] },
      { name: "ChemDraft Templates", extensions: ["template"] }
    ]
  });
  return typeof selected === "string" ? selected : undefined;
}

async function pickNativeMoleculeTemplateSavePath(defaultPath: string): Promise<string | undefined> {
  const { save } = await loadTauriDialogModule();
  const selected = await save({
    title: "Export Drawn Structure Settings Template",
    defaultPath,
    filters: [{ name: "Drawn Structure Settings Template", extensions: ["template"] }]
  });
  return selected ? ensureExportFileExtension(selected, ["template"]) : undefined;
}

type TauriDialogModule = typeof import("@tauri-apps/plugin-dialog");
let tauriDialogModulePromise: Promise<TauriDialogModule> | undefined;

function loadTauriDialogModule(): Promise<TauriDialogModule> {
  tauriDialogModulePromise ??= import("@tauri-apps/plugin-dialog");
  return tauriDialogModulePromise;
}

function prewarmNativeDialogModule(): void {
  if (!isDesktopRuntime()) {
    return;
  }

  void loadTauriDialogModule().catch(() => {
    tauriDialogModulePromise = undefined;
  });
}

async function readNativeTextFile(path: string): Promise<string> {
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  return readTextFile(path);
}

async function readNativeBinaryFile(path: string): Promise<Uint8Array> {
  const { readFile } = await import("@tauri-apps/plugin-fs");
  return readFile(path);
}

async function takePendingNativeOpenDocument(): Promise<NativeOpenDocumentPayload | undefined> {
  const { invoke } = await import("@tauri-apps/api/core");
  const payload = await invoke<NativeOpenDocumentPayload | null>("take_pending_open_document");
  return payload ?? undefined;
}

async function listenForNativeOpenDocuments(
  handler: (payload: NativeOpenDocumentPayload) => void
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<NativeOpenDocumentPayload>(nativeOpenDocumentEvent, (event) => {
    if (isNativeOpenDocumentPayload(event.payload)) {
      handler(event.payload);
    }
  });
}

function isNativeOpenDocumentPayload(value: unknown): value is NativeOpenDocumentPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as NativeOpenDocumentPayload).path === "string" &&
    typeof (value as NativeOpenDocumentPayload).displayName === "string" &&
    typeof (value as NativeOpenDocumentPayload).contents === "string"
  );
}

async function writeNativeTextFile(path: string, contents: string): Promise<void> {
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(path, contents);
}

async function writeNativeBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, bytes);
}

function ensureChemDraftFileExtension(path: string): string {
  return /\.(chemdraft|cdxml)$/i.test(path) ? path : `${path}.chemdraft`;
}

function ensureExportFileExtension(path: string, extensions: readonly string[]): string {
  if (extensions.length === 0) {
    return path;
  }
  const escapedExtensions = extensions.map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const extensionPattern = new RegExp(`\\.(${escapedExtensions.join("|")})$`, "i");
  return extensionPattern.test(path) ? path : `${path}.${extensions[0]}`;
}

export function nativePathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function nativePathDirname(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return undefined;
  }
  return normalized.slice(0, separatorIndex);
}

export function nativePathJoin(directory: string | undefined, filename: string): string | undefined {
  if (!directory) {
    return undefined;
  }
  return `${directory.replace(/[\\/]+$/, "")}/${filename}`;
}

export function nativePathWithBasename(path: string | undefined, filename: string): string | undefined {
  return nativePathJoin(path ? nativePathDirname(path) : undefined, filename);
}

function downloadText(filename: string, contents: string, mimeType: string): void {
  downloadBlob(filename, new Blob([contents], { type: mimeType }));
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function createExportFilename(document: ChemDraftDocument, extension: string): string {
  const baseName = document.title.replace(/\.chemdraft$/i, "").trim().replace(/[^a-z0-9._-]+/gi, "-") || "Untitled";
  return `${baseName}.${extension}`;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * The status line for a completed run.
 *
 * Counts what declined rather than only what succeeded: "46 properties" beside a silent decline reads
 * as a complete answer, which is the impression PLANS.md §10 spends a paragraph warning against.
 */
function formatAnalysisRunStatus(run: AnalysisRun): string {
  const computed = run.results.filter((result) => result.status === "ok").length;
  // Two different words for two different things: "declined" is a capability gap (Crippen has no
  // sodium parameters), "not applicable" is a method whose claim does not fit this structure (a
  // molecule with no nitrogen cannot lose ammonia). Collapsing them makes an ordinary analysis read
  // as though something went wrong.
  const declined = run.results.filter((result) => result.status === "unsupported").length;
  const inapplicable = run.results.filter((result) => result.status === "not-applicable").length;
  if (computed === 0) {
    return run.warnings[0]?.message ?? "Analysis produced no results";
  }
  const parts = [`${computed} propert${computed === 1 ? "y" : "ies"}`];
  if (declined > 0) parts.push(`${declined} declined`);
  if (inapplicable > 0) parts.push(`${inapplicable} not applicable`);
  return `Analyzed: ${parts.join(", ")}`;
}

function formatAnalysisStatus(analysis: StructureAnalysisResult): string {
  const formula = analysis.properties.formula ?? "formula unavailable";
  const mass = analysis.properties.averageMass ? `, avg mass ${analysis.properties.averageMass.toFixed(3)}` : "";
  const warningText = analysis.validation.warnings.length > 0 ? ` with ${analysis.validation.warnings.length} warning(s)` : "";
  return `Validated ${formula}${mass}${warningText}`;
}

function findDocumentObject(document: ChemDraftDocument, objectId: string): DocumentObject | undefined {
  for (const page of document.pages) {
    const object = page.objects.find((candidate) => candidate.id === objectId);
    if (object) {
      return object;
    }
  }

  return undefined;
}

function agentObjectSummary(object: DocumentObject): AgentSnapshot["objects"][number] {
  return {
    id: object.id,
    type: object.type,
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    atomCount: object.type === "molecule" ? object.atoms.length : undefined,
    bondCount: object.type === "molecule" ? object.bonds.length : undefined
  };
}

function resolveAgentPointInDocument(
  target: AgentPointTarget,
  document: ChemDraftDocument,
  pageRect: Pick<DOMRect, "left" | "top">,
  scale: number
): AgentResolvedPoint {
  if ("page" in target) {
    return {
      page: target.page,
      client: pageToClient(target.page, { pageRect, scale }),
      target,
      source: "page"
    };
  }

  if ("client" in target) {
    return {
      page: clientToPage(target.client, { pageRect, scale }),
      client: target.client,
      target,
      source: "client"
    };
  }

  if ("objectId" in target) {
    const object = findDocumentObject(document, target.objectId);
    if (!object) {
      throw new Error(`Agent bridge could not resolve object "${target.objectId}".`);
    }
    const pagePoint = agentObjectAnchorPoint(object, target.anchor ?? "center");
    return {
      page: pagePoint,
      client: pageToClient(pagePoint, { pageRect, scale }),
      target,
      source: "object"
    };
  }

  if ("atom" in target) {
    const object = findDocumentObject(document, target.atom.objectId);
    if (object?.type !== "molecule") {
      throw new Error(`Agent bridge could not resolve molecule "${target.atom.objectId}".`);
    }
    const atom = object.atoms.find((candidate) => candidate.id === target.atom.atomId);
    if (!atom) {
      throw new Error(`Agent bridge could not resolve atom "${target.atom.atomId}".`);
    }
    const pagePoint = { x: atom.x, y: atom.y };
    return {
      page: pagePoint,
      client: pageToClient(pagePoint, { pageRect, scale }),
      target,
      source: "atom"
    };
  }

  const object = findDocumentObject(document, target.bond.objectId);
  if (object?.type !== "molecule") {
    throw new Error(`Agent bridge could not resolve molecule "${target.bond.objectId}".`);
  }
  const bond = object.bonds.find((candidate) => candidate.id === target.bond.bondId);
  if (!bond) {
    throw new Error(`Agent bridge could not resolve bond "${target.bond.bondId}".`);
  }
  const fromAtom = object.atoms.find((candidate) => candidate.id === bond.fromAtomId);
  const toAtom = object.atoms.find((candidate) => candidate.id === bond.toAtomId);
  if (!fromAtom || !toAtom) {
    throw new Error(`Agent bridge could not resolve atoms for bond "${target.bond.bondId}".`);
  }
  const pagePoint = target.bond.anchor === "from"
    ? { x: fromAtom.x, y: fromAtom.y }
    : target.bond.anchor === "to"
      ? { x: toAtom.x, y: toAtom.y }
      : { x: (fromAtom.x + toAtom.x) / 2, y: (fromAtom.y + toAtom.y) / 2 };
  return {
    page: pagePoint,
    client: pageToClient(pagePoint, { pageRect, scale }),
    target,
    source: "bond"
  };
}

function agentObjectAnchorPoint(object: DocumentObject, anchor: AgentObjectAnchor): AgentPoint {
  if (anchor === "topLeft") {
    return { x: object.x, y: object.y };
  }
  if (anchor === "topRight") {
    return { x: object.x + object.width, y: object.y };
  }
  if (anchor === "bottomLeft") {
    return { x: object.x, y: object.y + object.height };
  }
  if (anchor === "bottomRight") {
    return { x: object.x + object.width, y: object.y + object.height };
  }

  return {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2
  };
}

function moleculeDrawingPrimitive(object: MoleculeObject): "single-bond" | undefined {
  return object.style.drawingPrimitive === "single-bond" && object.atoms.length === 2 ? "single-bond" : undefined;
}

function chargeValueForToolCommand(commandId: string): NativeChargeValue | undefined {
  if (commandId === "tool.plus") {
    return 1;
  }

  if (commandId === "tool.minus") {
    return -1;
  }

  return undefined;
}

function moleculeAriaLabel(object: MoleculeObject): string {
  if (object.chemistry?.formula) {
    return `Molecule ${object.chemistry.formula}`;
  }

  if (object.structure.length <= 40 && !object.structure.includes("\n")) {
    return `Molecule ${object.structure}`;
  }

  return `Molecule ${object.structureFormat}`;
}

function isNativeMoleculeGraph(object: MoleculeObject): boolean {
  return object.atoms.length > 0;
}

function formatValidationFailure(analysis: StructureAnalysisResult): string {
  const firstError = analysis.validation.errors[0] ?? analysis.validation.warnings[0];
  return firstError ? `Validation unavailable: ${firstError.message}` : "Validation unavailable";
}
