import { createStore } from "../../lib/store";
import { addFiles, normalizeItems, type ShelfItem } from "./model";
import { probeFiles } from "../../platform/services";

export const shelf = createStore<ShelfItem[]>([], { persist: "shelf" });
shelf.set(normalizeItems);

/** Puts files at the front of the Shelf (also used by Capture for new screenshots). */
export function addToShelf(paths: string[]) {
  void probeFiles(paths).then(({ files }: { files: any }) => shelf.set((list) => addFiles(list, files, Date.now())));
}
