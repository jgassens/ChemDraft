import type { DialogCoordinator } from "../dialogs/DialogCoordinator";

export const aboutCommand = {
  id: "help.about", title: "About ChemDraft", icon: "open", source: "core", category: "app"
} as const;

export async function openAbout(coordinator: Pick<DialogCoordinator, "openAbout"> | undefined, buildStamp: string, desktop: boolean): Promise<void> {
  if (!desktop) {
    const url = new URL(window.location.href);
    url.search = new URLSearchParams({ window: "about", buildStamp }).toString();
    window.open(url, "_blank", "noopener,noreferrer,popup,width=660,height=620");
    return;
  }
  if (!coordinator) throw new Error("The native dialog host is starting. Try again in a moment.");
  const { getVersion } = await import("@tauri-apps/api/app");
  await coordinator.openAbout(await getVersion(), buildStamp);
}
