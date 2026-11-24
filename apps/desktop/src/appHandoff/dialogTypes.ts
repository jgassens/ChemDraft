interface AppHandoffDialogHeader {
  title: string;
  appName: string;
}

export type AppHandoffDialogSnapshot = AppHandoffDialogHeader & (
  | {
    mode: "confirm";
    pipeline: string;
    composition?: { formula: string; atomCount: number };
    suggestedCombination: string;
    combinations: Record<string, Record<string, string>>;
  }
  | {
    mode: "result";
    combination: string;
    rebuildCombination: string;
    rebuildLabel: string;
    rebuildChanges: Record<string, string | null>;
    twist?: number;
  }
);

export type AppHandoffDialogAction =
  | { action: "confirm"; combinationId: string }
  | { action: "rebuild" }
  | { action: "cancel" };
