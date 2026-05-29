import { MainWindow } from "./MainWindow";
import { PaletteWindow } from "./PaletteWindow";

export function App() {
  if (isPaletteRoute()) {
    return <PaletteWindow />;
  }

  return <MainWindow />;
}

function isPaletteRoute(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return new URLSearchParams(window.location.search).get("window") === "tool-palette";
}
