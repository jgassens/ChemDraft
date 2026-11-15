// Capture the first tab's real id, keeping it even after that tab closes. The tab-list element is
// stable through tab switches and replaced on remount, so tests never alias a closed tab to another.
const initialTabs = new WeakMap<Element, string>();

export function initialDocumentTabId(): string {
  const list = document.querySelector(".document-tab-list");
  if (!list) throw new Error("Mount a document window before reading its first tab id.");
  let id = initialTabs.get(list);
  if (!id) {
    id = list.querySelector<HTMLElement>("[data-tab-id]")?.dataset.tabId;
    if (!id) throw new Error("The document window has no tab id.");
    initialTabs.set(list, id);
  }
  return id;
}
